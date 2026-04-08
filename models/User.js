const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 20 },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone:    { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true, minlength: 6 },
  role:     { type: String, enum: ['player', 'admin'], default: 'player' },
  balance:       { type: Number, default: 0, min: 0 },
  lockedBalance: { type: Number, default: 0 },
  isActive:  { type: Boolean, default: true },
  isBanned:  { type: Boolean, default: false },
  gamesPlayed: { type: Number, default: 0 },
  gamesWon:    { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  totalLost:   { type: Number, default: 0 },
  fcmToken:    { type: String, default: null },
  createdAt:   { type: Date, default: Date.now },
});

// ✅ Indexes for fast lookups
userSchema.index({ email: 1 });
userSchema.index({ phone: 1 });
userSchema.index({ username: 1 });
userSchema.index({ role: 1, isBanned: 1 });

// ✅ bcrypt rounds reduced from 12 to 10 — 4x faster login/register
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
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

module.exports = mongoose.model('User', userSchema);
