const mongoose = require('mongoose');

// ============================================================================
// INSTANT LUDO CONFIG
//
// Reuses the existing key/value `Setting` collection that routes/settings.js
// already defines, so there is no new settings model and nothing to migrate.
// The `mongoose.models.Setting || ...` guard is the same one used there and is
// what stops a duplicate-model OverwriteModelError when both files load.
//
// EVERY value here is live-editable from the admin panel. The multiplier in
// particular controls the whole economy and must never become a constant in
// code — you will want to change it without a deploy.
// ============================================================================

const settingSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: String
});
const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema);

// ✅ DEFAULTS ARE THE "CHANGE NOTHING ON DEPLOY" STATE.
//
// enabled:false means this deploy adds the tables, routes and scheduler but the
// game does not run and the dashboard card does not appear. Nothing about the
// live platform changes until an admin flips the switch.
// dice_max_numbers defaults to 1: ONE pick per player per round. That is the
// game — a player takes their turn, the die rolls, the round clears. An admin
// can raise it, but at 1 the multi-number arithmetic problem (covering every
// number is a guaranteed loss) cannot arise at all.
const DEFAULTS = {
  dice_enabled:         'false',
  dice_multiplier:      '5',
  dice_betting_seconds: '15',
  dice_min_bet:         '10',
  dice_max_bet:         '1000',
  dice_max_numbers:     '1',
};

// Hard bounds. An admin typo should not be able to set a 500× multiplier or a
// zero-second betting window, so every setting is clamped on write AND on read
// — on read as well, because a value written before a bound existed is still
// sitting in the database.
const BOUNDS = {
  dice_multiplier:      { min: 1.1, max: 6,     float: true },
  dice_betting_seconds: { min: 5,   max: 120 },
  dice_min_bet:         { min: 1,   max: 100000 },
  dice_max_bet:         { min: 1,   max: 10000000 },
  dice_max_numbers:     { min: 1,   max: 6 },
};

function clamp(key, raw) {
  const b = BOUNDS[key];
  if (!b) return raw;
  let n = b.float ? parseFloat(raw) : parseInt(raw, 10);
  if (!Number.isFinite(n)) n = b.float ? parseFloat(DEFAULTS[key]) : parseInt(DEFAULTS[key], 10);
  n = Math.min(b.max, Math.max(b.min, n));
  return b.float ? Math.round(n * 100) / 100 : n;
}

// ----------------------------------------------------------------------------
// In-process cache.
//
// getConfig() is called on every bet, every round open and every /current poll.
// Without a cache that is a database round-trip per call on the hottest path in
// the game. 5 seconds is short enough that an admin change feels immediate and
// long enough that a busy round is not re-reading settings hundreds of times.
//
// invalidate() is called by the admin write path so a change applies at once
// rather than up to 5 seconds later.
// ----------------------------------------------------------------------------
let cache = null;
let cacheAt = 0;
const CACHE_MS = 5000;

async function getConfig(force = false) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;

  const keys = Object.keys(DEFAULTS);
  let rows = [];
  try {
    rows = await Setting.find({ key: { $in: keys } }).lean();
  } catch (err) {
    // A settings read failure must not take the game down. Fall through to
    // defaults — which have enabled:false, i.e. the safe state.
    console.error('[dice] config read failed, using defaults:', err.message);
  }

  const raw = { ...DEFAULTS };
  for (const r of rows) if (r && r.key) raw[r.key] = r.value;

  cache = {
    enabled:        String(raw.dice_enabled) === 'true',
    multiplier:     clamp('dice_multiplier',      raw.dice_multiplier),
    bettingSeconds: clamp('dice_betting_seconds', raw.dice_betting_seconds),
    minBet:         clamp('dice_min_bet',         raw.dice_min_bet),
    maxBet:         clamp('dice_max_bet',         raw.dice_max_bet),
    maxNumbers:     clamp('dice_max_numbers',     raw.dice_max_numbers),
  };

  // maxBet below minBet would reject every possible stake. Repair rather than
  // serve a config that makes the game unplayable.
  if (cache.maxBet < cache.minBet) cache.maxBet = cache.minBet;

  cacheAt = Date.now();
  return cache;
}

async function setConfig(patch = {}) {
  const map = {
    enabled:        ['dice_enabled',         v => (v ? 'true' : 'false')],
    multiplier:     ['dice_multiplier',      v => String(clamp('dice_multiplier', v))],
    bettingSeconds: ['dice_betting_seconds', v => String(clamp('dice_betting_seconds', v))],
    minBet:         ['dice_min_bet',         v => String(clamp('dice_min_bet', v))],
    maxBet:         ['dice_max_bet',         v => String(clamp('dice_max_bet', v))],
    maxNumbers:     ['dice_max_numbers',     v => String(clamp('dice_max_numbers', v))],
  };

  for (const [field, [key, fmt]] of Object.entries(map)) {
    if (patch[field] === undefined || patch[field] === null || patch[field] === '') continue;
    await Setting.findOneAndUpdate(
      { key },
      { key, value: fmt(patch[field]) },
      { upsert: true, new: true }
    );
  }

  invalidate();
  return getConfig(true);
}

function invalidate() {
  cache = null;
  cacheAt = 0;
}

module.exports = { getConfig, setConfig, invalidate, DEFAULTS, Setting };
