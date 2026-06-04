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
// ✅ Connection resilience options. Without these, a slow/unreachable DB made queries
// hang indefinitely (the cascade behind "login failed" under load). Now the driver
// caps the pool, fails fast on an unreachable DB, and drops stuck sockets.
mongoose.connect(process.env.MONGODB_URI, {
  maxPoolSize: 50,                 // cap concurrent connections (stays well within Atlas limits)
  minPoolSize: 5,                  // keep a few warm so the first queries aren't cold
  serverSelectionTimeoutMS: 10000, // fail fast if the DB can't be reached instead of hanging
  socketTimeoutMS: 45000,          // give up on a stuck query rather than holding the socket forever
})
  .then(() => {
    console.log('✅ MongoDB connected');
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });
module.exports = { app, io };
