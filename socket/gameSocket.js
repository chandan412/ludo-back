const Game = require('../models/Game');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const LudoEngine = require('./ludoEngine');
const jwt = require('jsonwebtoken');

const activeRooms = new Map();

module.exports = (io) => {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) return next(new Error('Authentication required'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password');
      if (!user || user.isBanned) return next(new Error('Unauthorized'));
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.user.username} (${socket.id})`);

    socket.on('join-room', async ({ roomCode }) => {
      try {
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .populate('players.user', 'username gamesPlayed gamesWon');

        if (!game) return socket.emit('error', { message: 'Game not found' });

        const isPlayer = game.players.some(p => p.user._id.toString() === socket.user._id.toString());
        if (!isPlayer) return socket.emit('error', { message: 'Not a player in this game' });

        socket.join(roomCode);
        socket.currentRoom = roomCode;

        const playerIdx = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        game.players[playerIdx].isConnected = true;
        await game.save();

        socket.emit('game-state', sanitizeGame(game, socket.user._id));
        socket.to(roomCode).emit('player-connected', { username: socket.user.username });

        console.log(`${socket.user.username} joined room ${roomCode}`);
      } catch (err) {
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    socket.on('roll-dice', async ({ roomCode }) => {
      try {
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .populate('players.user', 'username');

        if (!game || game.status !== 'active')
          return socket.emit('error', { message: 'Game not active' });

        if (game.currentTurn.toString() !== socket.user._id.toString())
          return socket.emit('error', { message: 'Not your turn' });

        const diceRoll = LudoEngine.rollDice();
        game.lastDiceRoll = diceRoll;

        if (diceRoll === 6) {
          game.consecutiveSixes = (game.consecutiveSixes || 0) + 1;
        } else {
          game.consecutiveSixes = 0;
        }

        const playerIdx = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        const opponentIdx = playerIdx === 0 ? 1 : 0;
        const playerState = game.players[playerIdx];
        const opponentState = game.players[opponentIdx];

        if (game.consecutiveSixes >= 3) {
          game.consecutiveSixes = 0;
          game.currentTurn = opponentState.user._id;
          await game.save();
          io.to(roomCode).emit('dice-rolled', {
            diceRoll,
            playerId: socket.user._id,
            playerUsername: socket.user.username,
            consecutiveSixes: true,
            message: '3 consecutive sixes! Turn forfeited.',
            nextTurn: opponentState.user._id
          });
          return;
        }

        const validMoves = LudoEngine.getValidMoves(playerState, diceRoll, opponentState);
        await game.save();

        io.to(roomCode).emit('dice-rolled', {
          diceRoll,
          playerId: socket.user._id,
          playerUsername: socket.user.username,
          validMoves: validMoves.map(m => ({ tokenIndex: m.tokenIndex, newProgress: m.newProgress, canCapture: m.canCapture })),
          hasValidMoves: validMoves.length > 0,
          currentTurn: game.currentTurn
        });

        if (validMoves.length === 0) {
          game.currentTurn = opponentState.user._id;
          await game.save();
          setTimeout(() => {
            io.to(roomCode).emit('turn-passed', {
              reason: 'No valid moves',
              nextTurn: opponentState.user._id,
              nextTurnUsername: opponentState.user.username
            });
          }, 1000);
        }
      } catch (err) {
        console.error('roll-dice error:', err);
        socket.emit('error', { message: 'Server error' });
      }
    });

    socket.on('move-token', async ({ roomCode, tokenIndex }) => {
      try {
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .populate('players.user', 'username');

        if (!game || game.status !== 'active')
          return socket.emit('error', { message: 'Game not active' });

        if (game.currentTurn.toString() !== socket.user._id.toString())
          return socket.emit('error', { message: 'Not your turn' });

        if (game.lastDiceRoll === null)
          return socket.emit('error', { message: 'Roll dice first' });

        const playerIdx = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        const opponentIdx = playerIdx === 0 ? 1 : 0;
        const playerState = game.players[playerIdx];
        const opponentState = game.players[opponentIdx];

        const validMoves = LudoEngine.getValidMoves(playerState, game.lastDiceRoll, opponentState);
        const move = validMoves.find(m => m.tokenIndex === tokenIndex);
        if (!move) return socket.emit('error', { message: 'Invalid move' });

        const result = LudoEngine.applyMove(playerState, opponentState, tokenIndex, game.lastDiceRoll);

        game.players[playerIdx].tokens = result.newPlayerTokens;
        game.players[playerIdx].finishedTokens = result.finishedCount;
        game.players[opponentIdx].tokens = result.newOpponentTokens;

        game.moveHistory.push({
          player: socket.user._id,
          dice: game.lastDiceRoll,
          tokenIndex,
          fromPosition: move.currentProgress,
          toPosition: move.newProgress
        });

        game.lastDiceRoll = null;

        const moveData = {
          playerId: socket.user._id,
          playerUsername: socket.user.username,
          tokenIndex,
          fromProgress: move.currentProgress,
          toProgress: move.newProgress,
          captured: result.captured,
          extraTurn: result.extraTurn,
          finishedCount: result.finishedCount
        };

        if (result.gameOver) {
          game.status = 'finished';
          game.winner = socket.user._id;
          game.loser = opponentState.user._id;
          game.finishedAt = new Date();

          const pot = game.betAmount * 2;
          const platformFee = Math.floor(pot * (parseInt(process.env.PLATFORM_FEE_PERCENT || 5) / 100));
          const winAmount = pot - platformFee;
          game.winAmount = winAmount;
          game.platformFee = platformFee;

          await game.save();
          await settleGame(game, socket.user._id, opponentState.user._id, winAmount, platformFee);

          io.to(roomCode).emit('game-over', {
            ...moveData,
            winner: { id: socket.user._id, username: socket.user.username },
            loser: { id: opponentState.user._id, username: opponentState.user.username },
            winAmount,
            platformFee,
            pot
          });
          return;
        }

        if (result.extraTurn) {
          game.currentTurn = socket.user._id;
        } else {
          game.currentTurn = opponentState.user._id;
          game.consecutiveSixes = 0;
        }

        await game.save();

        io.to(roomCode).emit('token-moved', {
          ...moveData,
          gameState: {
            players: game.players.map(p => ({
              userId: p.user._id,
              username: p.user.username,
              color: p.color,
              tokens: p.tokens,
              finishedTokens: p.finishedTokens
            })),
            currentTurn: game.currentTurn,
            nextTurnUsername: result.extraTurn ? socket.user.username : opponentState.user.username
          }
        });
      } catch (err) {
        console.error('move-token error:', err);
        socket.emit('error', { message: 'Server error' });
      }
    });

    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${socket.user.username}`);
      if (!socket.currentRoom) return;

      try {
        const game = await Game.findOne({
          roomCode: socket.currentRoom,
          status: 'active'
        }).populate('players.user', 'username');

        if (!game) return;

        const playerIdx = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        if (playerIdx === -1) return;

        game.players[playerIdx].isConnected = false;
        await game.save();

        socket.to(socket.currentRoom).emit('player-disconnected', {
          username: socket.user.username,
          message: `${socket.user.username} disconnected. Waiting 60 seconds for reconnect...`
        });

        const timer = setTimeout(async () => {
          const freshGame = await Game.findOne({ roomCode: socket.currentRoom, status: 'active' });
          if (!freshGame) return;

          const disconnectedIdx = freshGame.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
          if (disconnectedIdx === -1 || freshGame.players[disconnectedIdx].isConnected) return;

          const opponentIdx = disconnectedIdx === 0 ? 1 : 0;
          const winnerId = freshGame.players[opponentIdx].user;
          const loserId = socket.user._id;

          const pot = freshGame.betAmount * 2;
          const platformFee = Math.floor(pot * (parseInt(process.env.PLATFORM_FEE_PERCENT || 5) / 100));
          const winAmount = pot - platformFee;

          freshGame.status = 'finished';
          freshGame.winner = winnerId;
          freshGame.loser = loserId;
          freshGame.winAmount = winAmount;
          freshGame.platformFee = platformFee;
          freshGame.finishedAt = new Date();
          await freshGame.save();

          await settleGame(freshGame, winnerId, loserId, winAmount, platformFee);

          io.to(socket.currentRoom).emit('game-over', {
            reason: 'opponent_disconnected',
            winner: { id: winnerId },
            loser: { id: loserId, username: socket.user.username },
            winAmount,
            message: `${socket.user.username} disconnected. You win!`
          });
        }, 60000);

        if (!activeRooms.has(socket.currentRoom)) activeRooms.set(socket.currentRoom, {});
        activeRooms.get(socket.currentRoom).disconnectTimer = timer;
      } catch (err) {
        console.error('disconnect handler error:', err);
      }
    });

    socket.on('reconnect-room', async ({ roomCode }) => {
      const room = activeRooms.get(roomCode);
      if (room?.disconnectTimer) {
        clearTimeout(room.disconnectTimer);
        room.disconnectTimer = null;
      }

      const game = await Game.findOne({ roomCode }).populate('players.user', 'username');
      if (!game) return;

      const playerIdx = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
      if (playerIdx !== -1) {
        game.players[playerIdx].isConnected = true;
        await game.save();
        socket.join(roomCode);
        socket.currentRoom = roomCode;
        socket.emit('game-state', sanitizeGame(game, socket.user._id));
        socket.to(roomCode).emit('player-reconnected', { username: socket.user.username });
      }
    });
  });
};

async function settleGame(game, winnerId, loserId, winAmount, platformFee) {
  try {
    const winner = await User.findById(winnerId);
    const loser = await User.findById(loserId);

    winner.lockedBalance = Math.max(0, winner.lockedBalance - game.betAmount);
    loser.lockedBalance = Math.max(0, loser.lockedBalance - game.betAmount);
    loser.balance = Math.max(0, loser.balance - game.betAmount);

    const winnerBalanceBefore = winner.balance;
    winner.balance += winAmount;
    winner.gamesWon += 1;
    winner.totalEarned += winAmount;
    loser.gamesPlayed += 1;
    winner.gamesPlayed += 1;
    loser.totalLost += game.betAmount;

    await winner.save();
    await loser.save();

    await Transaction.create({
      user: winnerId,
      type: 'game_win',
      amount: winAmount,
      balanceBefore: winnerBalanceBefore,
      balanceAfter: winner.balance,
      status: 'completed',
      gameId: game._id
    });

    const loserBalanceBefore = loser.balance + game.betAmount;
    await Transaction.create({
      user: loserId,
      type: 'game_loss',
      amount: game.betAmount,
      balanceBefore: loserBalanceBefore,
      balanceAfter: loser.balance,
      status: 'completed',
      gameId: game._id
    });

    await Transaction.create({
      user: winnerId,
      type: 'platform_fee',
      amount: platformFee,
      balanceBefore: winner.balance,
      balanceAfter: winner.balance,
      status: 'completed',
      gameId: game._id
    });

    console.log(`Game settled: Winner ${winner.username} +₹${winAmount}, Loser ${loser.username} -₹${game.betAmount}, Fee ₹${platformFee}`);
  } catch (err) {
    console.error('Game settlement error:', err);
  }
}

function sanitizeGame(game, userId) {
  const gameObj = game.toObject ? game.toObject() : game;
  return {
    ...gameObj,
    myColor: gameObj.players.find(p => p.user._id?.toString() === userId?.toString())?.color,
    isMyTurn: gameObj.currentTurn?.toString() === userId?.toString()
  };
}
