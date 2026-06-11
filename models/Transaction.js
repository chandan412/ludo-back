const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: ['recharge', 'withdraw', 'game_win', 'game_loss', 'game_lock', 'game_unlock', 'platform_fee', 'refund', 'referral'],
    required: true
  },
  amount: { type: Number, required: true },
  balanceBefore: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'completed'],
    default: 'completed'
  },
  rechargeNote: { type: String },
  bankDetails: {
    accountHolderName: { type: String },
    accountNumber: { type: String },
    ifscCode: { type: String },
    bankName: { type: String },
    upiId: { type: String }
  },
  withdrawNote: { type: String },
  gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  processedAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

// ✅ INDEXES — without these, every transaction query was a FULL COLLECTION SCAN.
// That saturated the database, and because login/registration share the same DB,
// they timed out alongside the admin player-list and transactions. Each index below
// maps to a real query in routes/admin.js (and wallet/game lookups):
//
//   { user, createdAt }   → GET /player/:id  (a player's transaction history, newest first)
//                         → settleGame / wallet history lookups by user
//   { type, status }      → dashboard-stats counts + aggregates, pending-by-type
//   { status, createdAt } → GET /pending-transactions (status:'pending', sorted)
//   { type, createdAt }   → GET /all-transactions filtered by type, sorted
//   { createdAt }         → GET /all-transactions default sort (no type filter)
//
// Indexes only add structures alongside the data — they change NO documents and no
// money logic. Mongoose builds them in the background on the next deploy.
transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ status: 1, createdAt: -1 });
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
