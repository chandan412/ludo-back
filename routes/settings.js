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

// GET /api/settings/whatsapp
router.get('/whatsapp', async (req, res) => {
  try {
    const s = await Setting.findOne({ key: 'whatsapp_number' });
    res.json({ number: s?.value || '' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

router.post('/whatsapp', adminAuth, async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ message: 'Number required' });
    await Setting.findOneAndUpdate({ key: 'whatsapp_number' }, { key: 'whatsapp_number', value: number }, { upsert: true });
    res.json({ message: 'Saved' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// GET /api/settings/apk-url
router.get('/apk-url', async (req, res) => {
  try {
    const s = await Setting.findOne({ key: 'apk_url' });
    res.json({ url: s?.value || '' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

router.post('/apk-url', adminAuth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ message: 'URL required' });
    await Setting.findOneAndUpdate({ key: 'apk_url' }, { key: 'apk_url', value: url }, { upsert: true });
    res.json({ message: 'Saved' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
