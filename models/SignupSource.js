const mongoose = require('mongoose');

// ============================================================================
// ✅ WHERE A SIGNUP CAME FROM
//
// A separate collection rather than a field on User, deliberately. Adding a
// field to User means the schema and the deployed model have to stay in sync —
// and Mongoose strict mode SILENTLY DROPS fields it doesn't know about. Get
// that wrong and tracking appears to work while storing nothing, which you'd
// only discover weeks later when the report is empty. Its own model can't fail
// that way.
//
// Referral signups are NOT recorded here. They're already tracked by
// User.referredBy and the Referral ledger, and duplicating them would create a
// second number that can disagree with the first.
// ============================================================================
const signupSourceSchema = new mongoose.Schema({
  // One row per account, enforced by the database — a retry or double-submit
  // can't inflate the count.
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },

  // 'telegram', 'meta', 'direct', or whatever you put in the link's
  // ?utm_source=. Lowercased and length-capped on write so a malformed or
  // hostile link can't create thousands of junk rows in the report.
  source: { type: String, required: true, lowercase: true, trim: true, maxlength: 40 },

  // Optional ?utm_campaign=, so several Telegram ads can be told apart.
  campaign: { type: String, default: '', trim: true, maxlength: 60 },

  createdAt: { type: Date, default: Date.now },
});

signupSourceSchema.index({ source: 1, createdAt: -1 });
signupSourceSchema.index({ createdAt: -1 });

module.exports = mongoose.models.SignupSource || mongoose.model('SignupSource', signupSourceSchema);
