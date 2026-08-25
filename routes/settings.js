const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { adminAuth } = require('../middleware/auth');
const { getWithdrawLimits, saveWithdrawLimits } = require('../utils/withdrawLimit');
 
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

// ── WITHDRAWAL REQUEST RATE LIMIT ───────────────────────────────────────────
// How many withdrawal requests a player may submit per rolling window.
// Enforcement lives in utils/withdrawLimit.js; these endpoints only read and
// write the numbers.

// GET /api/settings/withdraw-limits — admin only
router.get('/withdraw-limits', adminAuth, async (req, res) => {
  try {
    const limits = await getWithdrawLimits(true);
    res.json(limits);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/settings/withdraw-limits — admin only
router.put('/withdraw-limits', adminAuth, async (req, res) => {
  try {
    const { maxRequests, windowHours } = req.body;

    if (maxRequests !== undefined) {
      const n = Number(maxRequests);
      if (!Number.isInteger(n) || n < 0 || n > 100)
        return res.status(400).json({ message: 'Requests allowed must be a whole number between 0 and 100' });
    }
    if (windowHours !== undefined) {
      const n = Number(windowHours);
      // Capped at a week. A window measured in months is indistinguishable from
      // "withdrawals are switched off", and should be done deliberately by
      // another means rather than by typing a large number here.
      if (!Number.isInteger(n) || n < 1 || n > 168)
        return res.status(400).json({ message: 'Window must be a whole number of hours between 1 and 168' });
    }

    const updated = await saveWithdrawLimits({ maxRequests, windowHours });
    res.json({ message: 'Withdrawal limits updated', ...updated });
  } catch (err) {
    console.error('withdraw-limits save error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
