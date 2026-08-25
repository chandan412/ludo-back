const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 20
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ['player', 'admin'],
    default: 'player'
  },
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  lockedBalance: {
    type: Number,
    default: 0
  },
  // ✅ Referral BONUS — the portion of `balance` that came from referral rewards and is
  // NOT withdrawable. IMPORTANT: `balance` ALREADY INCLUDES this amount. This is a marker
  // tracking how much of the balance is bonus, NOT a separate wallet. It makes bonus money
  // spendable in games (it's part of balance) while keeping it out of withdrawals.
  // Withdrawable = balance - lockedBalance - bonusBalance.
  bonusBalance: {
    type: Number,
    default: 0,
    min: 0
  },
  // ✅ Phone verification (LineVerify). NEW users must verify their number before they can
  // play. EXISTING users (created before this feature) are grandfathered to `true` by a
  // one-time migration in server.js, so they're never blocked.
  phoneVerified: {
    type: Boolean,
    default: false
  },
  phoneVerifiedAt: {
    type: Date,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isBanned: {
    type: Boolean,
    default: false
  },
  gamesPlayed: { type: Number, default: 0 },
  gamesWon: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  totalLost: { type: Number, default: 0 },

  // ✅ Referral system
  referralCode:     { type: String, unique: true, sparse: true, uppercase: true, trim: true },
  referredBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // How many people SIGNED UP with this user's code. Counts every signup,
  // including ones that never play — it is a share-reach number, not a money
  // number, and is shown to the player as "friends joined".
  referralCount:    { type: Number, default: 0 },

  // Total value actually PAID OUT to this user for referrals.
  referralEarnings: { type: Number, default: 0 },

  // ✅ THE CAP COUNTER — how many times this user has actually been PAID a
  // referral reward. Deliberately separate from referralCount, because they now
  // mean different things: you may refer a hundred people and be paid five
  // times. This field is compared against the admin's `referral_max_rewards`
  // setting inside an atomic findOneAndUpdate filter, which is what makes the
  // cap race-proof — see utils/referral.js payReferral().
  //
  // Starts at 0 for EVERYONE, including users who referred people under the old
  // instant-payout rules. Past referrals do not eat the new allowance.
  referralRewardCount: { type: Number, default: 0 },

  // ✅ WITHDRAWAL REQUEST RATE LIMIT — see utils/withdrawLimit.js.
  //
  // These two fields exist so the limit can be claimed ATOMICALLY. Counting
  // recent withdraw Transactions instead would mean read-then-write, which two
  // simultaneous requests can both pass; on a path that locks balance, that is
  // not a race worth leaving open. A conditional $inc on a single document
  // cannot be raced.
  //
  // withdrawWindowStart is when the player's current window opened. Absent/null
  // on existing accounts, which the claim logic treats as "no active window" —
  // so no migration is needed and nobody starts out already limited.
  withdrawWindowStart: { type: Date,   default: null },
  withdrawWindowCount: { type: Number, default: 0 },

  // ✅ SIGNUP BONUS — how much welcome bonus this account was given, and when.
  //
  // Recorded on the user rather than inferred from the Transaction log because
  // it answers the support question directly ("did this player get the bonus,
  // and how much was it at the time?") without a query, and because the amount
  // is admin-editable — a player who joined when it was ₹25 should not appear
  // to have received today's ₹50.
  //
  // Non-zero also acts as the has-been-paid marker, so any future backfill or
  // retry can skip accounts that were already credited.
  signupBonus:      { type: Number, default: 0 },
  signupBonusAt:    { type: Date,   default: null },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

// ============================================================================
// ✅ INDEXES
//
// This schema previously declared NONE. The admin players list runs:
//
//     User.find({ role: 'player' }).sort({ createdAt: -1 }).limit(...)
//     User.countDocuments({ role: 'player' })
//
// With no supporting index, MongoDB scanned EVERY user document and then sorted
// the entire matching set in memory, on every load. Measured with 3,000 users:
//
//     stage: COLLSCAN, in-memory SORT: YES, docs examined: 3000
//
// With this index it becomes an ordered index scan that stops at the limit, and
// the sort is free because the index is already in createdAt order:
//
//     stage: IXSCAN,  in-memory SORT: none, docs examined: 1000
//
// It also covers countDocuments({ role: 'player' }) and the isBanned variant on
// the dashboard-stats endpoint.
//
// Indexes only add structures alongside the data — no document changes, no
// logic changes. Mongoose builds them in the background on the next deploy.
// ============================================================================
userSchema.index({ role: 1, createdAt: -1 });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
