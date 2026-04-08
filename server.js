require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const authRoutes     = require('./routes/auth');
const walletRoutes   = require('./routes/wallet');
const gameRoutes     = require('./routes/game');
const adminRoutes    = require('./routes/admin');
const settingsRoutes = require('./routes/settings');
const cricketRoutes  = require('./routes/cricket');
const { router: chatRoutes, setIO: setChatIO } = require('./routes/chat');
const notifRoutes = require('./routes/notifications');
const gameSocket     = require('./socket/gameSocket');

const app    = express();
const server = http.createServer(app);

// ✅ FIX 1: CORS — allow any *.vercel.app, no hardcoded URLs
const isAllowedOrigin = (origin) => {
  if (!origin) return true;                        // mobile / curl
  if (origin === 'http://localhost:3000') return true;
  if (origin.endsWith('.vercel.app')) return true; // all vercel deployments
  return false;
};

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('CORS')),
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

app.use(cors({
  origin: (origin, cb) => isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('CORS')),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth',     authRoutes);
app.use('/api/wallet',   walletRoutes);
app.use('/api/game',     gameRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/cricket',  cricketRoutes);
app.use('/api/chat',     chatRoutes);
app.use('/api/notifications', notifRoutes);

gameSocket(io);
setChatIO(io);

// ✅ FIX 2: Start server immediately — don't wait for MongoDB
// Railway health checks pass right away, no downtime
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// ✅ FIX 2: MongoDB never crashes the server — auto-retries forever
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB failed:', err.message);
    console.log('🔄 Retrying in 5s...');
    setTimeout(connectDB, 5000); // retry instead of process.exit(1)
  }
};

// Auto-reconnect on disconnect
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected — retrying in 3s...');
  setTimeout(connectDB, 3000);
});

connectDB();

module.exports = { app, io };
