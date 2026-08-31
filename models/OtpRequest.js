const mongoose = require('mongoose');

// ============================================================================
// ✅ SIGNUP OTP STORE
//
// WHY A COLLECTION AND NOT AN IN-MEMORY MAP
// A signup OTP exists BEFORE the account does, so it can't live on the User
// document. An in-memory Map would be simpler — but Railway redeploys often,
// and every redeploy would silently invalidate the code of every player
// mid-signup. They'd type a correct OTP and be told it was wrong, with nothing
// in the logs to explain it. Mongo survives restarts and gives an audit trail
// when someone disputes a charge or a lockout.
//
// The code is stored HASHED. If the database is ever dumped, live OTPs in plain
// text would let the holder complete signups for numbers they don't own.
// ============================================================================
const otpRequestSchema = new mongoose.Schema({
  // E.164, so '+919876543210' — one canonical form, never the raw 10 digits,
  // or the same number could hold two concurrent OTPs under different shapes.
  phone: { type: String, required: true, index: true },

  purpose: { type: String, enum: ['signup'], default: 'signup' },

  codeHash: { type: String, required: true },

  // Wrong guesses. Capped, because a 6-digit code is only 1-in-a-million per
  // try — unlimited attempts turns that into a certainty.
  attempts: { type: Number, default: 0 },

  // How many SMS this number has consumed in the current window. This is the
  // number that actually costs money, so it's tracked separately from attempts.
  sends: { type: Number, default: 1 },
  lastSentAt: { type: Date, default: Date.now },

  // Recorded for abuse investigation. SMS pumping runs many numbers from one
  // machine, and the phone number alone won't show you that pattern.
  ip: { type: String, default: '' },

  verifiedAt: { type: Date, default: null },
  consumedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },

  // ✅ TTL — Mongo deletes the row once this passes. Set to the resend window,
  // not the code lifetime, so the per-hour send counter survives long enough to
  // still be a limit. Without that, deleting on code expiry would reset a
  // player's send count every 10 minutes and the hourly cap would mean nothing.
  expiresAt: { type: Date, required: true },
});

// TTL index — the { expireAfterSeconds: 0 } form deletes each document at the
// moment stored in expiresAt, rather than a fixed age after creation.
otpRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpRequestSchema.index({ ip: 1, createdAt: -1 });

module.exports = mongoose.models.OtpRequest || mongoose.model('OtpRequest', otpRequestSchema);
