const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'No token, access denied' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) return res.status(401).json({ message: 'User not found' });
    if (user.isBanned) return res.status(403).json({ message: 'Your account has been banned' });
    if (!user.isActive) return res.status(403).json({ message: 'Account inactive' });

    req.user = user;
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
