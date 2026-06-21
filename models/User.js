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
  referralCount:    { type: Number, default: 0 },
  referralEarnings: { type: Number, default: 0 },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

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
