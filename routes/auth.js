const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth } = require('../middleware/auth');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, email, phone, password } = req.body;
    if (!username || !email || !phone || !password)
      return res.status(400).json({ message: 'All fields required' });

    const exists = await User.findOne({ $or: [{ email }, { phone }, { username }] });
    if (exists) return res.status(400).json({ message: 'User already exists' });

    // ✅ Give ₹100 signup bonus
    const user = await User.create({ username, email, phone, password, balance: 100 });

    // ✅ Record bonus transaction
    await Transaction.create({
      user:          user._id,
      type:          'bonus',
      amount:        100,
      balanceBefore: 0,
      balanceAfter:  100,
      status:        'completed',
      description:   'Welcome bonus',
    });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, phone, password } = req.body;
    if ((!email && !phone) || !password)
      return res.status(400).json({ message: 'Email/phone and password required' });

    const user = await User.findOne(email ? { email } : { phone });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });
    if (user.isBanned) return res.status(403).json({ message: 'Your account has been banned' });
    if (!user.isActive) return res.status(403).json({ message: 'Account inactive' });

    const match = await user.comparePassword(password);
    if (!match) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    res.json(req.user.toSafeObject());
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/fcm-token
router.post('/fcm-token', auth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: 'Token required' });
    await User.findByIdAndUpdate(req.user._id, { fcmToken: token });
    res.json({ message: 'FCM token saved' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
