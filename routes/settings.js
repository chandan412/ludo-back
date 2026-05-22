const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { adminAuth } = require('../middleware/auth');
 
// Simple Setting schema
const settingSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: String
});
// ✅ Protect from OverwriteModelError on hot reload
const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema);

// GET /api/settings/qr-code — public, users can fetch QR
router.get('/qr-code', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'payment_qr' });
    res.json({ qrCode: setting?.value || null });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/settings/qr-code — admin only, upload new QR
router.post('/qr-code', adminAuth, async (req, res) => {
  try {
    const { qrCode } = req.body;
    if (!qrCode) return res.status(400).json({ message: 'QR code image required' });
    await Setting.findOneAndUpdate(
      { key: 'payment_qr' },
      { key: 'payment_qr', value: qrCode },
      { upsert: true, new: true }
    );
    res.json({ message: 'QR code updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── WHATSAPP SUPPORT NUMBER ─────────────────────────────────────────────────
// GET /api/settings/whatsapp — public, used by AdminPanel + recovery flows
router.get('/whatsapp', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'whatsapp_number' });
    res.json({ number: setting?.value || '' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/settings/whatsapp — admin only
router.post('/whatsapp', adminAuth, async (req, res) => {
  try {
    const { number } = req.body;
    const clean = String(number || '').replace(/[^0-9]/g, ''); // digits only for wa.me
    await Setting.findOneAndUpdate(
      { key: 'whatsapp_number' },
      { key: 'whatsapp_number', value: clean },
      { upsert: true, new: true }
    );
    res.json({ message: 'WhatsApp number updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/settings/support-number — public alias used by the Forgot Password page
router.get('/support-number', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'whatsapp_number' });
    res.json({ number: setting?.value || '' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── APK DOWNLOAD URL ────────────────────────────────────────────────────────
// GET /api/settings/apk-url — public
router.get('/apk-url', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'apk_url' });
    res.json({ url: setting?.value || '' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/settings/apk-url — admin only
router.post('/apk-url', adminAuth, async (req, res) => {
  try {
    const { url } = req.body;
    await Setting.findOneAndUpdate(
      { key: 'apk_url' },
      { key: 'apk_url', value: String(url || '').trim() },
      { upsert: true, new: true }
    );
    res.json({ message: 'APK URL updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
