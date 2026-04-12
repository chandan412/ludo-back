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

    // ✅ Always compare lowercased email so casing never causes a mismatch
    const emailLower = email.toLowerCase().trim();
    const phoneTrimmed = phone.trim();
    const usernameTrimmed = username.trim();

    const exists = await User.findOne({
      $or: [
        { email: emailLower },
        { username: usernameTrimmed },
        { phone: phoneTrimmed }
      ]
    });

    if (exists) {
      if (exists.email === emailLower)         return res.status(400).json({ message: 'Email already registered' });
      if (exists.username === usernameTrimmed) return res.status(400).json({ message: 'Username taken' });
      if (exists.phone === phoneTrimmed)       return res.status(400).json({ message: 'Phone already registered' });
    }

    const user = await User.create({
      username: usernameTrimmed,
      email:    emailLower,
      phone:    phoneTrimmed,
      password,
    });
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

    const user = await User.create({
      username: username.trim(),
      email:    emailLower,
      phone:    phone.trim(),
      password,
      role: 'admin',
    });
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

    // ✅ Trim whitespace — leading/trailing spaces cause "Invalid credentials"
    const input = emailOrPhone.trim();

    // ✅ Try email (lowercased) AND raw phone AND lowercased phone
    // Covers: user types with spaces, wrong case, or phone with/without country code
    const user = await User.findOne({
      $or: [
        { email: input.toLowerCase() },
        { phone: input },
        { phone: input.toLowerCase() },
      ]
    });

    if (!user)
      return res.status(400).json({ message: 'No account found with this email or phone' });

    if (user.isBanned)
      return res.status(403).json({ message: 'Your account has been banned. Contact support.' });

    if (!user.isActive)
      return res.status(403).json({ message: 'Account is inactive. Contact support.' });

    const isMatch = await user.comparePassword(password);
    if (!isMatch)
      return res.status(400).json({ message: 'Incorrect password' });

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

module.exports = router;
