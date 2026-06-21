const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const crypto = require('crypto');
const { auth } = require('../middleware/auth');
const lineverify = require('../utils/lineverify');

const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

// ✅ Referral config + unique-code generator. Codes are 6 chars from an unambiguous
// alphabet (no 0/O/1/I), checked against existing users so they never collide.
const REFERRAL_BONUS = parseInt(process.env.REFERRAL_BONUS || 50, 10);
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function generateUniqueReferralCode() {
  for (let attempt = 0; attempt < 12; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += REF_ALPHABET[crypto.randomInt(0, REF_ALPHABET.length)];
    const clash = await User.findOne({ referralCode: code }).select('_id');
    if (!clash) return code;
  }
  return 'R' + Date.now().toString(36).toUpperCase().slice(-7); // extremely unlikely fallback
}

// ── REGISTER ──────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { username, email, phone, password, referralCode } = req.body;
    if (!username || !email || !phone || !password)
      return res.status(400).json({ message: 'All fields are required' });

    const emailLower     = email.toLowerCase().trim();
    const phoneTrimmed   = phone.trim();
    const usernameTrimmed = username.trim();

    const exists = await User.findOne({
      $or: [{ email: emailLower }, { username: usernameTrimmed }, { phone: phoneTrimmed }]
    });
    if (exists) {
      if (exists.email    === emailLower)     return res.status(400).json({ message: 'Email already registered' });
      if (exists.username === usernameTrimmed) return res.status(400).json({ message: 'Username taken' });
      if (exists.phone    === phoneTrimmed)   return res.status(400).json({ message: 'Phone already registered' });
    }

    // ✅ REFERRAL: resolve the referrer if a code was entered. The new account does
    // not exist yet, so self-referral is impossible here. An unknown/invalid code is
    // simply ignored — registration still succeeds, just with no bonus paid.
    let referrer = null;
    const enteredCode = (referralCode || '').toString().trim().toUpperCase();
    if (enteredCode) referrer = await User.findOne({ referralCode: enteredCode });

    // ✅ Every new user gets their own unique referral code.
    const myReferralCode = await generateUniqueReferralCode();

    const user = await User.create({
      username: usernameTrimmed,
      email: emailLower,
      phone: phoneTrimmed,
      password,
      referralCode: myReferralCode,
      referredBy: referrer ? referrer._id : null,
    });

    // ✅ Pay the REFERRER ₹50 as BONUS — playable but NOT withdrawable (credited into
    // `balance` and simultaneously tracked in `bonusBalance`). This kills the "refer my own
    // fake accounts and withdraw the reward" fraud: the ₹50 can be played but never cashed
    // out. One credit per signup, logged as 'referral'.
    // Non-fatal: the new account already exists; never fail signup over a bonus write.
    if (referrer) {
      try {
        const before = referrer.balance;
        referrer.balance         += REFERRAL_BONUS;
        // ✅ Tag this credit as BONUS — it sits inside `balance` (so it's playable) but is
        // NOT withdrawable. Withdrawals subtract bonusBalance; see wallet.js.
        referrer.bonusBalance     = (referrer.bonusBalance || 0) + REFERRAL_BONUS;
        referrer.referralCount    = (referrer.referralCount || 0) + 1;
        referrer.referralEarnings = (referrer.referralEarnings || 0) + REFERRAL_BONUS;
        await referrer.save();
        await Transaction.create({
          user: referrer._id,
          type: 'referral',
          amount: REFERRAL_BONUS,
          balanceBefore: before,
          balanceAfter: referrer.balance,
          status: 'completed',
        });
      } catch (refErr) {
        console.error('referral credit error:', refErr);
      }
    }

    const token = generateToken(user._id);
    res.status(201).json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ── REGISTER ADMIN ────────────────────────────────────────────────────────────
router.post('/register-admin', async (req, res) => {
  try {
    const { username, email, phone, password, adminSecret } = req.body;
    if (adminSecret !== process.env.ADMIN_SECRET)
      return res.status(403).json({ message: 'Invalid admin secret' });

    const emailLower = email.toLowerCase().trim();
    const exists = await User.findOne({
      $or: [{ email: emailLower }, { username: username.trim() }, { phone: phone.trim() }]
    });
    if (exists) return res.status(400).json({ message: 'User already exists' });

    const user = await User.create({ username: username.trim(), email: emailLower, phone: phone.trim(), password, role: 'admin' });
    const token = generateToken(user._id);
    res.status(201).json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { emailOrPhone, password } = req.body;
    if (!emailOrPhone || !password)
      return res.status(400).json({ message: 'Email/phone and password required' });

    const input = emailOrPhone.trim();

    const user = await User.findOne({
      $or: [
        { email: input.toLowerCase() },
        { phone: input },
        { phone: input.toLowerCase() },
      ]
    });

    if (!user)   return res.status(400).json({ message: 'No account found with this email or phone' });
    if (user.isBanned)  return res.status(403).json({ message: 'Your account has been banned. Contact support.' });
    if (!user.isActive) return res.status(403).json({ message: 'Account is inactive. Contact support.' });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ message: 'Incorrect password' });

    const token = generateToken(user._id);
    res.json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ── GET ME ────────────────────────────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ message: 'Account not found' });
    // ✅ Backfill a referral code for accounts created before referrals existed, so
    // every user can share and earn. One-time, on the first /me after this update.
    if (!user.referralCode) {
      try {
        user.referralCode = await generateUniqueReferralCode();
        await user.save();
      } catch (e) {
        console.error('referral backfill error:', e);
      }
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── FCM TOKEN ─────────────────────────────────────────────────────────────────
// ✅ Firebase calls this to register push notification tokens per user
router.post('/fcm-token', auth, async (req, res) => {
  try {
    const { token: fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ message: 'FCM token required' });
    // Store on user document (add fcmToken field to User schema if needed)
    await User.findByIdAndUpdate(req.user._id, { fcmToken });
    res.json({ message: 'FCM token saved' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── FORGOT PASSWORD: STEP 1 — VERIFY IDENTITY ──────────────────────────────────
// User provides registered phone + email. If BOTH match the same account, we issue
// a short-lived (15-min) reset token. No email/SMS is sent — verification is by
// matching the two stored fields, then the user sets a new password directly.
router.post('/forgot-verify', async (req, res) => {
  try {
    const { phone, email } = req.body;
    if (!phone || !email) {
      return res.status(400).json({ message: 'Phone and email are both required' });
    }

    const normEmail = String(email).trim().toLowerCase();
    const normPhone = String(phone).trim();

    // Both must belong to the SAME user
    const user = await User.findOne({ phone: normPhone, email: normEmail });
    if (!user) {
      return res.status(404).json({
        message: "Phone and email don't match any account",
        contactAdmin: true,
      });
    }
    if (user.isBanned) {
      return res.status(403).json({ message: 'Account is banned. Contact admin.' });
    }

    // Short-lived token scoped specifically to password reset for this user.
    // The `pwReset` flag + `pwHash` binding ensures it can't be used as a login token
    // and is invalidated the moment the password actually changes.
    const resetToken = jwt.sign(
      { id: user._id, pwReset: true, pwHash: user.password.slice(-10) },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.json({ resetToken, message: 'Identity verified' });
  } catch (err) {
    console.error('forgot-verify error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── FORGOT PASSWORD: STEP 2 — RESET ─────────────────────────────────────────────
router.post('/forgot-reset', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword) {
      return res.status(400).json({ message: 'Reset token and new password required' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    let decoded;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Reset session expired. Please start over.' });
    }
    if (!decoded.pwReset) {
      return res.status(401).json({ message: 'Invalid reset token' });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: 'Account not found' });

    // ✅ Bind the token to the password it was issued for — if the password already
    // changed since the token was minted, reject (prevents token replay).
    if (decoded.pwHash !== user.password.slice(-10)) {
      return res.status(401).json({ message: 'Reset link already used. Please start over.' });
    }

    // The User model's pre-save hook hashes this automatically.
    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('forgot-reset error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── PHONE VERIFICATION (LineVerify) ─────────────────────────────────────────────
// Step 1 — START. Verify the number SAVED ON THE ACCOUNT (never an arbitrary number the
// user types), so a fake / non-WhatsApp number simply can't pass. Returns the hosted
// verify_url for the frontend popup. If the feature is switched off (no key / disabled),
// we report enabled:false and the frontend just lets the user through.
router.post('/phone/start', auth, async (req, res) => {
  try {
    if (!lineverify.isEnabled()) return res.json({ enabled: false });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Account not found' });
    if (user.phoneVerified) return res.json({ enabled: true, alreadyVerified: true });

    const result = await lineverify.startVerification(user.phone, { userId: String(user._id) });
    res.json({
      enabled: true,
      id: result.id,
      verify_url: result.verify_url,
      whatsapp_url: result.whatsapp_url || null,
    });
  } catch (err) {
    console.error('phone/start error:', err.message);
    res.status(502).json({ message: 'Could not start verification. Please try again.' });
  }
});

// Step 3 — CONFIRM. The browser only hands us a verification_id; we confirm SERVER-SIDE
// with our API key, and ONLY mark the user verified if the confirmed number MATCHES the
// number on the account. This is what stops a fraudster from verifying some other real
// number to bless an account that carries a fake one.
router.post('/phone/confirm', auth, async (req, res) => {
  try {
    if (!lineverify.isEnabled()) return res.json({ verified: true, enabled: false });

    const { verification_id } = req.body;
    if (!verification_id) return res.status(400).json({ message: 'verification_id required' });

    const result = await lineverify.confirmVerification(verification_id);

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Account not found' });

    const confirmedE164 = lineverify.toE164(result.phone);
    const accountE164   = lineverify.toE164(user.phone);
    if (!result.verified || confirmedE164 !== accountE164) {
      return res.status(400).json({
        verified: false,
        message: 'Verification did not match your registered number. Please verify the number on your account.',
      });
    }

    user.phoneVerified   = true;
    user.phoneVerifiedAt = new Date();
    await user.save();

    res.json({ verified: true });
  } catch (err) {
    console.error('phone/confirm error:', err.message);
    res.status(502).json({ message: 'Could not confirm verification. Please try again.' });
  }
});

module.exports = router;
