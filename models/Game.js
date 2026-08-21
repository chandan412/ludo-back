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
    // ✅ HARD CAP — defence in depth against the "3 players in one game" bug.
    //
    // The real fix is the atomic claim in routes/game.js (a findOneAndUpdate
    // whose filter includes players:{$size:1}). This validator is the backstop:
    // if any future code path ever pushes a third player through a full document
    // save, it fails loudly instead of silently corrupting a live game.
    //
    // NOTE: validators run on save()/create(), NOT on findOneAndUpdate unless
    // runValidators is set — which is precisely why the atomic filter, not this,
    // has to be the primary guard.
    validate: {
      validator: function (v) { return !v || v.length <= 2; },
      message: props => `A game can hold at most 2 players (got ${props.value.length})`,
    },
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
  startedAt:        { type: Date,    default: null },
  finishedAt:       { type: Date,    default: null },
  settlementFailed: { type: Boolean, default: false }, // flag if money settlement threw
}, {
  timestamps: true,   // adds createdAt + updatedAt automatically
});

// Index for fast lookups
//
// ⚠️ REMOVED: gameSchema.index({ roomCode: 1 })
//
// `roomCode` already declares `unique: true` in the field definition above, which
// makes Mongoose build a UNIQUE index named `roomCode_1`. This line asked for a
// NON-unique index with the same auto-generated name, so MongoDB rejects one of
// them with IndexKeySpecsConflict:
//
//   "An existing index has the same name as the requested index...
//    Requested: { key: { roomCode: 1 } }, existing: { unique: true, ... }"
//
// Because the app never awaits Game.init(), that error surfaced only on the
// connection's error channel and was easy to miss — but it means index creation
// was partially failing on every boot. Worse, if the NON-unique index won the
// race on the live database, roomCode was never actually unique, and two games
// could share a room code.
//
// The unique index from the field definition is kept and is the one we want.
gameSchema.index({ 'players.user': 1, status: 1 });
gameSchema.index({ createdBy: 1, status: 1 });
gameSchema.index({ status: 1, updatedAt: 1 }); // orphan sweep query

module.exports = mongoose.model('Game', gameSchema);
