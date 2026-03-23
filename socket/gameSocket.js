const Game = require('../models/Game');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const LudoEngine = require('./ludoEngine');

const activeRooms = new Map();

module.exports = (io) => {

  // ================= AUTH =================
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) return next(new Error('Auth required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password');

      if (!user || user.isBanned) return next(new Error('Unauthorized'));

      socket.user = user;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`✅ ${socket.user.username} connected`);

    // ================= JOIN =================
    socket.on('join-room', async ({ roomCode }) => {
      try {
        roomCode = roomCode.toUpperCase();

        // 🚫 Prevent multi-tab login
        const sockets = await io.in(roomCode).fetchSockets();
        if (sockets.find(s => s.user._id.toString() === socket.user._id.toString())) {
          return socket.emit('error', { message: 'Already connected in another tab' });
        }

        let game = activeRooms.get(roomCode);

        if (!game) {
          const dbGame = await Game.findOne({ roomCode })
            .populate('players.user', 'username');

          if (!dbGame) return socket.emit('error', { message: 'Game not found' });

          game = dbGame.toObject();

          // 🔒 Security + state
          game.isProcessing = false;
          game.expectedAction = 'roll';
          game.actionId = 0;
          game.lastEvents = [];
          game.moveTimer = null;

          activeRooms.set(roomCode, game);
        }

        socket.join(roomCode);
        socket.currentRoom = roomCode;

        socket.emit('game-state', sanitizeGame(game, socket.user._id));

        // 🔁 Replay events for recovery
        game.lastEvents.forEach(e => {
          socket.emit(e.type, e.payload);
        });

      } catch {
        socket.emit('error', { message: 'Join failed' });
      }
    });

    // ================= ROLL DICE =================
    socket.on('roll-dice', ({ roomCode, actionId }) => {
      const game = activeRooms.get(roomCode);
      if (!game) return;

      if (game.isProcessing) return;
      game.isProcessing = true;

      // 🔒 Anti-cheat checks
      if (game.expectedAction !== 'roll') {
        game.isProcessing = false;
        return socket.emit('error', { message: 'Invalid flow' });
      }

      if (actionId !== game.actionId) {
        game.isProcessing = false;
        return socket.emit('error', { message: 'Outdated action' });
      }

      if (game.currentTurn !== socket.user._id.toString()) {
        game.isProcessing = false;
        return socket.emit('error', { message: 'Not your turn' });
      }

      const diceRoll = LudoEngine.rollDice();
      game.lastDiceRoll = diceRoll;

      const playerIdx = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
      const opponentIdx = playerIdx === 0 ? 1 : 0;

      const player = game.players[playerIdx];
      const opponent = game.players[opponentIdx];

      const validMoves = LudoEngine.getValidMoves(player, diceRoll, opponent);

      game.expectedAction = 'move';
      game.actionId++;

      // ⏱️ Timeout
      game.moveTimer = setTimeout(() => {
        game.currentTurn = opponent.user._id.toString();
        game.expectedAction = 'roll';
        game.lastDiceRoll = null;

        emitEvent(io, roomCode, game, 'turn-timeout', {
          nextTurn: game.currentTurn
        });
      }, 15000);

      emitEvent(io, roomCode, game, 'dice-rolled', {
        diceRoll,
        playerId: socket.user._id.toString(),
        validMoves,
        actionId: game.actionId
      });

      game.isProcessing = false;
    });

    // ================= MOVE TOKEN =================
    socket.on('move-token', ({ roomCode, tokenIndex, actionId }) => {
      const game = activeRooms.get(roomCode);
      if (!game) return;

      if (game.isProcessing) return;
      game.isProcessing = true;

      clearTimeout(game.moveTimer);

      // 🔒 Anti-cheat
      if (game.expectedAction !== 'move') {
        game.isProcessing = false;
        return socket.emit('error', { message: 'Roll dice first' });
      }

      if (actionId !== game.actionId) {
        game.isProcessing = false;
        return socket.emit('error', { message: 'Outdated action' });
      }

      if (typeof tokenIndex !== 'number') {
        game.isProcessing = false;
        return;
      }

      if (!game.lastDiceRoll) {
        game.isProcessing = false;
        return socket.emit('error', { message: 'No dice' });
      }

      const playerIdx = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
      const opponentIdx = playerIdx === 0 ? 1 : 0;

      const player = game.players[playerIdx];
      const opponent = game.players[opponentIdx];

      // ✅ Server validation
      const validMoves = LudoEngine.getValidMoves(player, game.lastDiceRoll, opponent);
      const move = validMoves.find(m => m.tokenIndex === tokenIndex);

      if (!move) {
        console.log('🚨 Cheat attempt:', socket.user._id);
        game.isProcessing = false;
        return socket.emit('error', { message: 'Invalid move' });
      }

      const result = LudoEngine.applyMove(player, opponent, tokenIndex, game.lastDiceRoll);

      game.lastDiceRoll = null;

      if (!result.extraTurn) {
        game.currentTurn = opponent.user._id.toString();
        game.expectedAction = 'roll';
      } else {
        game.expectedAction = 'roll';
      }

      game.actionId++;

      // 🏁 Game Over
      if (result.gameOver) {
        emitEvent(io, roomCode, game, 'game-over', {
          winner: socket.user._id.toString()
        });

        activeRooms.delete(roomCode);
        game.isProcessing = false;
        return;
      }

      emitEvent(io, roomCode, game, 'token-moved', {
        playerId: socket.user._id.toString(),
        tokenIndex,
        gameState: game,
        actionId: game.actionId
      });

      game.isProcessing = false;
    });

    // ================= DISCONNECT =================
    socket.on('disconnect', () => {
      const roomCode = socket.currentRoom;
      if (!roomCode) return;

      const game = activeRooms.get(roomCode);
      if (!game) return;

      const userId = socket.user._id.toString();

      const timer = setTimeout(() => {
        const g = activeRooms.get(roomCode);
        if (!g) return;

        emitEvent(io, roomCode, g, 'game-over', {
          reason: 'disconnect'
        });

        activeRooms.delete(roomCode);

      }, 60000);

      game.disconnectTimer = timer;
    });

    // ================= RECONNECT =================
    socket.on('reconnect-room', ({ roomCode }) => {
      const game = activeRooms.get(roomCode);
      if (!game) return;

      clearTimeout(game.disconnectTimer);

      socket.join(roomCode);
      socket.currentRoom = roomCode;

      socket.emit('game-state', sanitizeGame(game, socket.user._id));

      game.lastEvents.forEach(e => {
        socket.emit(e.type, e.payload);
      });
    });

  });
};

// ================= EVENT HELPER =================
function emitEvent(io, roomCode, game, type, payload) {
  io.to(roomCode).emit(type, payload);

  game.lastEvents.push({ type, payload });
  if (game.lastEvents.length > 10) game.lastEvents.shift();
}

// ================= SANITIZE =================
function sanitizeGame(game, userId) {
  return {
    ...game,
    currentTurn: game.currentTurn,
    myColor: game.players.find(p => p.user._id.toString() === userId.toString())?.color
  };
}
