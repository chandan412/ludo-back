const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'No token, access denied' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) return res.status(401).json({ message: 'Token invalid' });
    if (user.isBanned) return res.status(403).json({ message: 'Your account has been banned' });
    if (!user.isActive) return res.status(403).json({ message: 'Account inactive' });

    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token invalid or expired' });
  }
};

const adminAuth = async (req, res, next) => {
  await auth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    next();
  });
};

module.exports = { auth, adminAuth };

// POST /api/auth/fcm-token — save player's FCM token
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
