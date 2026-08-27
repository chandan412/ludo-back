const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');

// ============================================================================
// ✅ ADMIN-CONFIGURABLE AMOUNT LIMITS
//
// Three numbers that were hard-coded in three different files:
//
//   ₹10  minimum deposit          routes/wallet.js  /recharge-request
//   ₹10  minimum bet              routes/game.js    /create
//   ₹100 minimum withdrawal       routes/wallet.js  /withdraw-request
//
// Changing any of them meant a code edit and a redeploy. They are now settings,
// read at request time.
//
// ── THE TIERED WITHDRAWAL MINIMUM ───────────────────────────────────────────
//
// The interesting one. A flat minimum has to serve two opposite jobs at once:
//
//   • Low enough that a NEW player can cash out and see the platform pays.
//     That first withdrawal is the single moment that decides whether they
//     believe the money is real. Setting the bar high there costs you players.
//   • High enough that you are not hand-processing ₹100 payouts all day from
//     the same handful of regulars. Every withdrawal is manual work for you.
//
// One number cannot do both. So the minimum now RISES once a player has been
// paid out a set number of times:
//
//     withdrawals 1..N     →  base minimum   (e.g. ₹100)
//     withdrawal  N+1..    →  raised minimum (e.g. ₹200)
//
// New players get the low bar and the trust it buys. Established players, who
// already know the money is real, batch their withdrawals into fewer, larger
// payouts. Your admin workload falls without ever having blocked anyone's
// first cash-out.
//
// WHAT COUNTS TOWARD THE TIER
// Only withdrawals that were actually PAID — status 'approved' or 'completed'.
// Rejected and cancelled requests are deliberately excluded: a player whose
// request you refused, or who cancelled their own, has not been paid, and
// pushing them into the higher tier for it would punish them for your decision
// or for correcting their own typo.
// ============================================================================

const settingSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: String,
});
const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema);

const KEYS = {
  minDeposit:      'min_deposit_amount',
  minBet:          'min_bet_amount',
  minWithdraw:     'min_withdraw_amount',
  withdrawTierAfter: 'withdraw_tier_after_count',
  minWithdrawTier: 'min_withdraw_amount_tier',
};

const DEFAULTS = {
  // Current live behaviour, so deploying this changes nothing until you edit it.
  minDeposit:        parseInt(process.env.MIN_DEPOSIT || 10, 10),
  minBet:            parseInt(process.env.MIN_BET || 10, 10),
  minWithdraw:       parseInt(process.env.MIN_WITHDRAW || 100, 10),
  // 0 = tiering OFF; the base minimum applies to everyone forever.
  withdrawTierAfter: parseInt(process.env.WITHDRAW_TIER_AFTER || 0, 10),
  minWithdrawTier:   parseInt(process.env.MIN_WITHDRAW_TIER || 200, 10),
};

let cache = null;
let cacheAt = 0;
const CACHE_MS = 60 * 1000;

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function getAmountLimits(force = false) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  try {
    const rows = await Setting.find({ key: { $in: Object.values(KEYS) } }).lean();
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    cache = {
      minDeposit:        Math.max(1, toInt(map[KEYS.minDeposit],  DEFAULTS.minDeposit)),
      minBet:            Math.max(1, toInt(map[KEYS.minBet],      DEFAULTS.minBet)),
      minWithdraw:       Math.max(1, toInt(map[KEYS.minWithdraw], DEFAULTS.minWithdraw)),
      withdrawTierAfter: Math.max(0, toInt(map[KEYS.withdrawTierAfter], DEFAULTS.withdrawTierAfter)),
      minWithdrawTier:   Math.max(1, toInt(map[KEYS.minWithdrawTier],   DEFAULTS.minWithdrawTier)),
    };
    cacheAt = Date.now();
  } catch (e) {
    console.error('amount limits read error (using defaults):', e.message);
    // Fall back to the values that were hard-coded before. A database blip must
    // not silently drop every minimum to zero.
    cache = { ...DEFAULTS };
    cacheAt = Date.now();
  }
  return cache;
}

async function saveAmountLimits(patch) {
  const write = async (key, val, floor) => {
    if (val === undefined) return;
    const n = Math.max(floor, toInt(val, floor));
    await Setting.findOneAndUpdate({ key }, { key, value: String(n) }, { upsert: true, new: true });
  };

  await write(KEYS.minDeposit,        patch.minDeposit,        1);
  await write(KEYS.minBet,            patch.minBet,            1);
  await write(KEYS.minWithdraw,       patch.minWithdraw,       1);
  await write(KEYS.withdrawTierAfter, patch.withdrawTierAfter, 0);  // 0 = off
  await write(KEYS.minWithdrawTier,   patch.minWithdrawTier,   1);

  cache = null;
  return getAmountLimits(true);
}

// ============================================================================
// How many times this player has actually BEEN PAID a withdrawal.
//
// Uses the { user, createdAt } index already on Transaction. countDocuments
// rather than fetching rows — we only need the number.
// ============================================================================
async function paidWithdrawalCount(userId) {
  return Transaction.countDocuments({
    user: userId,
    type: 'withdraw',
    status: { $in: ['approved', 'completed'] },
  });
}

// ============================================================================
// Resolve the minimum withdrawal that applies to THIS player right now.
//
// Returns { min, tierApplied, paidCount, base, tierAfter, tierMin } so the
// caller can write an error message that explains WHY the number is what it is.
// "Minimum is ₹200" with no reason reads as a bug to a player who withdrew ₹100
// last week.
// ============================================================================
async function resolveWithdrawMinimum(userId) {
  const limits = await getAmountLimits();

  const base = limits.minWithdraw;
  const tierAfter = limits.withdrawTierAfter;
  const tierMin = limits.minWithdrawTier;

  // Tiering off, or the raised bar isn't actually higher — nothing to do.
  if (tierAfter <= 0 || tierMin <= base) {
    return { min: base, tierApplied: false, paidCount: 0, base, tierAfter, tierMin };
  }

  let paidCount = 0;
  try {
    paidCount = await paidWithdrawalCount(userId);
  } catch (e) {
    // If the count fails, fall back to the BASE minimum rather than the raised
    // one. Erring low lets an honest player through; erring high would block a
    // legitimate withdrawal because of an unrelated database hiccup, which is
    // the version that generates angry messages.
    console.error('paidWithdrawalCount failed (using base minimum):', e.message);
    return { min: base, tierApplied: false, paidCount: 0, base, tierAfter, tierMin };
  }

  const tierApplied = paidCount >= tierAfter;
  return {
    min: tierApplied ? tierMin : base,
    tierApplied,
    paidCount,
    base,
    tierAfter,
    tierMin,
  };
}

module.exports = {
  getAmountLimits,
  saveAmountLimits,
  resolveWithdrawMinimum,
  paidWithdrawalCount,
  DEFAULTS,
};
