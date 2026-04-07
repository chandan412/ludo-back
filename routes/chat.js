// routes/chat.js — simple chat only, no game creation
const express = require('express');
const router  = express.Router();
const mongoose = require('mongoose');
const { auth } = require('../middleware/auth');

// ── Chat Message schema — auto-delete after 24 hours ──
const chatSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  text:     { type: String, required: true },
  createdAt:{ type: Date, default: Date.now, expires: 86400 }, // 24h TTL
});

let ChatMessage;
try { ChatMessage = mongoose.model('ChatMessage'); }
catch { ChatMessage = mongoose.model('ChatMessage', chatSchema); }

let _io = null;
function setIO(io) { _io = io; }

// GET /api/chat/messages — last 50 messages
router.get('/messages', auth, async (req, res) => {
  try {
    const msgs = await ChatMessage.find().sort({ createdAt: -1 }).limit(20).lean();
    res.json(msgs.reverse());
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// POST /api/chat/message — send a message
router.post('/message', auth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: 'Message required' });
    if (text.length > 150) return res.status(400).json({ message: 'Max 150 characters' });

    const msg = await ChatMessage.create({
      userId:   req.user._id,
      username: req.user.username,
      text:     text.trim(),
    });

    const payload = {
      _id:       msg._id,
      userId:    req.user._id.toString(),
      username:  req.user.username,
      text:      msg.text,
      createdAt: msg.createdAt,
    };

    if (_io) _io.emit('chat-message', payload);
    res.status(201).json(payload);
  } catch { res.status(500).json({ message: 'Server error' }); }
});

module.exports = { router, setIO };
