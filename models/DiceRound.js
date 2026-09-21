const mongoose = require('mongoose');

// ============================================================================
// DICE ROUND — one Instant Ludo round.
//
// Lifecycle: betting → locked → settled
//                   ↘ cancelled (from either of the first two)
//
// drawnNumber is written at the moment the round flips out of `betting`, and
// is committed to the database BEFORE any client is told the round has locked.
// A client that learns the number before the reveal is a client that can be
// made to cheat, so the ordering here is not cosmetic.
// ============================================================================

const diceRoundSchema = new mongoose.Schema({
  roundNumber: {
    type: Number,
    required: true,
    unique: true
  },

  status: {
    type: String,
    enum: ['betting', 'locked', 'settled', 'cancelled'],
    default: 'betting'
  },

  // 1-6. Null until the draw. Never sent to a client while status is 'betting'.
  drawnNumber: {
    type: Number,
    min: 1,
    max: 6,
    default: null
  },

  bettingEndsAt: {
    type: Date,
    required: true
  },

  // ✅ The multiplier IN FORCE FOR THIS ROUND, copied off the live admin setting
  // when the round opens. Settlement reads this field, never the setting.
  //
  // If it read the setting instead, an admin changing 5× to 5.5× mid-round
  // would pay out bets that were placed under the old odds at the new ones —
  // and worse, a change made between the draw and settlement would apply
  // retroactively to a round whose result is already known. Freezing it at
  // round open makes every round self-contained and auditable.
  multiplier: {
    type: Number,
    required: true,
    default: 5
  },

  totalStaked:  { type: Number, default: 0 },
  totalPaidOut: { type: Number, default: 0 },

  cancelReason: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now },
  settledAt: { type: Date, default: null }
});

// ✅ "Find the open round" runs on every page load, every bet and every tick of
// the scheduler. Without this index it is a collection scan that grows with
// every round ever played — a few thousand rounds a day, forever.
diceRoundSchema.index({ status: 1, createdAt: -1 });

// Round history for players and the admin stats window.
diceRoundSchema.index({ createdAt: -1 });

module.exports = mongoose.models.DiceRound || mongoose.model('DiceRound', diceRoundSchema);
