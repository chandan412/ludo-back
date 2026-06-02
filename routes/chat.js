const express = require('express');
const router = express.Router();
const ChatMessage = require('../models/ChatMessage');
const { auth } = require('../middleware/auth');

// GET /api/chat/messages
// Returns the last 100 chat messages in chronological order (oldest first),
// so GameChat.js can render history on page load / refresh. Without this,
// messages live only in browser memory and vanish on refresh.
router.get('/messages', auth, async (req, res) => {
  try {
    const messages = await ChatMessage.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    messages.reverse(); // oldest -> newest for display
    res.json(messages);
  } catch (err) {
    console.error('chat history error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
