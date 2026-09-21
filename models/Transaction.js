const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    // ✅ coin_* types belong to Instant Ludo and are denominated in COINS, not
    // rupees. They are listed here so coin activity lands in the same ledger a
    // support query already searches, but they are deliberately NOT added to
    // any of the money aggregates.
    //
    // Verified before adding: every rupee total in routes/analytics.js and
    // routes/admin.js matches on an explicit type whitelist
    // (['recharge','withdraw','platform_fee','referral','signup_bonus']), so a
    // coin row cannot be summed into revenue, recharge or withdrawal figures.
    // If a new aggregate is ever written WITHOUT a type filter, add
    // `currency: 'INR'` to its $match — that is what the field below is for.
    enum: [
      'recharge', 'withdraw', 'game_win', 'game_loss', 'game_lock',
      'game_unlock', 'platform_fee', 'refund', 'referral', 'signup_bonus',
      'coin_grant', 'coin_lock', 'coin_win', 'coin_loss', 'coin_refund'
    ],
    required: true
  },

  // ✅ Which wallet this row moved. 'INR' is the real-money balance; 'COIN' is
  // the non-convertible Instant Ludo wallet. Defaults to 'INR' so every row
  // ever written before this field existed reads correctly with no migration.
  currency: {
    type: String,
    enum: ['INR', 'COIN'],
    default: 'INR'
  },
  amount: { type: Number, required: true },
  balanceBefore: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  status: {
    type: String,
    // ✅ 'cancelled' = withdrawn by the PLAYER before an admin acted on it.
    // Deliberately distinct from 'rejected', which means an admin refused it.
    // Collapsing the two would make the ledger unreadable: you could no longer
    // tell "I changed my mind" from "you were turned down", and the player
    // would see a rejection card for something they did themselves.
    enum: ['pending', 'approved', 'rejected', 'completed', 'cancelled'],
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

  // ============================================================================
  // ✅ ADMIN REMARK — the reason shown to the player when a request is rejected.
  //
  // Deliberately SEPARATE from rechargeNote/withdrawNote. Those hold the PLAYER's
  // own submission (their UTR / payment reference), and routes/admin.js was
  // overwriting rechargeNote with the rejection reason — destroying the very
  // reference you'd need if the player later disputed the rejection. Keeping the
  // remark in its own field preserves both sides of the record.
  //
  // remarkAck starts false and flips true when the player taps "OK, got it" on
  // the card. It lives in the DB rather than in browser state on purpose: local
  // state would bring the card back on every reload and on every other device.
  // ============================================================================
  adminRemark: { type: String, default: '' },
  remarkAck:   { type: Boolean, default: false },
  gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },

  // ✅ Instant Ludo round this row belongs to. Separate from gameId because it
  // points at a different collection (DiceRound, not Game) — reusing gameId
  // would give you a ref that populate() resolves to null.
  diceRoundId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiceRound' },
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

// ✅ Coin ledger: "this player's Instant Ludo history, newest first" and the
// admin's coin-only transaction view. Without it those queries fall back to
// { user, createdAt } and then filter in memory across every rupee row the
// player has — which, for an active player, is most of their history.
transactionSchema.index({ currency: 1, user: 1, createdAt: -1 });

// ============================================================================
// ✅ ONE PENDING WITHDRAWAL PER PLAYER — enforced by MongoDB, not by code.
//
// The route already checked for an existing pending request, but that check was
// a READ followed later by a WRITE with several awaits in between. Five taps
// 100ms apart all read "no pending request" and four of them created one:
// ₹4,000 of pending withdrawals against a ₹1,000 balance, any of which an admin
// could have approved.
//
// A partial unique index closes it at the only layer that can't be raced. Two
// concurrent inserts hit the same index entry and MongoDB rejects the second
// with duplicate-key error 11000 — which the route catches and turns into the
// normal "you already have a pending request" message.
//
// The partialFilterExpression is what makes this workable: uniqueness applies
// ONLY to withdrawals that are currently pending. Approved, rejected and
// cancelled rows are outside the filter, so a player can withdraw again once
// the first request is resolved, and their history is unaffected.
//
// ⚠️ DEPLOY NOTE: if any player currently has more than one pending withdrawal,
// this index will FAIL TO BUILD and Mongoose logs the error at startup. Clean
// duplicates first — see the query in the deploy notes.
// ============================================================================
transactionSchema.index(
  { user: 1 },
  {
    unique: true,
    name: 'one_pending_withdraw_per_user',
    partialFilterExpression: { type: 'withdraw', status: 'pending' },
  }
);

module.exports = mongoose.model('Transaction', transactionSchema);
