const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth } = require('../middleware/auth');

const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

// ── REGISTER ──────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { username, email, phone, password } = req.body;
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

    const user = await User.create({ username: usernameTrimmed, email: emailLower, phone: phoneTrimmed, password });
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

module.exports = router;
