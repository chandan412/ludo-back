const mongoose = require('mongoose');

// ============================================================================
// DICE BET — one player's stake on one number in one round.
//
// SEVERAL ROWS PER PLAYER PER ROUND IS NORMAL. That is what multi-number
// betting means: a player covering 2, 4 and 6 has three rows in this round.
// Nothing here is unique per (user, round) and it must not become so.
//
// A repeat stake on a number the player has ALREADY backed this round is
// folded into the existing row by $inc (see routes/dice.js) rather than
// creating a second row, so settlement never has to sum duplicates.
// ============================================================================

const diceBetSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  round: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DiceRound',
    required: true
  },

  number: {
    type: Number,
    required: true,
    min: 1,
    max: 6
  },

  // Coins. Never rupees.
  amount: {
    type: Number,
    required: true,
    min: 1
  },

  status: {
    type: String,
    enum: ['pending', 'won', 'lost', 'refunded'],
    default: 'pending'
  },

  // Gross return on a win, i.e. amount * multiplier (stake included).
  // The player's balance is credited payout - amount, because the stake was
  // only ever locked, never deducted. See settleRound().
  payout: {
    type: Number,
    default: 0
  },

  createdAt: { type: Date, default: Date.now },
  settledAt: { type: Date, default: null }
});

// ✅ Settlement: every pending bet in the round being settled. This is the hot
// query — it runs once per round, against the whole round's bets.
diceBetSchema.index({ round: 1, status: 1 });

// ✅ The player's own bets in the current round (shown in the UI as their
// active stakes) and their history list.
diceBetSchema.index({ user: 1, createdAt: -1 });

// ============================================================================
// ✅ ONE PICK PER PLAYER PER NUMBER PER ROUND — enforced by MongoDB.
//
// The route checks first, but a check is a READ followed by a WRITE, and four
// taps 50ms apart all read "no bet yet" and all four insert. Tested: without
// this index the compensating cleanup then deleted ALL FOUR rows, and the
// player's turn silently vanished (coins were refunded, so no money was lost —
// but they had picked a number and ended up with nothing on the board).
//
// A unique index closes it at the only layer that cannot be raced. The losing
// inserts fail with duplicate-key error 11000, which routes/dice.js catches and
// turns into "you already picked that number". Same technique as the
// one_pending_withdraw_per_user index in Transaction.js.
//
// Scoped to (round, user, number), so two different players can both pick 4,
// and the same player can pick 4 again next round.
//
// ⚠️ DEPLOY NOTE: this builds on a collection that does not exist yet, so there
// is nothing to clean first. If you ever rebuild it against live data, drop
// duplicate (round,user,number) rows before deploying or the build fails.
// ============================================================================
diceBetSchema.index(
  { round: 1, user: 1, number: 1 },
  { unique: true, name: 'one_pick_per_number_per_round' }
);

module.exports = mongoose.models.DiceBet || mongoose.model('DiceBet', diceBetSchema);
