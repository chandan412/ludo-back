const mongoose = require('mongoose');

// ============================================================================
// ✅ NEW PLAYER SIGNUP BONUS
//
// Credits a one-time welcome bonus when an account is created. Amount and
// on/off are set from the admin panel and read at signup time, so changing them
// takes effect on the very next registration with no redeploy.
//
// WHY THE BONUS IS NOT WITHDRAWABLE
// ---------------------------------
// It lands in `balance` (so it is immediately playable) and is simultaneously
// tracked in `bonusBalance` (so withdrawals exclude it) — the same treatment
// the referral reward gets, and for a sharper version of the same reason.
//
// A withdrawable signup bonus is a cash machine: register, request withdrawal,
// repeat. There is no friend to recruit and no game to play, so it is strictly
// easier to farm than the referral bonus was before it was fixed. Every rupee
// handed out this way leaves the platform and never returns as play.
//
// Non-withdrawable inverts that. The bonus can only be SPENT IN GAMES, which
// means its entire value is realised as engagement — the thing you actually
// wanted to buy — and a farmed account gets free coins it can do nothing with
// except play, which is harmless.
//
// WHAT ACTUALLY LIMITS ABUSE
// --------------------------
// Not this file. The real gate is phone verification at signup (LineVerify),
// which already requires a working number before the account exists. This
// module assumes that gate is doing its job; if verification is ever switched
// off, the signup bonus becomes free to mint in bulk and should be switched off
// with it.
// ============================================================================

const settingSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: String,
});
const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema);

const KEYS = {
  enabled: 'signup_bonus_enabled',
  amount:  'signup_bonus_amount',
  // ✅ Separate amount for signups that arrived via a referral code.
  //
  // The two are not the same kind of signup. A player from a Telegram ad cost
  // you ad spend and is a stranger; a referred player was introduced by someone
  // already collecting a referral reward for them. Paying both the same made
  // the referred route the cheapest way to manufacture accounts — the farmer
  // gets the referral reward AND a full signup bonus on every account they
  // create. Splitting the amounts prices that difference in.
  referralAmount: 'signup_bonus_referral_amount',
};

const DEFAULTS = {
  // Defaults to OFF. A bonus that switches itself on at deploy time and starts
  // handing out money before anyone chose an amount is not a good surprise.
  enabled: String(process.env.SIGNUP_BONUS_ENABLED || 'false') === 'true',
  amount:  parseInt(process.env.SIGNUP_BONUS_AMOUNT || 0, 10),
  referralAmount: parseInt(process.env.SIGNUP_BONUS_REFERRAL_AMOUNT || 0, 10),
};

let cache = null;
let cacheAt = 0;
const CACHE_MS = 60 * 1000;

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function getSignupBonus(force = false) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  try {
    const rows = await Setting.find({ key: { $in: Object.values(KEYS) } }).lean();
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    cache = {
      enabled: map[KEYS.enabled] === undefined ? DEFAULTS.enabled : map[KEYS.enabled] === 'true',
      amount:  Math.max(0, toInt(map[KEYS.amount], DEFAULTS.amount)),
      // Falls back to the main amount when never configured, so deploying this
      // changes nothing until you set a different figure — referred players
      // keep getting exactly what they got before.
      referralAmount: map[KEYS.referralAmount] === undefined
        ? Math.max(0, toInt(map[KEYS.amount], DEFAULTS.amount))
        : Math.max(0, toInt(map[KEYS.referralAmount], DEFAULTS.referralAmount)),
    };
    cacheAt = Date.now();
  } catch (e) {
    console.error('signup bonus settings read error (using defaults):', e.message);
    // Fail CLOSED here — the opposite of the withdrawal limiter. A read failure
    // that silently starts paying an unintended amount to every new account is
    // worse than one that pays nothing; nobody is harmed by a missing bonus,
    // and it is trivially fixed by registering again later.
    cache = { enabled: false, amount: 0, referralAmount: 0 };
    cacheAt = Date.now();
  }
  return cache;
}

async function saveSignupBonus(patch) {
  const ops = [];
  if (patch.enabled !== undefined)
    ops.push({ key: KEYS.enabled, value: String(Boolean(patch.enabled)) });
  if (patch.amount !== undefined)
    ops.push({ key: KEYS.amount, value: String(Math.max(0, toInt(patch.amount, DEFAULTS.amount))) });
  if (patch.referralAmount !== undefined)
    ops.push({ key: KEYS.referralAmount, value: String(Math.max(0, toInt(patch.referralAmount, DEFAULTS.referralAmount))) });

  for (const op of ops) {
    await Setting.findOneAndUpdate({ key: op.key }, op, { upsert: true, new: true });
  }
  cache = null;
  return getSignupBonus(true);
}

// ============================================================================
// Resolve the amount to credit at account-creation time.
//
// Returns 0 when the bonus is off or set to zero. The caller folds this into
// the User.create() call rather than doing a second write, so a brand new
// account is never briefly visible with the wrong balance.
// ============================================================================
async function resolveSignupBonus(opts = {}) {
  try {
    const s = await getSignupBonus();
    if (!s.enabled) return 0;
    // `referred: true` -> the lower amount. Called with no argument anywhere
    // that predates this change, which resolves to the standard amount, so
    // nothing silently shifts.
    const amount = opts.referred ? s.referralAmount : s.amount;
    return amount > 0 ? amount : 0;
  } catch (e) {
    console.error('resolveSignupBonus error (crediting 0):', e.message);
    return 0;
  }
}

module.exports = {
  getSignupBonus,
  saveSignupBonus,
  resolveSignupBonus,
  DEFAULTS,
};
