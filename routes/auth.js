const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { auth } = require('../middleware/auth');

// Generate JWT with sessionToken embedded
const generateToken = (id, sessionToken) =>
  jwt.sign({ id, sessionToken }, process.env.JWT_SECRET, { expiresIn: '7d' });

// Generate a random session token
const generateSessionToken = () => crypto.randomBytes(32).toString('hex');

router.post('/register', async (req, res) => {
  try {
    const { username, email, phone, password } = req.body;
    if (!username || !email || !phone || !password)
      return res.status(400).json({ message: 'All fields are required' });

    const exists = await User.findOne({ $or: [{ email }, { username }, { phone }] });
    if (exists) {
      if (exists.email === email)     return res.status(400).json({ message: 'Email already registered' });
      if (exists.username === username) return res.status(400).json({ message: 'Username taken' });
      if (exists.phone === phone)     return res.status(400).json({ message: 'Phone already registered' });
    }

    const sessionToken = generateSessionToken();
    const user = await User.create({ username, email, phone, password, sessionToken });
    const token = generateToken(user._id, sessionToken);
    res.status(201).json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/register-admin', async (req, res) => {
  try {
    const { username, email, phone, password, adminSecret } = req.body;
    if (adminSecret !== process.env.ADMIN_SECRET)
      return res.status(403).json({ message: 'Invalid admin secret' });

    const exists = await User.findOne({ $or: [{ email }, { username }, { phone }] });
    if (exists) return res.status(400).json({ message: 'User already exists' });

    const sessionToken = generateSessionToken();
    const user = await User.create({ username, email, phone, password, role: 'admin', sessionToken });
    const token = generateToken(user._id, sessionToken);
    res.status(201).json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { emailOrPhone, password } = req.body;
    if (!emailOrPhone || !password)
      return res.status(400).json({ message: 'Email/phone and password required' });

    const user = await User.findOne({
      $or: [{ email: emailOrPhone.toLowerCase() }, { phone: emailOrPhone }]
    });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });
    if (user.isBanned) return res.status(403).json({ message: 'Your account has been banned. Contact support.' });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    // Rotate session token — invalidates ALL existing sessions on other devices
    const sessionToken = generateSessionToken();
    user.sessionToken = sessionToken;
    await user.save();

    const token = generateToken(user._id, sessionToken);
    res.json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
