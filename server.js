require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const gameRoutes = require('./routes/game');
const adminRoutes = require('./routes/admin');
const settingsRoutes = require('./routes/settings');
const chatRoutes = require('./routes/chat');
const gameSocket = require('./socket/gameSocket');
const app = express();
const server = http.createServer(app);

// ✅ GLOBAL SAFETY NETS. A single unhandled async error must NOT silently take down
// the whole server (which would freeze every live game and break logins). Log loudly.
// For a money platform, continuing in a corrupted state is worse than a clean restart,
// so on a truly fatal uncaughtException we log then let the platform restart a fresh
// process — but in-flight money ops are already guarded by atomic DB updates.
process.on('unhandledRejection', (reason) => {
  console.error('🛑 UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('🛑 UNCAUGHT EXCEPTION:', err);
  setTimeout(() => process.exit(1), 250); // flush logs, then clean restart
});
// ✅ Fixed CORS
const allowedOrigins = [
  'https://ludo-fron.vercel.app',
  'https://ludo-king.in',
  'https://www.ludo-king.in',
  'http://localhost:3000'
];
// Optional extra origin from env (e.g. a custom domain), comma-separated
if (process.env.FRONTEND_URL) {
  process.env.FRONTEND_URL.split(',').forEach(o => {
    const t = o.trim();
    if (t && !allowedOrigins.includes(t)) allowedOrigins.push(t);
  });
}
// ✅ Accept the fixed list above PLUS any *.vercel.app preview/branch URL.
// Vercel gives preview & branch deploys a different subdomain each time
// (e.g. ludo-fron-git-main-xxx.vercel.app), which would otherwise be blocked
// by CORS and surface on the frontend as a generic "Login failed".
function isOriginAllowed(origin) {
  if (!origin) return true; // mobile apps / curl / same-origin
  if (allowedOrigins.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;
  return false;
}
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    methods: ['GET', 'POST'],
    credentials: true
  }
});
app.use(cors({
  origin: function (origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    console.warn('⚠️ CORS blocked origin:', origin); // shows exactly what was rejected
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/chat', chatRoutes);
gameSocket(io);
const PORT = process.env.PORT || 5000;

// ✅ Start listening IMMEDIATELY — do NOT block the server on MongoDB. This is the
// key fix for recurring "login failed / no response": previously the server only
// called listen() after Mongo connected and did process.exit(1) on any error, so a
// transient Atlas hiccup made the whole app refuse connections or restart-loop, and
// every in-progress game froze. Now /health and the API are always reachable; if the
// DB is momentarily down, individual requests fail fast (and retry) instead of the
// entire server going dark.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// ============================================================================
// ✅ STARTUP SWEEP — release orphaned WAITING rooms on every boot.
//
// A server restart (e.g. a Railway redeploy) loses the in-memory 2-min and 20s
// waiting-room timers. Any room that was 'waiting' at that moment would otherwise
// be stranded as 'waiting' forever, with the creator's bet locked indefinitely.
// On boot we abort each such room and UNLOCK the stake.
//
// MONEY SAFETY (matches the app's rules exactly):
//   • Refund = UNLOCK only: lockedBalance -= betAmount. balance is NEVER touched.
//   • Each room is flipped waiting → aborted ATOMICALLY before refunding, so this
//     can never double-refund (a racing request that already handled a room makes
//     the flip return null and we skip it).
//   • A 'refund' Transaction is written for every release (full audit trail).
//   • Only 'waiting' rooms are touched. Active/finished/aborted games are untouched.
//   • Runs ONCE per process and is fully self-contained: any error is caught and
//     logged, so it can never disrupt the DB connection or the crash-handling above.
// ============================================================================
let startupSweepDone = false;
const releaseOrphanedWaitingGames = async () => {
  if (startupSweepDone) return;
  startupSweepDone = true;
  try {
    const Game        = require('./models/Game');
    const User        = require('./models/User');
    const Transaction = require('./models/Transaction');

    const waiting = await Game.find({ status: 'waiting' });
    if (waiting.length === 0) {
      console.log('🧹 Startup sweep: no orphaned waiting rooms.');
      return;
    }

    let aborted = 0;
    let released = 0;
    for (const g of waiting) {
      // Atomically claim this room (waiting → aborted). If something already handled
      // it, `claimed` is null and we skip — this is what prevents any double-refund.
      const claimed = await Game.findOneAndUpdate(
        { _id: g._id, status: 'waiting' },
        { $set: { status: 'aborted', finishedAt: new Date() } },
        { new: true }
      );
      if (!claimed) continue;

      // Waiting rooms normally hold just the creator; loop defensively over all.
      for (const p of claimed.players) {
        const u = await User.findById(p.user);
        if (!u) continue;
        const before = u.balance; // balance does NOT change — this only unlocks
        u.lockedBalance = Math.max(0, u.lockedBalance - claimed.betAmount);
        await u.save();
        await Transaction.create({
          user: u._id,
          type: 'refund',
          amount: claimed.betAmount,
          balanceBefore: before,
          balanceAfter: u.balance,
          status: 'completed',
          gameId: claimed._id,
        });
        released += claimed.betAmount;
      }
      aborted++;
    }
    console.log(`🧹 Startup sweep: aborted ${aborted} orphaned waiting room(s), released ₹${released} of locked balance.`);
  } catch (err) {
    // Non-fatal by design — never let cleanup disrupt boot or the DB link.
    console.error('🧹 Startup sweep error (non-fatal):', err.message);
  }
};

// ✅ Connect to MongoDB in the background with auto-retry. Never exit on a transient
// failure — Mongoose also auto-reconnects on its own once the first connection succeeds.
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10,                 // M0 free tier is shared — keep the pool small and gentle
      minPoolSize: 2,                  // keep a couple warm so the first queries aren't cold
      serverSelectionTimeoutMS: 10000, // fail fast if the DB can't be reached instead of hanging
      socketTimeoutMS: 45000,          // give up on a stuck query rather than holding the socket forever
    });
    console.log('✅ MongoDB connected');
    // ✅ One-time cleanup of orphaned waiting rooms, now that the DB is reachable.
    // Self-guarded (never throws), so it can't trip the catch/retry below.
    await releaseOrphanedWaitingGames();
  } catch (err) {
    console.error('❌ MongoDB initial connection error:', err.message, '— retrying in 5s');
    setTimeout(connectDB, 5000);
  }
};

// ✅ Runtime visibility — THESE are the lines to watch in Railway logs when
// "login failed / no response" happens. They tell you if the DB link is the cause.
mongoose.connection.on('connected',    () => console.log('✅ Mongoose connected'));
mongoose.connection.on('disconnected', () => console.warn('⚠️ Mongoose disconnected — driver will auto-reconnect'));
mongoose.connection.on('reconnected',  () => console.log('🔄 Mongoose reconnected'));
mongoose.connection.on('error',        (e) => console.error('❌ Mongoose error:', e.message));

connectDB();

module.exports = { app, io };
