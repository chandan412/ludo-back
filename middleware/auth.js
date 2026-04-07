const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'No token, access denied' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ✅ Only hit DB for routes that need live data (balance, banned check)
    // All other routes use JWT payload — saves a DB call on every request
    const needsLiveUser =
      req.path.includes('/balance') ||
      req.path.includes('/me') ||
      req.path.includes('/withdraw') ||
      req.path.includes('/create') ||
      req.path.includes('/join') ||
      req.path.includes('/cancel') ||
      req.path.includes('/forfeit') ||
      req.path.includes('/add-balance') ||
      req.path.includes('/process-withdrawal') ||
      req.path.includes('/ban') ||
      req.path.includes('/unban');

    if (needsLiveUser) {
      const user = await User.findById(decoded.id).select('-password');
      if (!user) return res.status(401).json({ message: 'User not found' });
      if (user.isBanned) return res.status(403).json({ message: 'Your account has been banned' });
      if (!user.isActive) return res.status(403).json({ message: 'Account inactive' });
      req.user = user;
    } else {
      // Use JWT payload — no DB query needed
      req.user = {
        _id: decoded.id,
        username: decoded.username,
        role: decoded.role,
        isBanned: decoded.isBanned || false,
      };
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    res.status(401).json({ message: 'Token invalid' });
  }
};

const adminAuth = async (req, res, next) => {
  await auth(req, res, () => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ message: 'Admin access required' });
    next();
  });
};

module.exports = { auth, adminAuth };
