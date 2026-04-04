const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, adminAuth } = require('../middleware/auth');

// ── Settings schema (key-value store) ──
const settingSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: String
});

let Setting;
try { Setting = mongoose.model('Setting'); }
catch { Setting = mongoose.model('Setting', settingSchema); }

// ── Support Ticket schema ──
const ticketSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:    { type: String, required: true },
  subject:     { type: String, required: true },
  message:     { type: String, required: true },
  status:      { type: String, enum: ['open', 'resolved'], default: 'open' },
  adminReply:  { type: String, default: '' },
  createdAt:   { type: Date, default: Date.now },
  resolvedAt:  { type: Date },
});

let Ticket;
try { Ticket = mongoose.model('Ticket'); }
catch { Ticket = mongoose.model('Ticket', ticketSchema); }

// ─────────────────────────────────────────
// QR Code
// ─────────────────────────────────────────
router.get('/qr-code', async (req, res) => {
  try {
    const s = await Setting.findOne({ key: 'payment_qr' });
    res.json({ qrCode: s?.value || null });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

router.post('/qr-code', adminAuth, async (req, res) => {
  try {
    const { qrCode } = req.body;
    if (!qrCode) return res.status(400).json({ message: 'QR code required' });
    await Setting.findOneAndUpdate(
      { key: 'payment_qr' }, { key: 'payment_qr', value: qrCode },
      { upsert: true, new: true }
    );
    res.json({ message: 'QR code updated' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// ─────────────────────────────────────────
// APK Download URL
// ─────────────────────────────────────────
// GET /api/settings/apk — public, players fetch the APK link
router.get('/apk', async (req, res) => {
  try {
    const s = await Setting.findOne({ key: 'apk_url' });
    res.json({ apkUrl: s?.value || null, apkVersion: s?.version || null });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// POST /api/settings/apk — admin sets APK download URL
router.post('/apk', adminAuth, async (req, res) => {
  try {
    const { apkUrl, apkVersion } = req.body;
    if (!apkUrl) return res.status(400).json({ message: 'APK URL required' });
    await Setting.findOneAndUpdate(
      { key: 'apk_url' },
      { key: 'apk_url', value: apkUrl, version: apkVersion || '' },
      { upsert: true, new: true }
    );
    res.json({ message: 'APK URL updated' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// ─────────────────────────────────────────
// Support Tickets
// ─────────────────────────────────────────
// POST /api/settings/support — player raises a ticket
router.post('/support', auth, async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!subject || !message)
      return res.status(400).json({ message: 'Subject and message required' });
    const ticket = await Ticket.create({
      user: req.user._id,
      username: req.user.username,
      subject,
      message,
    });
    res.status(201).json({ message: 'Support ticket submitted', ticket });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// GET /api/settings/support/my — player views their own tickets
router.get('/support/my', auth, async (req, res) => {
  try {
    const tickets = await Ticket.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json(tickets);
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// GET /api/settings/support/all — admin views all tickets
router.get('/support/all', adminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const query = status ? { status } : {};
    const tickets = await Ticket.find(query)
      .populate('user', 'username email phone')
      .sort({ createdAt: -1 });
    res.json(tickets);
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// PUT /api/settings/support/:id — admin replies and resolves ticket
router.put('/support/:id', adminAuth, async (req, res) => {
  try {
    const { adminReply, status } = req.body;
    const ticket = await Ticket.findByIdAndUpdate(
      req.params.id,
      {
        adminReply: adminReply || '',
        status: status || 'resolved',
        resolvedAt: new Date(),
      },
      { new: true }
    );
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    res.json({ message: 'Ticket updated', ticket });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
