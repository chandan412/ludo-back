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
const paymentAutomationRoutes = require('./routes/paymentAutomation');

const gameSocket = require('./socket/gameSocket');

const app = express();
const server = http.createServer(app);

// ============================================================================
// GLOBAL SAFETY NETS
// ============================================================================

process.on('unhandledRejection', (reason) => {
  console.error('🛑 UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('🛑 UNCAUGHT EXCEPTION:', err);
  setTimeout(() => process.exit(1), 250);
});

// ============================================================================
// CORS
// ============================================================================

const allowedOrigins = [
  'https://ludo-fron.vercel.app',
  'https://ludo-king.in',
  'https://www.ludo-king.in',
  'http://localhost:3000'
];

if (process.env.FRONTEND_URL) {
  process.env.FRONTEND_URL.split(',').forEach(o => {
    const t = o.trim();

    if (
      t &&
      !allowedOrigins.includes(t)
    ) {
      allowedOrigins.push(t);
    }
  });
}

function isOriginAllowed(origin) {
  if (!origin) return true;

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  if (
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)
  ) {
    return true;
  }

  return false;
}

// ============================================================================
// SOCKET.IO
// ============================================================================

const io = new Server(server, {
  cors: {
    origin: (origin, callback) =>
      callback(
        null,
        isOriginAllowed(origin)
      ),
    methods: ['GET', 'POST'],
    credentials: true
  },

  pingInterval: 10000,
  pingTimeout: 10000
});

// ============================================================================
// EXPRESS MIDDLEWARE
// ============================================================================

app.use(
  cors({
    origin: function (origin, callback) {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }

      console.warn(
        '⚠️ CORS blocked origin:',
        origin
      );

      return callback(
        new Error('Not allowed by CORS')
      );
    },

    credentials: true,

    methods: [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'OPTIONS'
    ],

    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-payment-automation-secret'
    ]
  })
);

app.use(
  express.json({
    limit: '10mb'
  })
);

// ============================================================================
// HEALTH
// ============================================================================

app.get(
  '/health',
  (req, res) =>
    res.status(200).json({
      status: 'ok'
    })
);

// ============================================================================
// API ROUTES
// ============================================================================

app.use(
  '/api/auth',
  authRoutes
);

app.use(
  '/api/wallet',
  walletRoutes
);

app.use(
  '/api/game',
  gameRoutes
);

app.use(
  '/api/admin',
  adminRoutes
);

app.use(
  '/api/settings',
  settingsRoutes
);

app.use(
  '/api/chat',
  chatRoutes
);

// ============================================================================
// PAYMENT AUTOMATION
//
// Bank SMS → n8n → these routes
//
// IMPORTANT:
// This is a separate automation layer.
// It does NOT replace your existing wallet/game routes.
// ============================================================================

app.use(
  '/api/payment-automation',
  paymentAutomationRoutes
);

// ============================================================================
// GAME SOCKET
// ============================================================================

gameSocket(io);

// ============================================================================
// ADMIN LIVE UPDATES
// ============================================================================

const ADMIN_ROOM = 'admin-room';

io.on('connection', (socket) => {

  socket.on('join-admin', () => {

    if (
      socket.user?.role !== 'admin'
    ) {
      return;
    }

    socket.join(ADMIN_ROOM);
  });

  socket.on('leave-admin', () => {
    socket.leave(ADMIN_ROOM);
  });

});

// ============================================================================
// MAKE SOCKET.IO AVAILABLE TO EXPRESS ROUTES
// ============================================================================

app.set('io', io);
app.set(
  'ADMIN_ROOM',
  ADMIN_ROOM
);

const PORT =
  process.env.PORT || 5000;

// ============================================================================
// START SERVER
// ============================================================================

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `✅ Server running on port ${PORT}`
    );
  }
);

// ============================================================================
// STARTUP SWEEP
// ============================================================================

let startupSweepDone = false;

const releaseOrphanedWaitingGames =
  async () => {

    if (startupSweepDone) {
      return;
    }

    startupSweepDone = true;

    try {

      const Game =
        require('./models/Game');

      const User =
        require('./models/User');

      const Transaction =
        require('./models/Transaction');

      const waiting =
        await Game.find({
          status: 'waiting'
        });

      if (
        waiting.length === 0
      ) {
        console.log(
          '🧹 Startup sweep: no orphaned waiting rooms.'
        );

        return;
      }

      let aborted = 0;
      let released = 0;

      for (
        const g of waiting
      ) {

        const claimed =
          await Game.findOneAndUpdate(
            {
              _id: g._id,
              status: 'waiting'
            },
            {
              $set: {
                status: 'aborted',
                finishedAt: new Date()
              }
            },
            {
              new: true
            }
          );

        if (!claimed) {
          continue;
        }

        for (
          const p of claimed.players
        ) {

          const u =
            await User.findById(
              p.user
            );

          if (!u) {
            continue;
          }

          const before =
            u.balance;

          u.lockedBalance =
            Math.max(
              0,
              u.lockedBalance -
                claimed.betAmount
            );

          await u.save();

          await Transaction.create({
            user: u._id,

            type: 'refund',

            amount:
              claimed.betAmount,

            balanceBefore:
              before,

            balanceAfter:
              u.balance,

            status:
              'completed',

            gameId:
              claimed._id
          });

          released +=
            claimed.betAmount;
        }

        aborted++;
      }

      console.log(
        `🧹 Startup sweep: aborted ${aborted} orphaned waiting room(s), released ₹${released} of locked balance.`
      );

    } catch (err) {

      console.error(
        '🧹 Startup sweep error (non-fatal):',
        err.message
      );
    }
  };

// ============================================================================
// MONGODB
// ============================================================================

const connectDB =
  async () => {

    try {

      await mongoose.connect(
        process.env.MONGODB_URI,
        {
          maxPoolSize: 10,
          minPoolSize: 2,
          serverSelectionTimeoutMS: 10000,
          socketTimeoutMS: 45000
        }
      );

      console.log(
        '✅ MongoDB connected'
      );

      await releaseOrphanedWaitingGames();

      // ================================================================
      // Grandfather existing users into phone verification
      // ================================================================

      try {

        const User =
          require('./models/User');

        const r =
          await User.updateMany(
            {
              phoneVerified: {
                $exists: false
              }
            },
            {
              $set: {
                phoneVerified: true
              }
            }
          );

        if (
          r.modifiedCount
        ) {
          console.log(
            `✅ Grandfathered ${r.modifiedCount} existing user(s) as phone-verified.`
          );
        }

      } catch (e) {

        console.error(
          'phoneVerified grandfather error (non-fatal):',
          e.message
        );
      }

    } catch (err) {

      console.error(
        '❌ MongoDB initial connection error:',
        err.message,
        '— retrying in 5s'
      );

      setTimeout(
        connectDB,
        5000
      );
    }
  };

// ============================================================================
// MONGOOSE CONNECTION LOGGING
// ============================================================================

mongoose.connection.on(
  'connected',
  () =>
    console.log(
      '✅ Mongoose connected'
    )
);

mongoose.connection.on(
  'disconnected',
  () =>
    console.warn(
      '⚠️ Mongoose disconnected — driver will auto-reconnect'
    )
);

mongoose.connection.on(
  'reconnected',
  () =>
    console.log(
      '🔄 Mongoose reconnected'
    )
);

mongoose.connection.on(
  'error',
  (e) =>
    console.error(
      '❌ Mongoose error:',
      e.message
    )
);

// ============================================================================
// CONNECT DATABASE
// ============================================================================

connectDB();

// ============================================================================
// EXPORT
// ============================================================================

module.exports = {
  app,
  io
};
