const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { adminAuth } = require('../middleware/auth');

const settingSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: String
});
const Setting = mongoose.model('Setting', settingSchema);

// ─── Helper ───────────────────────────────────────────────────────────────────
async function getSetting(key) {
  const s = await Setting.findOne({ key });
  return s?.value || null;
}
async function setSetting(key, value) {
  return Setting.findOneAndUpdate({ key }, { key, value }, { upsert: true, new: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  QR CODE
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/settings/qr-code — public
router.get('/qr-code', async (req, res) => {
  try {
    res.json({ qrCode: await getSetting('payment_qr') });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// POST /api/settings/qr-code — admin only
router.post('/qr-code', adminAuth, async (req, res) => {
  try {
    const { qrCode } = req.body;
    if (!qrCode) return res.status(400).json({ message: 'QR code image required' });
    await setSetting('payment_qr', qrCode);
    res.json({ message: 'QR code updated successfully' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  WHATSAPP SUPPORT NUMBER
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/settings/whatsapp — public
router.get('/whatsapp', async (req, res) => {
  try {
    res.json({ whatsapp: await getSetting('whatsapp_number') });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// POST /api/settings/whatsapp — admin only
router.post('/whatsapp', adminAuth, async (req, res) => {
  try {
    const { whatsapp } = req.body;
    if (!whatsapp) return res.status(400).json({ message: 'WhatsApp number required' });
    await setSetting('whatsapp_number', whatsapp);
    res.json({ message: 'WhatsApp number updated successfully' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  APK DOWNLOAD URL
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/settings/apk-url — public
router.get('/apk-url', async (req, res) => {
  try {
    res.json({ apkUrl: await getSetting('apk_url') });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// GET /api/settings/apk — alias (some clients call this)
router.get('/apk', async (req, res) => {
  try {
    res.json({ apkUrl: await getSetting('apk_url') });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// POST /api/settings/apk-url — admin only
router.post('/apk-url', adminAuth, async (req, res) => {
  try {
    const { apkUrl } = req.body;
    if (!apkUrl) return res.status(400).json({ message: 'APK URL required' });
    await setSetting('apk_url', apkUrl);
    res.json({ message: 'APK URL updated successfully' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PLATFORM FEE PERCENT  (bonus — lets admin change fee without redeploy)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/settings/platform-fee — public
router.get('/platform-fee', async (req, res) => {
  try {
    const fee = await getSetting('platform_fee_percent');
    res.json({ platformFeePercent: fee ? parseFloat(fee) : 5 });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// POST /api/settings/platform-fee — admin only
router.post('/platform-fee', adminAuth, async (req, res) => {
  try {
    const { percent } = req.body;
    if (percent === undefined || percent < 0 || percent > 50)
      return res.status(400).json({ message: 'Percent must be 0–50' });
    await setSetting('platform_fee_percent', String(percent));
    res.json({ message: `Platform fee updated to ${percent}%` });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
