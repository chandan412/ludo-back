const mongoose = require('mongoose');

const tokenSchema = new mongoose.Schema({
  position:   { type: Number,  default: -1    },
  isHome:     { type: Boolean, default: true  },
  isFinished: { type: Boolean, default: false }
}, { _id: false });

const playerStateSchema = new mongoose.Schema({
  user:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  color: { type: String, enum: ['red', 'blue'] },
  tokens: {
    type: [tokenSchema],
    default: () => [
      { position: -1, isHome: true, isFinished: false },
      { position: -1, isHome: true, isFinished: false },
      { position: -1, isHome: true, isFinished: false },
      { position: -1, isHome: true, isFinished: false }
    ]
  },
  finishedTokens: { type: Number,  default: 0    },
  isConnected:    { type: Boolean, default: false }
}, { _id: false });

const gameSchema = new mongoose.Schema({
  roomCode:  { type: String, required: true, unique: true },
  betAmount: { type: Number, required: true, min: 10 },

  // ✅ 'aborted' added — used when creator leaves or no opponent joins in 2 mins
  status: {
    type: String,
    enum: ['waiting', 'active', 'finished', 'cancelled', 'aborted'],
    default: 'waiting'
  },

  players:     [playerStateSchema],
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  currentTurn: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  winner:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  loser:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  winAmount:   { type: Number, default: 0 },
  platformFee: { type: Number, default: 0 },

  lastDiceRoll:     { type: Number, default: null },
  consecutiveSixes: { type: Number, default: 0 },

  moveHistory: [{
    player:       mongoose.Schema.Types.ObjectId,
    dice:         Number,
    tokenIndex:   Number,
    fromPosition: Number,
    toPosition:   Number,
    timestamp:    { type: Date, default: Date.now }
  }],

  startedAt:  { type: Date },
  finishedAt: { type: Date },
  createdAt:  { type: Date, default: Date.now }
});

module.exports = mongoose.model('Game', gameSchema);
