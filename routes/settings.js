const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { adminAuth } = require('../middleware/auth');
const { getWithdrawLimits, saveWithdrawLimits } = require('../utils/withdrawLimit');
const { getSignupBonus, saveSignupBonus } = require('../utils/signupBonus');
const { getAmountLimits, saveAmountLimits } = require('../utils/amountLimits');
 
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

// ── TELEGRAM GROUP LINK ─────────────────────────────────────────────────────
// Shown on the Login page. Public GET so the page can render it before anyone
// has signed in; admin-only POST to change it.

// ✅ Normalise whatever the admin pastes into a working https link.
//
// Telegram links arrive in several shapes and most of them are broken if used
// as-is in an href on an https site:
//
//   @ludoking              → a username, not a URL
//   ludoking               → bare username
//   t.me/ludoking          → no scheme; the browser treats it as a relative
//                            path and sends the player to ludo-king.in/t.me/...
//   http://t.me/ludoking   → blocked as mixed content, button silently dead
//   https://t.me/+AbC123   → private group invite, already correct
//
// Every one of those fails SILENTLY — the button renders and does nothing, so
// you would only find out from a player complaining. Normalising here means the
// stored value is always a real link.
function normalizeTelegram(input) {
  let s = String(input || '').trim();
  if (!s) return '';

  // Only trim — deliberately NOT stripping internal whitespace. Collapsing
  // "random text here" into "randomtexthere" would make junk input look like a
  // valid username and get silently saved as https://t.me/randomtexthere.
  // Leaving the spaces in means it fails the username test below, falls through
  // to validation, and the admin gets told what's wrong.

  // Bare @username or username → build the canonical URL.
  if (s.startsWith('@')) return 'https://t.me/' + s.slice(1);
  if (!/^https?:\/\//i.test(s) && !/^(t|telegram)\.me\//i.test(s)) {
    // Only treat it as a username if it looks like one — otherwise leave it
    // alone so validation below can reject it with a useful message.
    if (/^[A-Za-z0-9_+]{3,64}$/.test(s)) return 'https://t.me/' + s;
  }

  // Add or upgrade the scheme. http:// is forced to https:// because the site
  // is served over https and a plain http link is blocked by the browser.
  if (/^http:\/\//i.test(s)) s = 'https://' + s.slice(7);
  else if (!/^https:\/\//i.test(s)) s = 'https://' + s;

  return s;
}

function isValidTelegram(url) {
  return /^https:\/\/(t\.me|telegram\.me|telegram\.dog)\/.+/i.test(url);
}

// GET /api/settings/telegram — public
router.get('/telegram', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'telegram_url' });
    res.json({ url: setting?.value || '' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/settings/telegram — admin only
router.post('/telegram', adminAuth, async (req, res) => {
  try {
    const raw = req.body?.url;

    // Empty is legitimate — it's how you HIDE the button, so it must not be
    // treated as a validation failure.
    if (!String(raw || '').trim()) {
      await Setting.findOneAndUpdate(
        { key: 'telegram_url' },
        { key: 'telegram_url', value: '' },
        { upsert: true, new: true }
      );
      return res.json({ message: 'Telegram link removed', url: '' });
    }

    const url = normalizeTelegram(raw);
    if (!isValidTelegram(url)) {
      return res.status(400).json({
        message: 'Enter a valid Telegram link, e.g. https://t.me/yourgroup or @yourgroup',
      });
    }

    await Setting.findOneAndUpdate(
      { key: 'telegram_url' },
      { key: 'telegram_url', value: url },
      { upsert: true, new: true }
    );
    // Return the NORMALISED value so the admin panel shows what was actually
    // stored, not what they typed — otherwise the input keeps showing "@group"
    // while the database holds the full URL.
    res.json({ message: 'Telegram link updated', url });
  } catch (err) {
    console.error('telegram save error:', err);
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

// ── NEW PLAYER SIGNUP BONUS ─────────────────────────────────────────────────

// GET /api/settings/signup-bonus — PUBLIC.
// Lets the register / login page advertise the bonus ("Sign up and get ₹50 to
// play with"). Public on purpose: it is a marketing number, and hard-coding it
// in the frontend would mean the banner keeps promising an old amount after the
// admin changes it.
router.get('/signup-bonus', async (req, res) => {
  try {
    const s = await getSignupBonus();
    res.json({ enabled: s.enabled, amount: s.amount });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/settings/signup-bonus/admin — admin only
router.get('/signup-bonus/admin', adminAuth, async (req, res) => {
  try {
    const s = await getSignupBonus(true);
    res.json(s);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/settings/signup-bonus — admin only
router.put('/signup-bonus', adminAuth, async (req, res) => {
  try {
    const { enabled, amount } = req.body;

    if (amount !== undefined) {
      const n = Number(amount);
      if (!Number.isInteger(n) || n < 0)
        return res.status(400).json({ message: 'Bonus amount must be a whole number of 0 or more' });
      // Sanity ceiling. This value is paid automatically to every account that
      // registers, with no human in the loop — a mistyped extra digit here is
      // not caught by anything downstream.
      if (n > 10000)
        return res.status(400).json({ message: 'Bonus amount looks too large — maximum is 10,000' });
    }

    const updated = await saveSignupBonus({ enabled, amount });
    res.json({ message: 'Signup bonus updated', ...updated });
  } catch (err) {
    console.error('signup-bonus save error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── AMOUNT LIMITS (min deposit / min bet / tiered min withdrawal) ───────────

// GET /api/settings/amount-limits — PUBLIC.
// The wallet and lobby screens need these to show correct figures. Hard-coding
// "Min: ₹100" in the frontend would keep displaying an old number the moment
// you change it here, and a wrong minimum on screen produces a rejected
// request the player can't explain.
router.get('/amount-limits', async (req, res) => {
  try {
    const l = await getAmountLimits();
    res.json(l);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/settings/amount-limits/admin — admin only, cache-bypassing.
router.get('/amount-limits/admin', adminAuth, async (req, res) => {
  try {
    res.json(await getAmountLimits(true));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/settings/amount-limits — admin only
router.put('/amount-limits', adminAuth, async (req, res) => {
  try {
    const { minDeposit, minBet, minWithdraw, withdrawTierAfter, minWithdrawTier } = req.body;

    // withdrawTierAfter may legitimately be 0 (tiering off); everything else
    // must be at least 1. A minimum of 0 is not a minimum.
    const rules = [
      ['minDeposit',        minDeposit,        1],
      ['minBet',            minBet,            1],
      ['minWithdraw',       minWithdraw,       1],
      ['withdrawTierAfter', withdrawTierAfter, 0],
      ['minWithdrawTier',   minWithdrawTier,   1],
    ];
    for (const [name, val, floor] of rules) {
      if (val === undefined) continue;
      const n = Number(val);
      if (!Number.isInteger(n) || n < floor)
        return res.status(400).json({ message: `${name} must be a whole number of ${floor} or more` });
      if (n > 1000000)
        return res.status(400).json({ message: `${name} is unrealistically large` });
    }

    // A raised tier that is BELOW the base would silently do nothing — the
    // resolver takes the base in that case. Catch it here so you find out at
    // save time rather than wondering why the setting has no effect.
    const base = minWithdraw !== undefined ? Number(minWithdraw) : (await getAmountLimits()).minWithdraw;
    const tier = minWithdrawTier !== undefined ? Number(minWithdrawTier) : (await getAmountLimits()).minWithdrawTier;
    const after = withdrawTierAfter !== undefined ? Number(withdrawTierAfter) : (await getAmountLimits()).withdrawTierAfter;
    if (after > 0 && tier <= base) {
      return res.status(400).json({
        message: `The raised withdrawal minimum (₹${tier}) must be higher than the base (₹${base}), otherwise it has no effect.`,
      });
    }

    const updated = await saveAmountLimits({ minDeposit, minBet, minWithdraw, withdrawTierAfter, minWithdrawTier });
    res.json({ message: 'Amount limits updated', ...updated });
  } catch (err) {
    console.error('amount-limits save error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── ANNOUNCEMENT BANNER ─────────────────────────────────────────────────────
// A pinned message shown to every player in chat. Stored as a Setting, so you
// change it from the admin panel with no redeploy.
//
// WHY A SETTING AND NOT A CHAT MESSAGE
// Posting an announcement as a normal chat message looks equivalent, but it
// scrolls away within minutes and ChatMessage has a 24h TTL index — the notice
// would delete itself. A pinned banner outside the message list stays put and
// stays visible, which is the whole point of an announcement.

// ✅ Push the change to every connected client immediately.
// Same fire-and-forget pattern as notifyAdmins() in routes/wallet.js: the row is
// already saved by the time this runs, so a socket problem must never turn a
// successful save into an error. Without this, players would only see a new
// announcement after a refresh — and the reason you post one is usually that
// something needs saying NOW.
function broadcastAnnouncement(req, payload) {
  try {
    const io = req.app.get('io');
    if (!io) return;   // not wired yet, or running under a test harness
    io.emit('announcement-updated', payload);
  } catch (e) {
    console.error('broadcastAnnouncement failed (non-fatal):', e.message);
  }
}

// GET /api/settings/announcement — public
router.get('/announcement', async (req, res) => {
  try {
    const [textRow, enabledRow] = await Promise.all([
      Setting.findOne({ key: 'announcement_text' }),
      Setting.findOne({ key: 'announcement_enabled' }),
    ]);
    const text = textRow?.value || '';
    // Enabled defaults to FALSE. A banner that switches itself on at deploy
    // time and shows an empty box to every player is not a good surprise.
    const enabled = enabledRow?.value === 'true';
    res.json({ text, enabled: enabled && !!text.trim() });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/settings/announcement/admin — admin only.
// Returns the RAW stored values, unlike the public route which hides the text
// when the banner is off. You need to see your draft in order to edit it.
router.get('/announcement/admin', adminAuth, async (req, res) => {
  try {
    const [textRow, enabledRow] = await Promise.all([
      Setting.findOne({ key: 'announcement_text' }),
      Setting.findOne({ key: 'announcement_enabled' }),
    ]);
    res.json({
      text: textRow?.value || '',
      enabled: enabledRow?.value === 'true',
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/settings/announcement — admin only
router.post('/announcement', adminAuth, async (req, res) => {
  try {
    const rawText = String(req.body?.text ?? '').trim();
    const enabled = Boolean(req.body?.enabled);

    // 500 chars is about six lines on a phone. Longer than that and the banner
    // starts eating the chat it is pinned above.
    if (rawText.length > 500) {
      return res.status(400).json({ message: 'Announcement must be 500 characters or less' });
    }

    await Promise.all([
      Setting.findOneAndUpdate(
        { key: 'announcement_text' },
        { key: 'announcement_text', value: rawText },
        { upsert: true, new: true }
      ),
      Setting.findOneAndUpdate(
        { key: 'announcement_enabled' },
        { key: 'announcement_enabled', value: String(enabled) },
        { upsert: true, new: true }
      ),
    ]);

    const live = { text: rawText, enabled: enabled && !!rawText };
    broadcastAnnouncement(req, live);

    res.json({ message: 'Announcement updated', text: rawText, enabled, live: live.enabled });
  } catch (err) {
    console.error('announcement save error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
