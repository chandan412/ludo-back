const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { adminAuth } = require('../middleware/auth');
 
// Simple Setting schema
const settingSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: String
});
const Setting = mongoose.model('Setting', settingSchema);

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

module.exports = router;

// GET /api/settings/apk — public, returns APK download link (or null if not set)
router.get('/apk', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'apk_url' });
    res.json({ apkUrl: setting?.value || null });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/settings/apk — admin only, set APK download URL
router.post('/apk', adminAuth, async (req, res) => {
  try {
    const { apkUrl } = req.body;
    if (!apkUrl) return res.status(400).json({ message: 'APK URL required' });
    await Setting.findOneAndUpdate(
      { key: 'apk_url' },
      { key: 'apk_url', value: apkUrl },
      { upsert: true, new: true }
    );
    res.json({ message: 'APK URL updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});
