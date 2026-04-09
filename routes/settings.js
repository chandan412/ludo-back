const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, adminAuth } = require('../middleware/auth');

const settingSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: String
});
let Setting;
try { Setting = mongoose.model('Setting'); }
catch { Setting = mongoose.model('Setting', settingSchema); }

// ── QR Code ──────────────────────────────────────────
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
    await Setting.findOneAndUpdate({ key: 'payment_qr' }, { key: 'payment_qr', value: qrCode }, { upsert: true });
    res.json({ message: 'QR code updated' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// ── APK Download URL ──────────────────────────────────
router.get('/apk', async (req, res) => {
  try {
    const s = await Setting.findOne({ key: 'apk_url' });
    res.json({ url: s?.value || null });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

router.post('/apk', adminAuth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ message: 'URL required' });
    await Setting.findOneAndUpdate({ key: 'apk_url' }, { key: 'apk_url', value: url }, { upsert: true });
    res.json({ message: 'APK URL updated' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// ── WhatsApp Support Number ───────────────────────────
router.get('/support-number', async (req, res) => {
  try {
    const s = await Setting.findOne({ key: 'support_number' });
    res.json({ number: s?.value || null });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

router.post('/support-number', adminAuth, async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ message: 'Number required' });
    await Setting.findOneAndUpdate({ key: 'support_number' }, { key: 'support_number', value: number }, { upsert: true });
    res.json({ message: 'Support number updated' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
