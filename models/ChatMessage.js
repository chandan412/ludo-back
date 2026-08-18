const mongoose = require('mongoose');

// Shared chat message model. Used by BOTH socket/gameSocket.js (writes) and
// routes/chat.js (reads history) so they point at the same 'chatmessages'
// collection. No `type` enum so both 'chat' and 'invite' messages are allowed.
// Messages auto-expire after 24h via the TTL index on createdAt.
//
// ============================================================================
// ⚠️ CRITICAL FIX — INVITE LIFECYCLE FIELDS
//
// The previous version of this schema had NO `status` field. gameSocket.js was
// already doing `$set: { status: 'expired' }` / `{ status: 'accepted' }` on
// these docs — but Mongoose runs in STRICT MODE by default, which SILENTLY
// STRIPS any path that is not declared in the schema. Every one of those writes
// was a no-op: no error thrown, nothing saved. That is exactly why invite cards
// never showed "expired" and never remembered who joined after a refresh.
//
// Declaring the fields below is what makes those writes actually persist.
// Same class of bug as the Transaction.type enum issue: Mongoose fails quietly.
// ============================================================================
const chatSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:  { type: String, required: true },
  type:      { type: String, default: 'chat' },
  text:      { type: String, default: '' },
  betAmount: { type: Number, default: 0 },
  roomCode:  { type: String, default: '' },

  // ── Invite card lifecycle (type: 'invite' only) ───────────────────────────
  // status flow:  waiting → accepted → finished
  //                       ↘ expired            (nobody joined / room aborted)
  status:       { type: String, default: 'waiting' },

  // Who accepted the challenge (filled the room). Stays visible permanently.
  acceptedBy:   { type: String, default: '' },
  acceptedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Who actually won the game. Stays visible permanently.
  winnerName:   { type: String, default: '' },
  winnerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  loserName:    { type: String, default: '' },
  winAmount:    { type: Number, default: 0 },

  // How the game ended: '', 'win', 'forfeit', 'opponent_disconnected',
  // 'no_opponent', 'connection_lost', 'cancelled'
  resultReason: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now, expires: 86400 },
});

// ✅ Every invite lookup in gameSocket.js and routes/chat.js filters on
// { type: 'invite', roomCode }. Without this index those are collection scans
// on a doc set that grows with every message. Cheap to add, safe on live data
// (background build, no schema/data change).
chatSchema.index({ type: 1, roomCode: 1 });

// Guard against "Cannot overwrite model once compiled" if already registered
// (e.g. by gameSocket.js loading first).
module.exports = mongoose.models.ChatMessage || mongoose.model('ChatMessage', chatSchema);
