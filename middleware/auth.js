const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authUsers } = require('../utils/cache');

// ============================================================================
// ⚡ CACHED USER LOOKUP — shared by this middleware and the socket handshake.
//
// Every API request used to start with a full User.findById(), so a player
// polling three endpoints paid for three identical user reads before any real
// work began. The decision this lookup feeds — does the user exist, are they
// banned, are they an admin — barely ever changes, so it is cached for 30s.
//
// Only the fields routes actually read from req.user / socket.user are kept.
// balance is deliberately NOT among them: a cached balance is a stale balance,
// and every money path reads the wallet fresh from the database.
//
// Banning or unbanning clears the entry at once (routes/admin.js), so a ban
// still takes effect on the very next request, not 30 seconds later.
// ============================================================================
const AUTH_FIELDS = '_id username role isBanned isActive';

async function loadAuthUser(id) {
  return authUsers.wrap(String(id), async () => {
    const u = await User.findById(id).select(AUTH_FIELDS).lean();
    if (!u) return null;
    // .lean() skips schema defaults, so an older account with no isActive field
    // would read as undefined (= inactive). Only an explicit false counts.
    return {
      _id:      u._id,
      username: u.username,
      role:     u.role || 'player',
      isBanned: u.isBanned === true,
      isActive: u.isActive !== false,
    };
  });
}

function invalidateAuthUser(id) {
  if (id) authUsers.delete(String(id));
}

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'No token, access denied' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await loadAuthUser(decoded.id);
    if (!user) return res.status(401).json({ message: 'Token invalid' });
    if (user.isBanned) return res.status(403).json({ message: 'Your account has been banned' });
    if (!user.isActive) return res.status(403).json({ message: 'Account inactive' });
    // A copy, so nothing a route does to req.user can leak into the shared cache.
    req.user = { ...user };
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

module.exports = { auth, adminAuth, isTokenError, loadAuthUser, invalidateAuthUser };
