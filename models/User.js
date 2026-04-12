const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { adminAuth } = require('../middleware/auth');

const settingSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: String
});
const Setting = mongoose.model('Setting', settingSchema);

async function getSetting(key) {
  const s = await Setting.findOne({ key });
  return s?.value || null;
}
async function setSetting(key, value) {
  return Setting.findOneAndUpdate({ key }, { key, value }, { upsert: true, new: true });
}

// Extract value from body regardless of field name used
function extractValue(body) {
  return body.whatsapp      ??
         body.number        ??
         body.whatsappNumber??
         body.apkUrl        ??
         body.apk_url       ??
         body.apkURL        ??
         body.url           ??
         body.qrCode        ??
         body.value         ??
         body.data          ??
         null;
}

// ═══ QR CODE ══════════════════════════════════════════════════════════════════
router.get('/qr-code', async (req, res) => {
  try { res.json({ qrCode: await getSetting('payment_qr') }); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.post('/qr-code', adminAuth, async (req, res) => {
  try {
    const val = req.body.qrCode || req.body.value || extractValue(req.body);
    if (!val) return res.status(400).json({ message: 'QR code image required', received: Object.keys(req.body) });
    await setSetting('payment_qr', val);
    res.json({ message: 'QR code updated successfully' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ═══ WHATSAPP ══════════════════════════════════════════════════════════════════
router.get('/whatsapp', async (req, res) => {
  try { res.json({ whatsapp: await getSetting('whatsapp_number') }); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.post('/whatsapp', adminAuth, async (req, res) => {
  try {
    const val = req.body.whatsapp || req.body.number || req.body.whatsappNumber || req.body.value || extractValue(req.body);
    if (!val) return res.status(400).json({ message: 'WhatsApp number required', received: Object.keys(req.body) });
    await setSetting('whatsapp_number', String(val).trim());
    res.json({ message: 'WhatsApp number updated successfully' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ═══ APK URL ══════════════════════════════════════════════════════════════════
router.get('/apk-url', async (req, res) => {
  try { res.json({ apkUrl: await getSetting('apk_url') }); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.get('/apk', async (req, res) => {
  try { res.json({ apkUrl: await getSetting('apk_url') }); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.post('/apk-url', adminAuth, async (req, res) => {
  try {
    const val = req.body.apkUrl || req.body.url || req.body.apk_url || req.body.apkURL || req.body.value || extractValue(req.body);
    if (!val) return res.status(400).json({ message: 'APK URL required', received: Object.keys(req.body) });
    await setSetting('apk_url', String(val).trim());
    res.json({ message: 'APK URL updated successfully' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.post('/apk', adminAuth, async (req, res) => {
  try {
    const val = req.body.apkUrl || req.body.url || req.body.apk_url || req.body.value || extractValue(req.body);
    if (!val) return res.status(400).json({ message: 'APK URL required', received: Object.keys(req.body) });
    await setSetting('apk_url', String(val).trim());
    res.json({ message: 'APK URL updated successfully' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ═══ FCM TOKEN ════════════════════════════════════════════════════════════════
router.post('/fcm-token', async (req, res) => {
  try {
    const { token, userId } = req.body;
    if (!token) return res.status(400).json({ message: 'Token required' });
    if (userId) await setSetting(`fcm_token_${userId}`, token);
    res.json({ message: 'FCM token registered' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ═══ PLATFORM FEE ════════════════════════════════════════════════════════════
router.get('/platform-fee', async (req, res) => {
  try {
    const fee = await getSetting('platform_fee_percent');
    res.json({ platformFeePercent: fee ? parseFloat(fee) : 5 });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.post('/platform-fee', adminAuth, async (req, res) => {
  try {
    const percent = req.body.percent ?? req.body.value ?? req.body.platformFeePercent;
    if (percent === undefined || percent === null || percent < 0 || percent > 50)
      return res.status(400).json({ message: 'Percent must be 0–50' });
    await setSetting('platform_fee_percent', String(percent));
    res.json({ message: `Platform fee updated to ${percent}%` });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
