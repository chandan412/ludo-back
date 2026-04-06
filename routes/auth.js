const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const User    = require('../models/User');
const { auth } = require('../middleware/auth');

const generateToken        = (id, sessionToken) =>
  jwt.sign({ id, sessionToken }, process.env.JWT_SECRET, { expiresIn: '7d' });
const generateSessionToken = () => crypto.randomBytes(32).toString('hex');

// In-memory reset token store (15 min expiry)
const resetTokens = new Map();

// ── Register ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { username, email, phone, password } = req.body;
    if (!username || !email || !phone || !password)
      return res.status(400).json({ message: 'All fields are required' });

    const exists = await User.findOne({ $or: [{ email }, { username }, { phone }] });
    if (exists) {
      if (exists.email === email)       return res.status(400).json({ message: 'Email already registered' });
      if (exists.username === username) return res.status(400).json({ message: 'Username taken' });
      if (exists.phone === phone)       return res.status(400).json({ message: 'Phone already registered' });
    }

    const sessionToken = generateSessionToken();
    const user  = await User.create({ username, email, phone, password, sessionToken });
    const token = generateToken(user._id, sessionToken);
    res.status(201).json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ── Register Admin ────────────────────────────────────────
router.post('/register-admin', async (req, res) => {
  try {
    const { username, email, phone, password, adminSecret } = req.body;
    if (adminSecret !== process.env.ADMIN_SECRET)
      return res.status(403).json({ message: 'Invalid admin secret' });

    const exists = await User.findOne({ $or: [{ email }, { username }, { phone }] });
    if (exists) return res.status(400).json({ message: 'User already exists' });

    const sessionToken = generateSessionToken();
    const user  = await User.create({ username, email, phone, password, role: 'admin', sessionToken });
    const token = generateToken(user._id, sessionToken);
    res.status(201).json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ── Login ─────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { emailOrPhone, password } = req.body;
    if (!emailOrPhone || !password)
      return res.status(400).json({ message: 'Email/phone and password required' });

    const user = await User.findOne({
      $or: [{ email: emailOrPhone.toLowerCase() }, { phone: emailOrPhone }]
    });
    if (!user)      return res.status(400).json({ message: 'Invalid credentials' });
    if (user.isBanned) return res.status(403).json({ message: 'Your account has been banned. Contact support.' });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const sessionToken = generateSessionToken();
    user.sessionToken  = sessionToken;
    await user.save();

    const token = generateToken(user._id, sessionToken);
    res.json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ── Me ────────────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── Forgot Password Step 1: Verify phone + email ──────────
// If match found → return resetToken
// If no match    → frontend shows "Contact Admin" button
router.post('/forgot-verify', async (req, res) => {
  try {
    const { phone, email } = req.body;
    if (!phone || !email)
      return res.status(400).json({ message: 'Phone and email are required' });

    const user = await User.findOne({
      phone: phone.trim(),
      email: email.trim().toLowerCase(),
    });

    if (!user)
      return res.status(404).json({
        message: 'No account found with this phone and email.',
        contactAdmin: true, // frontend uses this to show WhatsApp button
      });

    if (user.isBanned)
      return res.status(403).json({ message: 'Your account has been banned. Contact support.' });

    // Generate reset token valid 15 minutes
    const resetToken = crypto.randomBytes(32).toString('hex');
    resetTokens.set(resetToken, {
      userId:    user._id.toString(),
      expiresAt: Date.now() + 15 * 60 * 1000,
    });

    // Clean up expired tokens
    for (const [key, val] of resetTokens.entries()) {
      if (Date.now() > val.expiresAt) resetTokens.delete(key);
    }

    res.json({ resetToken, message: 'Identity verified. You can now reset your password.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── Forgot Password Step 2: Set new password ─────────────
router.post('/forgot-reset', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword)
      return res.status(400).json({ message: 'Token and new password required' });
    if (newPassword.length < 6)
      return res.status(400).json({ message: 'Password must be at least 6 characters' });

    const tokenData = resetTokens.get(resetToken);
    if (!tokenData || Date.now() > tokenData.expiresAt) {
      resetTokens.delete(resetToken);
      return res.status(400).json({ message: 'Reset session expired. Please start over.' });
    }

    const user = await User.findById(tokenData.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.password = newPassword; // pre-save hook hashes it
    await user.save();
    resetTokens.delete(resetToken);

    res.json({ message: 'Password reset successfully! Please login with your new password.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── Admin: Reset player password ─────────────────────────
router.post('/admin-reset-password', async (req, res) => {
  try {
    const { adminSecret, phone, newPassword } = req.body;
    if (adminSecret !== process.env.ADMIN_SECRET)
      return res.status(403).json({ message: 'Invalid admin secret' });
    if (!phone || !newPassword)
      return res.status(400).json({ message: 'Phone and new password required' });

    const user = await User.findOne({ phone: phone.trim() });
    if (!user) return res.status(404).json({ message: 'Player not found' });

    user.password = newPassword;
    await user.save();
    res.json({ message: `Password reset for ${user.username}` });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
