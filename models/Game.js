const mongoose = require('mongoose');

const tokenSchema = new mongoose.Schema({
  position:   { type: Number, default: -1 },   // -1 = home base, 0-56 = on board
  isHome:     { type: Boolean, default: true },
  isFinished: { type: Boolean, default: false },
}, { _id: false });

const playerSchema = new mongoose.Schema({
  user:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  color:          { type: String, enum: ['red', 'blue'], required: true },
  tokens:         { type: [tokenSchema], default: () => Array(4).fill({ position: -1, isHome: true, isFinished: false }) },
  finishedTokens: { type: Number, default: 0 },
  isConnected:    { type: Boolean, default: false },
}, { _id: false });

const moveHistorySchema = new mongoose.Schema({
  player:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dice:         { type: Number },
  tokenIndex:   { type: Number },
  fromPosition: { type: Number },
  toPosition:   { type: Number },
  timestamp:    { type: Date, default: Date.now },
}, { _id: false });

const gameSchema = new mongoose.Schema({
  roomCode: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  },
  betAmount: {
    type: Number,
    required: true,
    min: 10,
  },
  status: {
    type: String,
    enum: ['waiting', 'active', 'finished', 'cancelled', 'aborted'],
    default: 'waiting',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  players: {
    type: [playerSchema],
    default: [],
  },
  currentTurn: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  lastDiceRoll: {
    type: Number,
    default: null,
  },
  consecutiveSixes: {
    type: Number,
    default: 0,
  },
  winner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  loser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // ✅ Tracks intentional forfeit — player who forfeited cannot rejoin
  forfeitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  winAmount: {
    type: Number,
    default: 0,
  },
  platformFee: {
    type: Number,
    default: 0,
  },
  moveHistory: {
    type: [moveHistorySchema],
    default: [],
  },
  startedAt:  { type: Date, default: null },
  finishedAt: { type: Date, default: null },
}, {
  timestamps: true,   // adds createdAt + updatedAt automatically
});

// Index for fast lookups
gameSchema.index({ roomCode: 1 });
gameSchema.index({ 'players.user': 1, status: 1 });
gameSchema.index({ createdBy: 1, status: 1 });

module.exports = mongoose.model('Game', gameSchema);
