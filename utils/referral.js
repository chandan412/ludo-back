const mongoose = require('mongoose');

const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const Referral    = require('../models/Referral');

// ============================================================================
// ✅ REFERRAL ENGINE
//
// THE PROBLEM THIS REPLACES
// -------------------------
// The old rule was: someone signs up with your code → you are paid ₹50 that
// instant. The cost of manufacturing a referral was therefore the cost of
// filling in a signup form, and the reward was unbounded. The predictable
// result was thousands of accounts that never played a single game, each one
// occupying an index slot, a row in every admin query, and a phone-verification
// call, permanently.
//
// THE NEW RULE
// ------------
//   1. The reward is paid only after the REFERRED player actually plays — a
//      number of real games the admin sets.
//   2. Each referrer can be paid only a limited number of times, also set by
//      the admin. Beyond that the code still works and friends can still join;
//      there is simply no further payout.
//
// Together these cap the total value extractable per account at a known number
// and make each unit of that value cost real gameplay to obtain. Fake accounts
// stop paying for themselves.
//
// WHAT COUNTS AS A REAL GAME
// --------------------------
// Counting raw `gamesPlayed` would defeat the whole exercise: two fake accounts
// would create a room, one would instantly forfeit, and three seconds later the
// referral would qualify. A game only advances a referral if ALL of these hold:
//
//   • the game FINISHED (aborted and cancelled games are refunds, not games)
//   • it had two distinct human players
//   • it ran for a minimum number of moves AND a minimum wall-clock duration
//   • the opponent is not the referrer themselves
//   • the opponent was not referred by the same referrer (no sibling farming)
//   • the opponent is not banned
//   • the opponent has not already counted toward this same referral
//     (so N qualifying games means N DIFFERENT opponents)
//   • the game has not already been counted (settlement can run twice)
//
// The distinct-opponent rule is the important one. Every other check can be
// satisfied by two patient fraudsters playing slow, complete games against each
// other. Requiring a new opponent each time forces them to recruit a new real
// account per unit of progress, which is the cost we were trying to impose.
// ============================================================================

// ── Setting model ────────────────────────────────────────────────────────────
// Same guarded definition as routes/settings.js. The guard matters because
// whichever module Node loads FIRST creates the model and the other must reuse
// it; a bare mongoose.model() call in the second one throws OverwriteModelError
// and takes the whole boot down.
const settingSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: String,
});
const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema);

// ── Admin-configurable values ────────────────────────────────────────────────
const KEYS = {
  enabled:       'referral_enabled',
  rewardAmount:  'referral_reward_amount',
  requiredGames: 'referral_required_games',
  maxRewards:    'referral_max_rewards',
};

const DEFAULTS = {
  enabled:       true,
  // Seeded from the old REFERRAL_BONUS env var so behaviour is unchanged on the
  // first boot after deploy, before the admin has touched anything.
  rewardAmount:  parseInt(process.env.REFERRAL_BONUS || 50, 10),
  requiredGames: parseInt(process.env.REFERRAL_REQUIRED_GAMES || 3, 10),
  maxRewards:    parseInt(process.env.REFERRAL_MAX_REWARDS || 5, 10),
};

// ── Fixed anti-abuse thresholds ──────────────────────────────────────────────
// Deliberately NOT in the admin panel. They are guard rails, not business
// levers, and every extra dial is another thing that can be set to zero by
// accident and quietly disable the protection. Override via env if ever needed.
const MIN_MOVES        = parseInt(process.env.REFERRAL_MIN_MOVES || 6, 10);
const MIN_DURATION_SEC = parseInt(process.env.REFERRAL_MIN_DURATION_SEC || 60, 10);
const DISTINCT_OPPONENTS = String(process.env.REFERRAL_DISTINCT_OPPONENTS || 'true') !== 'false';

// moveHistory is capped at 50 entries per game, but we only ever need to know
// whether it reached MIN_MOVES. Slicing in the projection means the payload
// stays tiny no matter how long the match ran — consistent with the existing
// rule of keeping moveHistory out of hot reads.
const MOVE_SLICE = Math.max(MIN_MOVES, 8);

// ── Settings cache ───────────────────────────────────────────────────────────
// Every settled game would otherwise mean four extra reads for values that
// change roughly never. Cached for 60s; the admin save path clears it, so the
// panel still feels instant.
let cache = null;
let cacheAt = 0;
const CACHE_MS = 60 * 1000;

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function getReferralSettings(force = false) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;

  try {
    const rows = await Setting.find({ key: { $in: Object.values(KEYS) } }).lean();
    const map = {};
    for (const r of rows) map[r.key] = r.value;

    cache = {
      enabled:       map[KEYS.enabled] === undefined ? DEFAULTS.enabled : map[KEYS.enabled] === 'true',
      rewardAmount:  Math.max(0, toInt(map[KEYS.rewardAmount],  DEFAULTS.rewardAmount)),
      requiredGames: Math.max(0, toInt(map[KEYS.requiredGames], DEFAULTS.requiredGames)),
      maxRewards:    Math.max(0, toInt(map[KEYS.maxRewards],    DEFAULTS.maxRewards)),
    };
    cacheAt = Date.now();
  } catch (e) {
    console.error('referral settings read error (using defaults):', e.message);
    // Never let a transient database blip crash a game settlement. Falling back
    // to defaults keeps play working; the worst case is one payout evaluated
    // against default numbers.
    cache = { ...DEFAULTS };
    cacheAt = Date.now();
  }
  return cache;
}

async function saveReferralSettings(patch) {
  const ops = [];
  if (patch.enabled !== undefined)
    ops.push({ key: KEYS.enabled, value: String(Boolean(patch.enabled)) });
  if (patch.rewardAmount !== undefined)
    ops.push({ key: KEYS.rewardAmount, value: String(Math.max(0, toInt(patch.rewardAmount, DEFAULTS.rewardAmount))) });
  if (patch.requiredGames !== undefined)
    ops.push({ key: KEYS.requiredGames, value: String(Math.max(0, toInt(patch.requiredGames, DEFAULTS.requiredGames))) });
  if (patch.maxRewards !== undefined)
    ops.push({ key: KEYS.maxRewards, value: String(Math.max(0, toInt(patch.maxRewards, DEFAULTS.maxRewards))) });

  for (const op of ops) {
    await Setting.findOneAndUpdate({ key: op.key }, op, { upsert: true, new: true });
  }

  cache = null; // force a fresh read so the panel reflects reality immediately
  return getReferralSettings(true);
}

// ============================================================================
// PAYOUT
//
// Three atomic steps, in an order chosen so that no failure can pay twice:
//
//   1. CLAIM  — flip this referral pending → processing. Only one caller wins
//               this flip, so only one caller can ever reach step 2.
//   2. CREDIT — increment the referrer's reward counter and balance in a SINGLE
//               findOneAndUpdate whose FILTER contains the cap check. The cap
//               is therefore evaluated and consumed in the same operation; two
//               simultaneous payouts cannot both see "4 of 5 used" and both
//               proceed. If the filter fails to match, the referrer is at cap
//               (or banned) and no money moved.
//   3. FINALISE — stamp the ledger row and write the Transaction.
//
// The reward is credited as BONUS: it lands in `balance` (so it is playable)
// and is simultaneously tracked in `bonusBalance` (so withdrawals exclude it),
// exactly as the previous instant-referral credit did. This is what stops the
// reward being converted straight to cash and is preserved deliberately.
// ============================================================================
async function payReferral(referralId, settings) {
  const claimed = await Referral.findOneAndUpdate(
    { _id: referralId, status: 'pending' },
    { $set: { status: 'processing', qualifiedAt: new Date() } },
    { new: true }
  );
  if (!claimed) return { paid: false, reason: 'not_claimable' };

  const amount = settings.rewardAmount;

  // A zero reward is a valid admin configuration (referrals on, payouts off).
  // Mark it settled rather than leaving the row stuck in 'processing' forever.
  if (amount <= 0) {
    await Referral.updateOne(
      { _id: referralId },
      { $set: { status: 'rewarded', rewardAmount: 0, rewardedAt: new Date(), requiredGamesAtReward: settings.requiredGames } }
    );
    return { paid: false, reason: 'zero_reward' };
  }

  const referrer = await User.findOneAndUpdate(
    {
      _id: claimed.referrer,
      isBanned: false,
      referralRewardCount: { $lt: settings.maxRewards },
    },
    {
      $inc: {
        referralRewardCount: 1,
        balance:             amount,
        bonusBalance:        amount,
        referralEarnings:    amount,
      },
    },
    { new: true }
  );

  // No match → the referrer has already collected their maximum (or is banned).
  // The referral is genuine and fully qualified, it just earns nothing. The code
  // keeps working; this is the intended end state, not an error.
  if (!referrer) {
    await Referral.updateOne(
      { _id: referralId },
      { $set: { status: 'capped', requiredGamesAtReward: settings.requiredGames } }
    );
    return { paid: false, reason: 'capped' };
  }

  await Referral.updateOne(
    { _id: referralId },
    {
      $set: {
        status: 'rewarded',
        rewardAmount: amount,
        rewardedAt: new Date(),
        requiredGamesAtReward: settings.requiredGames,
      },
    }
  );

  await Transaction.create({
    user: referrer._id,
    type: 'referral',
    amount,
    balanceBefore: referrer.balance - amount,
    balanceAfter:  referrer.balance,
    status: 'completed',
  });

  console.log(`✅ Referral paid: ${referrer.username} +₹${amount} (reward ${referrer.referralRewardCount}/${settings.maxRewards})`);
  return { paid: true, amount, referrerId: referrer._id, rewardCount: referrer.referralRewardCount };
}

// ============================================================================
// Advance ONE referral by one qualifying game (if this game qualifies for it).
// ============================================================================
async function advanceReferral(referredId, opponentId, game, settings) {
  const ref = await Referral.findOne({ referred: referredId, status: 'pending' });
  if (!ref) return null; // no referrer, or already rewarded/capped/blocked

  const gameId = game._id;

  // Already counted this exact game → settlement ran twice. No progress.
  if ((ref.countedGames || []).some(g => String(g) === String(gameId))) return null;

  // Playing against your own referrer is the single easiest way to farm this,
  // so it never counts.
  if (String(opponentId) === String(ref.referrer)) return null;

  const opponent = await User.findById(opponentId).select('referredBy isBanned').lean();
  if (!opponent || opponent.isBanned) return null;

  // Sibling farming: A refers B and C, then B and C play each other to qualify
  // both. Blocked — the opponent must be outside the referrer's own tree.
  if (opponent.referredBy && String(opponent.referredBy) === String(ref.referrer)) return null;

  const opponentSeen = (ref.countedOpponents || []).some(o => String(o) === String(opponentId));

  if (DISTINCT_OPPONENTS && opponentSeen) {
    // Record the game so a retry can't re-evaluate it, but award no progress.
    await Referral.updateOne({ _id: ref._id }, { $addToSet: { countedGames: gameId } });
    return null;
  }

  // Atomic progress. `countedGames: { $ne: gameId }` in the FILTER is what makes
  // this idempotent under concurrency: if two settlements for the same game race
  // here, the second finds the ID already present and matches nothing.
  const updated = await Referral.findOneAndUpdate(
    { _id: ref._id, status: 'pending', countedGames: { $ne: gameId } },
    {
      $inc: { qualifyingGames: 1 },
      $addToSet: { countedGames: gameId, countedOpponents: opponentId },
    },
    { new: true }
  );
  if (!updated) return null;

  if (updated.qualifyingGames < settings.requiredGames) {
    return { qualified: false, progress: updated.qualifyingGames, required: settings.requiredGames };
  }

  const result = await payReferral(updated._id, settings);
  return { qualified: true, progress: updated.qualifyingGames, required: settings.requiredGames, ...result };
}

// ============================================================================
// PUBLIC ENTRY POINT — call after a game has been settled.
//
// Takes a game ID rather than the in-memory document on purpose: settlement
// passes around documents loaded with varying projections, and this needs the
// authoritative status plus a bounded slice of moveHistory. One small read.
//
// ALWAYS call this defensively (fire-and-forget with a catch). A referral is a
// marketing bonus; nothing about it justifies risking a settlement path that
// moves real money.
// ============================================================================
async function recordQualifyingGame(gameId) {
  if (!gameId) return;

  const settings = await getReferralSettings();
  if (!settings.enabled || settings.requiredGames <= 0) return;

  const Game = require('../models/Game');
  const game = await Game.findById(gameId)
    .select({
      status: 1, players: 1, betAmount: 1,
      startedAt: 1, finishedAt: 1, createdAt: 1,
      moveHistory: { $slice: MOVE_SLICE },
    })
    .lean();

  if (!game || game.status !== 'finished') return;
  if (!Array.isArray(game.players) || game.players.length !== 2) return;

  // ── Real-game checks ───────────────────────────────────────────────────────
  const moves = Array.isArray(game.moveHistory) ? game.moveHistory.length : 0;
  if (moves < MIN_MOVES) return;

  const startedAt = game.startedAt || game.createdAt;
  const endedAt   = game.finishedAt || new Date();
  const durationSec = (new Date(endedAt) - new Date(startedAt)) / 1000;
  if (!Number.isFinite(durationSec) || durationSec < MIN_DURATION_SEC) return;

  const ids = game.players.map(p => (p.user && p.user._id) ? p.user._id : p.user);
  if (!ids[0] || !ids[1]) return;
  if (String(ids[0]) === String(ids[1])) return;

  // Either player might be someone's referred friend, so evaluate both sides.
  for (let i = 0; i < 2; i++) {
    try {
      await advanceReferral(ids[i], ids[1 - i], game, settings);
    } catch (e) {
      console.error('referral advance error (non-fatal):', e.message);
    }
  }
}

// ============================================================================
// GRANDFATHER MIGRATION — run once at boot.
//
// Every user who already has `referredBy` set was referred under the OLD rules
// and their referrer was ALREADY PAID at signup. Those referrals are inserted
// as 'rewarded' + grandfathered, which does two things:
//
//   • nothing is clawed back from anyone
//   • crucially, the unique index on `referred` then makes it IMPOSSIBLE for
//     any of them to be paid a second time under the new rules
//
// Without this step, every historical referral would sit at status 'pending'
// and start earning all over again the moment those players played a few games.
//
// The reward CAP counter deliberately starts at zero for everyone. Past
// referrals do not consume the new allowance — your genuine referrers are not
// punished on day one for having been successful under the old system, and the
// most an old abuser gains is one fresh allowance, which is now bounded anyway.
// ============================================================================
async function grandfatherExistingReferrals() {
  const DONE_KEY = 'referral_grandfather_done';

  const done = await Setting.findOne({ key: DONE_KEY }).lean();
  if (done && done.value === '1') return { skipped: true };

  const legacy = await User.find({ referredBy: { $ne: null } })
    .select('_id referredBy createdAt')
    .lean();

  if (legacy.length) {
    const docs = legacy.map(u => ({
      referrer: u.referredBy,
      referred: u._id,
      status: 'rewarded',
      grandfathered: true,
      rewardAmount: DEFAULTS.rewardAmount,
      qualifyingGames: 0,
      rewardedAt: u.createdAt || new Date(),
      qualifiedAt: u.createdAt || new Date(),
      createdAt: u.createdAt || new Date(),
      note: 'Paid instantly under the pre-qualification referral rules',
    }));

    try {
      // ordered:false → duplicate-key errors on rows that already exist are
      // skipped individually instead of aborting the whole batch. That makes
      // this safe to re-run and safe against a signup landing mid-migration.
      await Referral.insertMany(docs, { ordered: false });
    } catch (e) {
      if (e.code !== 11000 && !e.writeErrors) throw e;
    }
  }

  await Setting.findOneAndUpdate(
    { key: DONE_KEY },
    { key: DONE_KEY, value: '1' },
    { upsert: true, new: true }
  );

  console.log(`✅ Grandfathered ${legacy.length} existing referral(s) as already paid.`);
  return { migrated: legacy.length };
}

module.exports = {
  getReferralSettings,
  saveReferralSettings,
  recordQualifyingGame,
  grandfatherExistingReferrals,
  payReferral,
  DEFAULTS,
  LIMITS: { MIN_MOVES, MIN_DURATION_SEC, DISTINCT_OPPONENTS },
};
