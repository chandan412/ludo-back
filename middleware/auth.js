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
    // ✅ Only a genuinely bad token is a 401. The client LOGS THE PLAYER OUT on 401,
    // so a DB hiccup (slow/failed User lookup) must never be reported as one — that
    // kicked players with a perfectly valid token out mid-game on a weak network.
    // 503 is retried by the client instead.
    if (isTokenError(err)) {
      return res.status(401).json({ message: 'Token invalid or expired' });
    }
    console.error('auth middleware error (not a token problem):', err.message);
    res.status(503).json({ message: 'Server busy, please retry' });
  }
};

// jwt.verify failures, plus a malformed user id inside an otherwise valid token.
const TOKEN_ERROR_NAMES = ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError', 'CastError'];
const isTokenError = (err) => TOKEN_ERROR_NAMES.includes(err?.name);

const adminAuth = async (req, res, next) => {
  await auth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    next();
  });
};

module.exports = { auth, adminAuth, isTokenError };
