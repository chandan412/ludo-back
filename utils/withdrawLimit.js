const mongoose = require('mongoose');
const User = require('../models/User');

// ============================================================================
// ✅ WITHDRAWAL REQUEST RATE LIMIT
//
// Limits each player to N withdrawal requests per rolling window (default: 2
// per 6 hours). The existing "one pending request at a time" guard already
// stopped a player stacking requests, but it did nothing about churn: submit,
// get processed, submit again, repeatedly. Each cycle is manual admin work, and
// a handful of players doing it constantly is what actually eats your day.
//
// WHY A COUNTER ON THE USER, NOT A COUNT OF TRANSACTIONS
// ------------------------------------------------------
// The obvious implementation is:
//
//     const recent = await Transaction.countDocuments({
//       user, type: 'withdraw', createdAt: { $gte: sixHoursAgo }
//     });
//     if (recent >= 2) return reject;
//     await Transaction.create(...)
//
// That reads, decides, and then writes as three separate operations, so two
// requests arriving together BOTH see a count of 1 and BOTH proceed. On a
// withdrawal path that also locks balance, a double-pass is not a cosmetic bug.
// It is also an unindexed range scan on every single request.
//
// Instead the limit is claimed ATOMICALLY:
//
//     findOneAndUpdate(
//       { _id: userId, withdrawWindowCount: { $lt: max } },   // ← the check
//       { $inc: { withdrawWindowCount: 1 } }                  // ← the claim
//     )
//
// MongoDB evaluates the filter and applies the update as one indivisible
// operation on a single document. Two concurrent requests cannot both match
// when only one slot is left — the second finds the counter already
// incremented and matches nothing. The check and the claim cannot drift apart
// because they are the same operation.
//
// WINDOW BEHAVIOUR
// ----------------
// The window is FIXED, anchored to the player's first request, not sliding.
// It starts when they make a request with no active window, and everything
// resets once it expires. A sliding window would need per-request timestamps
// and gives players a vaguer answer than "you can try again at 3:40 PM".
//
// The known trade-off of a fixed window: a player who uses both slots at the
// very end of one window can use two more immediately as the next one opens —
// up to 4 requests in a short span, once. That is deliberate. Closing it costs
// per-request timestamp storage and makes the reset time impossible to state
// plainly, and 4-in-a-burst is not the behaviour causing you problems.
// ============================================================================

const settingSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: String,
});
const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema);

const KEYS = {
  maxRequests: 'withdraw_max_requests',
  windowHours: 'withdraw_window_hours',
};

const DEFAULTS = {
  maxRequests: parseInt(process.env.WITHDRAW_MAX_REQUESTS || 2, 10),
  windowHours: parseInt(process.env.WITHDRAW_WINDOW_HOURS || 6, 10),
};

let cache = null;
let cacheAt = 0;
const CACHE_MS = 60 * 1000;

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function getWithdrawLimits(force = false) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  try {
    const rows = await Setting.find({ key: { $in: Object.values(KEYS) } }).lean();
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    cache = {
      maxRequests: Math.max(0, toInt(map[KEYS.maxRequests], DEFAULTS.maxRequests)),
      windowHours: Math.max(1, toInt(map[KEYS.windowHours], DEFAULTS.windowHours)),
    };
    cacheAt = Date.now();
  } catch (e) {
    console.error('withdraw limit settings read error (using defaults):', e.message);
    cache = { ...DEFAULTS };
    cacheAt = Date.now();
  }
  return cache;
}

async function saveWithdrawLimits(patch) {
  const ops = [];
  if (patch.maxRequests !== undefined)
    ops.push({ key: KEYS.maxRequests, value: String(Math.max(0, toInt(patch.maxRequests, DEFAULTS.maxRequests))) });
  if (patch.windowHours !== undefined)
    ops.push({ key: KEYS.windowHours, value: String(Math.max(1, toInt(patch.windowHours, DEFAULTS.windowHours))) });

  for (const op of ops) {
    await Setting.findOneAndUpdate({ key: op.key }, op, { upsert: true, new: true });
  }
  cache = null;
  return getWithdrawLimits(true);
}

function formatReset(date) {
  // Rendered in IST because that is where the players are, and a UTC timestamp
  // in an error message is a support ticket waiting to happen.
  try {
    return new Date(date).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', hour12: true,
      day: '2-digit', month: 'short',
    });
  } catch {
    return new Date(date).toISOString();
  }
}

// ============================================================================
// Claim one withdrawal slot.
//
// Returns { allowed: true, used, max, resetAt } on success, or
//         { allowed: false, used, max, resetAt, message } when rate limited.
//
// IMPORTANT: a successful claim CONSUMES a slot. If the caller then fails to
// create the request, it must call releaseWithdrawSlot() to give it back —
// otherwise a server error would silently cost the player one of their two
// attempts, which is the sort of thing that generates angry messages you can't
// reproduce.
// ============================================================================
async function claimWithdrawSlot(userId) {
  const limits = await getWithdrawLimits();

  // 0 = feature off. Chosen over "0 means block everything" because an admin
  // clearing the field should not accidentally freeze every withdrawal on the
  // platform — the failure mode of a mistyped setting must be permissive here,
  // since blocking all withdrawals looks exactly like theft to players.
  if (limits.maxRequests <= 0) {
    return { allowed: true, unlimited: true, used: 0, max: 0, resetAt: null };
  }

  const now = new Date();
  const windowMs = limits.windowHours * 60 * 60 * 1000;
  const cutoff = new Date(now.getTime() - windowMs);

  // Step 1 — open a fresh window if there is no live one. Conditional, so a
  // request inside an ACTIVE window matches nothing and leaves the counter
  // alone. This is what stops a player resetting their own limit by simply
  // trying again.
  await User.updateOne(
    {
      _id: userId,
      $or: [
        { withdrawWindowStart: { $exists: false } },
        { withdrawWindowStart: null },
        { withdrawWindowStart: { $lt: cutoff } },
      ],
    },
    { $set: { withdrawWindowStart: now, withdrawWindowCount: 0 } }
  );

  // Step 2 — the atomic claim. Filter and increment in one operation.
  const claimed = await User.findOneAndUpdate(
    { _id: userId, withdrawWindowCount: { $lt: limits.maxRequests } },
    { $inc: { withdrawWindowCount: 1 } },
    { new: true }
  ).select('withdrawWindowStart withdrawWindowCount');

  if (claimed) {
    const resetAt = new Date(new Date(claimed.withdrawWindowStart).getTime() + windowMs);
    return {
      allowed: true,
      used: claimed.withdrawWindowCount,
      max: limits.maxRequests,
      windowHours: limits.windowHours,
      resetAt,
    };
  }

  // Blocked. Re-read purely to tell the player exactly when they can retry.
  const u = await User.findById(userId).select('withdrawWindowStart withdrawWindowCount').lean();
  const start = u?.withdrawWindowStart ? new Date(u.withdrawWindowStart) : now;
  const resetAt = new Date(start.getTime() + windowMs);

  return {
    allowed: false,
    used: u?.withdrawWindowCount || limits.maxRequests,
    max: limits.maxRequests,
    windowHours: limits.windowHours,
    resetAt,
    message:
      `You can make ${limits.maxRequests} withdrawal request${limits.maxRequests === 1 ? '' : 's'} ` +
      `every ${limits.windowHours} hours. You've used ${limits.maxRequests === 1 ? 'yours' : 'both'} — ` +
      `you can request again after ${formatReset(resetAt)}.`,
  };
}

// Give back a slot consumed by a claim whose request then failed to be created.
// Guarded with $gt: 0 so a double release can never drive the counter negative
// and hand out a free extra attempt.
async function releaseWithdrawSlot(userId) {
  try {
    await User.updateOne(
      { _id: userId, withdrawWindowCount: { $gt: 0 } },
      { $inc: { withdrawWindowCount: -1 } }
    );
  } catch (e) {
    console.error('releaseWithdrawSlot failed (non-fatal):', e.message);
  }
}

// Read-only view for showing the player their remaining attempts without
// consuming one.
async function peekWithdrawSlots(userId) {
  const limits = await getWithdrawLimits();
  if (limits.maxRequests <= 0) {
    return { unlimited: true, used: 0, remaining: null, max: 0, windowHours: limits.windowHours, resetAt: null };
  }

  const u = await User.findById(userId).select('withdrawWindowStart withdrawWindowCount').lean();
  const windowMs = limits.windowHours * 60 * 60 * 1000;
  const start = u?.withdrawWindowStart ? new Date(u.withdrawWindowStart) : null;
  const expired = !start || Date.now() - start.getTime() >= windowMs;

  const used = expired ? 0 : (u?.withdrawWindowCount || 0);
  return {
    unlimited: false,
    used,
    remaining: Math.max(0, limits.maxRequests - used),
    max: limits.maxRequests,
    windowHours: limits.windowHours,
    resetAt: expired || !start ? null : new Date(start.getTime() + windowMs),
  };
}

module.exports = {
  getWithdrawLimits,
  saveWithdrawLimits,
  claimWithdrawSlot,
  releaseWithdrawSlot,
  peekWithdrawSlots,
  DEFAULTS,
};
