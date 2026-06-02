const mongoose = require('mongoose');

// Shared chat message model. Used by BOTH socket/gameSocket.js (writes) and
// routes/chat.js (reads history) so they point at the same 'chatmessages'
// collection. No `type` enum so both 'chat' and 'invite' messages are allowed.
// Messages auto-expire after 24h via the TTL index on createdAt.
const chatSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:  { type: String, required: true },
  type:      { type: String, default: 'chat' },
  text:      { type: String, default: '' },
  betAmount: { type: Number, default: 0 },
  roomCode:  { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, expires: 86400 },
});

// Guard against "Cannot overwrite model once compiled" if already registered
// (e.g. by gameSocket.js loading first).
module.exports = mongoose.models.ChatMessage || mongoose.model('ChatMessage', chatSchema);
