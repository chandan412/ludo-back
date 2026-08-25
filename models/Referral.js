const mongoose = require('mongoose');

// ============================================================================
// ✅ REFERRAL LEDGER — one document per referred SIGNUP.
//
// WHY A SEPARATE COLLECTION rather than more fields on User:
//
//   1. The unique index on `referred` is the single hard guarantee that a given
//      signup can NEVER pay out twice, no matter how many times a game settles,
//      how many servers are running, or how a race unfolds. Counters on User
//      give no such guarantee.
//   2. Qualification is stateful — we must remember WHICH games and WHICH
//      opponents already counted, or a fraudster replays the same match.
//   3. The admin needs an auditable list ("who referred whom, how far along,
//      paid or not"), which a pair of integers on User can't provide.
//
// STATUS LIFECYCLE:
//
//   pending ──(enough qualifying games)──> processing ──(credited)──> rewarded
//                                              │
//                                              └──(referrer at cap)──> capped
//
//   'processing' is a CLAIM state, held for the few milliseconds between
//   deciding to pay and the money actually landing. It exists so that two
//   concurrent game settlements cannot both decide to pay the same referral:
//   the flip pending → processing is an atomic findOneAndUpdate, and only the
//   winner of that flip proceeds. A document stuck in 'processing' (server died
//   mid-payout) is SAFE — it will never be paid twice, only never finalised,
//   and it shows up in the admin list for manual review.
//
//   'capped' means the referral genuinely qualified but the referrer had
//   already collected their maximum number of rewards. The code still works for
//   sharing and the friend still joins — there is simply no payout. This is
//   exactly the behaviour that stops bulk fake-account farming from being worth
//   anyone's time.
// ============================================================================

const referralSchema = new mongoose.Schema({
  referrer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  // ✅ THE ANTI-DOUBLE-PAY GUARANTEE.
  // `unique` here means MongoDB itself refuses a second ledger row for the same
  // referred account. Every other guard in this system is defence in depth; this
  // one is enforced by the database and cannot be bypassed by application bugs.
  referred: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },

  // The code as it was typed at signup — kept for support/audit, since the
  // referrer could theoretically be issued a new code later.
  code: { type: String, uppercase: true, trim: true, default: '' },

  // How many games the referred player has completed that PASSED every
  // qualification check. Not the same as their raw gamesPlayed.
  qualifyingGames: { type: Number, default: 0 },

  // ✅ IDEMPOTENCY. Settlement can run more than once for the same game
  // (retries, a reconnect racing a forfeit, an admin replay). Recording the
  // game IDs we already counted makes a repeat settlement a no-op instead of
  // free progress.
  countedGames: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Game' }],

  // ✅ DISTINCT-OPPONENT RULE. Without this, two fake accounts play each other
  // three times and the referral qualifies. Recording who has already counted
  // means the Nth qualifying game must be against the Nth different person.
  countedOpponents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  status: {
    type: String,
    enum: ['pending', 'processing', 'rewarded', 'capped', 'blocked'],
    default: 'pending',
  },

  rewardAmount: { type: Number, default: 0 },

  // Snapshot of the admin setting AT THE MOMENT OF PAYOUT. If the admin later
  // raises the requirement from 3 to 5, history still shows what the rule
  // actually was when this player earned — otherwise old records silently
  // rewrite themselves and disputes become unanswerable.
  requiredGamesAtReward: { type: Number, default: 0 },

  qualifiedAt: { type: Date, default: null },
  rewardedAt:  { type: Date, default: null },

  // ✅ Marks referrals that predate this system. They were already paid instantly
  // at signup under the old rules, so they are inserted as 'rewarded' and are
  // never re-evaluated. Nothing is clawed back from anyone.
  grandfathered: { type: Boolean, default: false },

  // Free-text reason when status is 'blocked' (admin action / fraud review).
  note: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now },
});

// ============================================================================
// ✅ INDEXES
//
// NOTE: there is deliberately NO explicit index on `referred` here. The field
// declaration already carries `unique: true`, which makes Mongoose build a
// UNIQUE index named `referred_1`. Declaring a second, non-unique index with
// the same auto-generated name causes MongoDB to reject one of them with
// IndexKeySpecsConflict — the exact failure documented in models/Game.js, where
// a duplicate roomCode index meant uniqueness was silently not enforced.
//
//   { referrer, createdAt } → the player's own "my referrals" list, newest first
//   { status, createdAt }   → admin list filtered by pending/rewarded/capped
// ============================================================================
referralSchema.index({ referrer: 1, createdAt: -1 });
referralSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.Referral || mongoose.model('Referral', referralSchema);
