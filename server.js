require('dotenv').config();
const express  = require('express');
const http     = require('http');
const https    = require('https');
const cors     = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const authRoutes    = require('./routes/auth');
const walletRoutes  = require('./routes/wallet');
const gameRoutes    = require('./routes/game');
const adminRoutes   = require('./routes/admin');
const settingsRoutes = require('./routes/settings');
const cricketRoutes = require('./routes/cricket');
const gameSocket    = require('./socket/gameSocket');

const app    = express();
const server = http.createServer(app);

const allowedOrigins = [
  'https://ludo-fron.vercel.app',
  'http://localhost:3000'
];

const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ['GET','POST'], credentials: true },
  // Socket.IO ping to keep connections alive
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.status(200).json({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  time: new Date().toISOString(),
}));

app.use('/api/auth',     authRoutes);
app.use('/api/wallet',   walletRoutes);
app.use('/api/game',     gameRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/cricket',  cricketRoutes);

gameSocket(io);

// ── MongoDB with auto-reconnect ──────────────────────────
const MONGO_OPTS = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  heartbeatFrequencyMS: 10000,
};

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected — retrying...');
  setTimeout(() => mongoose.connect(process.env.MONGODB_URI, MONGO_OPTS), 3000);
});
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB error:', err.message);
});

// ── Start server ─────────────────────────────────────────
const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGODB_URI, MONGO_OPTS)
  .then(() => {
    console.log('✅ MongoDB connected');
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Server running on port ${PORT}`);

      // ── Keep-alive ping every 4 min ──────────────────────
      // Prevents Railway from sleeping the server
      const SELF_URL = process.env.RAILWAY_STATIC_URL
        || process.env.RENDER_EXTERNAL_URL
        || `http://localhost:${PORT}`;

      setInterval(() => {
        const url = SELF_URL.startsWith('https')
          ? `${SELF_URL}/health`
          : `http://localhost:${PORT}/health`;

        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
          console.log(`💓 Keep-alive ping: ${res.statusCode}`);
        }).on('error', (err) => {
          console.warn('Keep-alive ping failed:', err.message);
        });
      }, 4 * 60 * 1000); // every 4 minutes
    });
  })
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });

// ── Catch unhandled errors — don't crash the server ──────
process.on('uncaughtException',  (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err?.message));

module.exports = { app, io };
