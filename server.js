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
const gameSocket     = require('./socket/gameSocket');

const app = express();
const server = http.createServer(app);

// ✅ Fixed CORS
const allowedOrigins = [
  'https://ludo-fron.vercel.app',
  'http://localhost:3000'
];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
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
app.use('/api/cricket',  cricketRoutes);
app.use('/api/chat',     chatRoutes);

gameSocket(io);
setChatIO(io);

const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGODB_URI)
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
