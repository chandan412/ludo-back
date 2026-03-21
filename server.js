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
const settingsRoutes = require('./routes/settings'); // ✅ ADD HERE (with other imports)

const app = express();  // app is created here
const server = http.createServer(app);

// ... cors and middleware setup ...

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes); // ✅ ADD HERE (after app is defined)
