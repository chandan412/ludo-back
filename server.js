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
const gameSocket     = require('./socket/gameSocket');

const app    = express();
const server = http.createServer(app);

// ✅ Allow any *.vercel.app + localhost
const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (origin === 'http://localhost:3000') return true;
  if (origin.endsWith('.vercel.app')) return true;
  return false;
};

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) callback(null, true);
      else callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.use('/api/auth',     authRoutes);
app.use('/api/wallet',   walletRoutes);
app.use('/api/game',     gameRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/cricket',  cricketRoutes);

gameSocket(io);

const PORT = process.env.PORT || 5000;

// ✅ Start server immediately — don't block on DB
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// ✅ MongoDB with retry — never crashes the server
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    setTimeout(connectDB, 5000);
  }
};

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected — retrying in 3s...');
  setTimeout(connectDB, 3000);
});

connectDB();

module.exports = { app, io };
