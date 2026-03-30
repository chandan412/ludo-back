const Game = require('../models/Game');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const LudoEngine = require('./ludoEngine');
const jwt = require('jsonwebtoken');

const activeRooms = new Map();
const roomTimers = new Map();

// ============================
// Waiting Timer
// ============================
function startWaitingTimer(io, roomCode) {
  const WAIT_DURATION = 2 * 60 * 1000;
  let remainingSeconds = 120;

  const tickInterval = setInterval(() => {
    remainingSeconds -= 1;

    io.to(roomCode).emit('waiting-countdown', {
      secondsLeft: remainingSeconds,
    });

    if (remainingSeconds <= 0) clearInterval(tickInterval);
  }, 1000);

  const abortTimer = setTimeout(async () => {
    clearInterval(tickInterval);

    try {
      const game = await Game.findOne({ roomCode, status: 'waiting' });
      if (!game) return;

      game.status = 'aborted';
      game.finishedAt = new Date();
      await game.save();

      // Refund creator safely
      const creator = await User.findById(game.players[0].user);
      if (creator) {
        const before = creator.balance;

        creator.balance += game.betAmount;
        creator.lockedBalance = Math.max(
          0,
          creator.lockedBalance - game.betAmount
        );

        await creator.save();

        await Transaction.create({
          user: creator._id,
          type: 'refund',
          amount: game.betAmount,
          balanceBefore: before,
          balanceAfter: creator.balance,
          status: 'completed',
          gameId: game._id,
        });
      }

      io.to(roomCode).emit('game-aborted', {
        reason: 'no_opponent',
        message: 'No opponent joined. Refunded.',
      });
    } catch (err) {
      console.error('Auto-abort error:', err);
    } finally {
      roomTimers.delete(roomCode);
    }
  }, WAIT_DURATION);

  roomTimers.set(roomCode, { abortTimer, tickInterval });
}

// ============================
// Cancel Timer
// ============================
function cancelWaitingTimer(roomCode) {
  const timers = roomTimers.get(roomCode);
  if (timers) {
    clearTimeout(timers.abortTimer);
    clearInterval(timers.tickInterval);
    roomTimers.delete(roomCode);
  }
}

// ============================
// Safe Settlement (CRITICAL FIX)
// ============================
async function settleGame(game, winnerId, loserId, winAmount, platformFee) {
  const session = await User.startSession();

  try {
    session.startTransaction();

    const winner = await User.findById(winnerId).session(session);
    const loser = await User.findById(loserId).session(session);

    if (!winner || !loser) throw new Error('User not found');

    const netWin = game.betAmount - platformFee;

    winner.balance += netWin;
    winner.lockedBalance -= game.betAmount;

    loser.lockedBalance -= game.betAmount;
    loser.balance -= game.betAmount;

    winner.gamesWon += 1;
    winner.gamesPlayed += 1;
    winner.totalEarned += netWin;

    loser.gamesPlayed += 1;
    loser.totalLost += game.betAmount;

    await winner.save({ session });
    await loser.save({ session });

    await Transaction.create([{
      user: winnerId,
      type: 'game_win',
      amount: netWin,
      balanceAfter: winner.balance,
      status: 'completed',
      gameId: game._id,
    }], { session });

    await session.commitTransaction();
    session.endSession();

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Settlement failed:', err);
  }
}

// ============================
// Sanitize Game
// ============================
function sanitizeGame(game, userId) {
  const g = game.toObject();

  return {
    ...g,
    currentTurn: g.currentTurn?.toString(),
    myColor: g.players.find(
      p => p.user._id.toString() === userId.toString()
    )?.color,
  };
}

// ============================
// MAIN SOCKET
// ============================
module.exports = (io) => {

  // Auth
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) return next(new Error('Auth required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);

      if (!user) return next(new Error('Invalid user'));

      socket.user = user;
      next();
    } catch {
      next(new Error('Auth failed'));
    }
  });

  io.on('connection', (socket) => {

    // ============================
    // CREATE ROOM
    // ============================
    socket.on('created-room', ({ roomCode }) => {
      socket.join(roomCode);
      socket.currentRoom = roomCode;

      startWaitingTimer(io, roomCode);
    });

    // ============================
    // JOIN ROOM (FIXED BUG)
    // ============================
    socket.on('join-room', async ({ roomCode }) => {
      try {
        const game = await Game.findOne({
          roomCode: roomCode.toUpperCase()
        }).populate('players.user', 'username');

        if (!game) return socket.emit('error', { message: 'Game not found' });

        socket.join(roomCode);
        socket.currentRoom = roomCode;

        // FIX: Prevent duplicate joins
        const player = game.players.find(
          p => p.user._id.toString() === socket.user._id.toString()
        );

        if (!player) {
          return socket.emit('error', { message: 'Not a player' });
        }

        player.isConnected = true;
        await game.save();

        socket.emit('game-state', sanitizeGame(game, socket.user._id));

        const connectedCount = game.players.filter(p => p.isConnected).length;

        // FIX: Only trigger once
        if (connectedCount === 2 && game.status === 'waiting') {
          cancelWaitingTimer(roomCode);

          game.status = 'active';
          await game.save();

          io.to(roomCode).emit('opponent-joined');
        }

      } catch {
        socket.emit('error', { message: 'Join failed' });
      }
    });

    // ============================
    // ROLL DICE
    // ============================
    socket.on('roll-dice', async ({ roomCode }) => {
      const game = await Game.findOne({ roomCode });

      if (!game) return;

      if (game.currentTurn.toString() !== socket.user._id.toString())
        return socket.emit('error', { message: 'Not your turn' });

      let dice = LudoEngine.rollDice();

      if (game.consecutiveSixes >= 2) {
        while (dice === 6) dice = LudoEngine.rollDice();
      }

      game.lastDiceRoll = dice;
      game.consecutiveSixes = dice === 6 ? game.consecutiveSixes + 1 : 0;

      await game.save();

      io.to(roomCode).emit('dice-rolled', {
        diceRoll: dice,
        playerId: socket.user._id,
      });
    });

    // ============================
    // MOVE TOKEN (SAFE FIX)
    // ============================
    socket.on('move-token', async ({ roomCode, tokenIndex }) => {
      const game = await Game.findOne({ roomCode })
        .populate('players.user');

      if (!game) return;

      const dice = game.lastDiceRoll;
      if (!dice) return;

      const playerIdx = game.players.findIndex(
        p => p.user._id.toString() === socket.user._id.toString()
      );

      const opponentIdx = playerIdx === 0 ? 1 : 0;

      const result = LudoEngine.applyMove(
        game.players[playerIdx],
        game.players[opponentIdx],
        tokenIndex,
        dice
      );

      game.lastDiceRoll = null;

      if (result.gameOver) {
        game.status = 'finished';
        game.winner = socket.user._id;

        await game.save();

        await settleGame(
          game,
          socket.user._id,
          game.players[opponentIdx].user._id,
          0,
          0
        );

        io.to(roomCode).emit('game-over', {});
        return;
      }

      game.currentTurn = result.extraTurn
        ? socket.user._id
        : game.players[opponentIdx].user._id;

      await game.save();

      io.to(roomCode).emit('token-moved', {});
    });

    // ============================
    // DISCONNECT (IMPORTANT FIX)
    // ============================
    socket.on('disconnect', async () => {
      if (!socket.currentRoom) return;

      const roomCode = socket.currentRoom;

      const timer = setTimeout(async () => {
        const game = await Game.findOne({ roomCode });

        if (!game || game.status !== 'active') return;

        const opponent = game.players.find(
          p => p.user._id.toString() !== socket.user._id.toString()
        );

        game.status = 'finished';
        game.winner = opponent.user._id;

        await game.save();

        await settleGame(game, opponent.user._id, socket.user._id, 0, 0);

        io.to(roomCode).emit('game-over', {
          reason: 'disconnect'
        });

      }, 60000);

      activeRooms.set(roomCode, { timer });
    });

    // ============================
    // RECONNECT (FIXED)
    // ============================
    socket.on('reconnect-room', ({ roomCode }) => {
      const room = activeRooms.get(roomCode);

      if (room?.timer) {
        clearTimeout(room.timer);
        activeRooms.delete(roomCode);
      }

      socket.join(roomCode);
    });

  });
};
