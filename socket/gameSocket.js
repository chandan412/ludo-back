const Game = require('../models/Game');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const LudoEngine = require('./ludoEngine');
const jwt = require('jsonwebtoken');

const activeRooms = new Map();
const roomTimers = new Map(); // tracks 2-min auto-abort timers

// ============================
// Helper: Start 2-min waiting timer with live countdown
// ============================
function startWaitingTimer(io, roomCode) {
  const WAIT_DURATION = 2 * 60 * 1000; // 2 minutes
  let remainingSeconds = 120;

  // Emit countdown every second
  const tickInterval = setInterval(() => {
    remainingSeconds -= 1;
    io.to(roomCode).emit('waiting-countdown', {
      secondsLeft: remainingSeconds,
      message: `Waiting for opponent... ${remainingSeconds}s`,
    });
    if (remainingSeconds <= 0) clearInterval(tickInterval);
  }, 1000);

  // Auto-abort after 2 minutes
  const abortTimer = setTimeout(async () => {
    clearInterval(tickInterval);
    try {
      const game = await Game.findOne({ roomCode, status: 'waiting' });
      if (!game) return; // already started or aborted

      game.status = 'aborted';
      game.finishedAt = new Date();
      await game.save();

      // Refund creator
      const creator = await User.findById(game.players[0].user);
      if (creator) {
        const before = creator.balance;
        creator.balance += game.betAmount;
        creator.lockedBalance = Math.max(0, creator.lockedBalance - game.betAmount);
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
        message: 'No opponent joined in 2 minutes. Game aborted. Bet refunded.',
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
// Helper: Cancel waiting timer (when opponent joins)
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
// Helper: Settle game finances
// ============================
async function settleGame(game, winnerId, loserId, winAmount, platformFee) {
  try {
    const winner = await User.findById(winnerId);
    const loser  = await User.findById(loserId);

    winner.lockedBalance = Math.max(0, winner.lockedBalance - game.betAmount);
    loser.lockedBalance  = Math.max(0, loser.lockedBalance  - game.betAmount);
    loser.balance        = Math.max(0, loser.balance - game.betAmount);

    const winnerBalanceBefore = winner.balance;
    const netWin = game.betAmount - platformFee;
    winner.balance     += netWin;
    winner.gamesWon    += 1;
    winner.gamesPlayed += 1;
    winner.totalEarned += netWin;
    loser.gamesPlayed  += 1;
    loser.totalLost    += game.betAmount;

    await winner.save();
    await loser.save();

    await Transaction.create({
      user: winnerId,
      type: 'game_win',
      amount: netWin,
      balanceBefore: winnerBalanceBefore,
      balanceAfter:  winner.balance,
      status: 'completed',
      gameId: game._id,
    });

    const loserBalanceBefore = loser.balance + game.betAmount;
    await Transaction.create({
      user: loserId,
      type: 'game_loss',
      amount: game.betAmount,
      balanceBefore: loserBalanceBefore,
      balanceAfter:  loser.balance,
      status: 'completed',
      gameId: game._id,
    });

    await Transaction.create({
      user: winnerId,
      type: 'platform_fee',
      amount: platformFee,
      balanceBefore: winner.balance,
      balanceAfter:  winner.balance,
      status: 'completed',
      gameId: game._id,
    });

    console.log(`Game settled: Winner ${winner.username} +₹${netWin}, Loser ${loser.username} -₹${game.betAmount}, Fee ₹${platformFee}`);
  } catch (err) {
    console.error('Game settlement error:', err);
  }
}

// ============================
// Helper: Sanitize game object for client
// ============================
function sanitizeGame(game, userId) {
  const gameObj = game.toObject ? game.toObject() : game;
  return {
    ...gameObj,
    currentTurn: gameObj.currentTurn?.toString(),
    myColor: gameObj.players.find(p => p.user._id?.toString() === userId?.toString())?.color,
  };
}

// ============================
// Main socket module
// ============================
module.exports = (io) => {

  // Auth middleware
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

    // ============================
    // created-room
    // ============================
    socket.on('created-room', async ({ roomCode }) => {
      try {
        socket.join(roomCode);
        socket.currentRoom = roomCode;
        startWaitingTimer(io, roomCode);
        console.log(`${socket.user.username} created room ${roomCode}, waiting timer started`);
      } catch (err) {
        console.error('created-room error:', err);
        socket.emit('error', { message: 'Failed to initialize room' });
      }
    });

    // ============================
    // join-room
    // ============================
    socket.on('join-room', async ({ roomCode }) => {
      try {
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .populate('players.user', 'username gamesPlayed gamesWon');

        if (!game) return socket.emit('error', { message: 'Game not found' });

        const isPlayer = game.players.some(
          p => p.user._id.toString() === socket.user._id.toString()
        );
        if (!isPlayer) return socket.emit('error', { message: 'Not a player in this game' });

        socket.join(roomCode);
        socket.currentRoom = roomCode;

        const playerIdx = game.players.findIndex(
          p => p.user._id.toString() === socket.user._id.toString()
        );
        game.players[playerIdx].isConnected = true;
        await game.save();

        // ✅ BUG3 FIX: sanitizeGame spreads lastDiceRoll — frontend uses it to restore dice state
        socket.emit('game-state', sanitizeGame(game, socket.user._id));
        socket.to(roomCode).emit('player-connected', { username: socket.user.username });

        const connectedCount = game.players.filter(p => p.isConnected).length;
        if (connectedCount >= 2) {
          cancelWaitingTimer(roomCode);
          io.to(roomCode).emit('opponent-joined', {
            username: socket.user.username,
            message: 'Opponent joined! Game starting...',
          });
        }

        console.log(`${socket.user.username} joined room ${roomCode}`);
      } catch (err) {
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    // ============================
    // roll-dice
    // ============================
    socket.on('roll-dice', async ({ roomCode }) => {
      try {
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .populate('players.user', 'username');

        if (!game || game.status !== 'active')
          return socket.emit('error', { message: 'Game not active' });

        if (game.currentTurn.toString() !== socket.user._id.toString())
          return socket.emit('error', { message: 'Not your turn' });

        // ✅ BUG3 FIX: If lastDiceRoll already exists, player already rolled — send it back
        // This prevents re-rolling after refresh (anti-cheat)
        if (game.lastDiceRoll !== null && game.lastDiceRoll !== undefined) {
          const playerIdx   = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
          const opponentIdx = playerIdx === 0 ? 1 : 0;
          const playerState   = game.players[playerIdx];
          const opponentState = game.players[opponentIdx];
          const validMoves = LudoEngine.getValidMoves(playerState, game.lastDiceRoll, opponentState);

          // Re-emit the existing roll so frontend shows it correctly
          socket.emit('dice-rolled', {
            diceRoll: game.lastDiceRoll,
            playerId: socket.user._id,
            playerUsername: socket.user.username,
            validMoves: validMoves.map(m => ({
              tokenIndex: m.tokenIndex,
              newProgress: m.newProgress,
              canCapture: m.canCapture,
            })),
            hasValidMoves: validMoves.length > 0,
            currentTurn: game.currentTurn.toString(),
            restored: true, // flag so frontend knows this is a restore
          });
          return;
        }

        const playerIdx   = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        const opponentIdx = playerIdx === 0 ? 1 : 0;
        const playerState   = game.players[playerIdx];
        const opponentState = game.players[opponentIdx];

        // Roll dice (prevent 3rd consecutive six)
        let diceRoll = LudoEngine.rollDice();
        if ((game.consecutiveSixes || 0) >= 2) {
          while (diceRoll === 6) diceRoll = LudoEngine.rollDice();
        }

        if (diceRoll === 6) {
          game.consecutiveSixes = (game.consecutiveSixes || 0) + 1;
        } else {
          game.consecutiveSixes = 0;
        }

        // ✅ BUG2 FIX: Always save lastDiceRoll FIRST before checking valid moves
        // So player sees dice face regardless of valid moves
        game.lastDiceRoll = diceRoll;

        const validMoves = LudoEngine.getValidMoves(playerState, diceRoll, opponentState);

        if (validMoves.length === 0) {
          // ✅ BUG2 FIX: Emit dice-rolled FIRST so player sees the face
          // Then after 1.5s delay, pass the turn (server-side timer)
          await game.save(); // save with lastDiceRoll set

          io.to(roomCode).emit('dice-rolled', {
            diceRoll,
            playerId:       socket.user._id,
            playerUsername: socket.user.username,
            validMoves:     [],
            hasValidMoves:  false,
            currentTurn:    game.currentTurn.toString(),
          });

          // Delay the turn-pass so player sees the dice face first
          setTimeout(async () => {
            try {
              const freshGame = await Game.findOne({ roomCode: roomCode.toUpperCase() })
                .populate('players.user', 'username');
              if (!freshGame || freshGame.status !== 'active') return;
              // Only pass if nobody moved in the meantime
              if (freshGame.lastDiceRoll === diceRoll &&
                  freshGame.currentTurn.toString() === socket.user._id.toString()) {
                const fPlayerIdx   = freshGame.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
                const fOpponentIdx = fPlayerIdx === 0 ? 1 : 0;
                freshGame.currentTurn  = freshGame.players[fOpponentIdx].user._id;
                freshGame.lastDiceRoll = null;
                await freshGame.save();

                io.to(roomCode).emit('turn-passed', {
                  reason:           'No valid moves',
                  nextTurn:         freshGame.currentTurn.toString(),
                  nextTurnUsername: freshGame.players[fOpponentIdx].user.username,
                });
              }
            } catch (err) {
              console.error('turn-pass timer error:', err);
            }
          }, 1500);

          return;
        }

        await game.save();

        io.to(roomCode).emit('dice-rolled', {
          diceRoll,
          playerId:       socket.user._id,
          playerUsername: socket.user.username,
          validMoves: validMoves.map(m => ({
            tokenIndex:  m.tokenIndex,
            newProgress: m.newProgress,
            canCapture:  m.canCapture,
          })),
          hasValidMoves: true,
          currentTurn:   game.currentTurn.toString(),
        });

      } catch (err) {
        console.error('roll-dice error:', err);
        socket.emit('error', { message: 'Server error' });
      }
    });

    // ============================
    // move-token
    // ============================
    socket.on('move-token', async ({ roomCode, tokenIndex }) => {
      try {
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .populate('players.user', 'username');

        if (!game || game.status !== 'active')
          return socket.emit('error', { message: 'Game not active' });

        if (game.currentTurn.toString() !== socket.user._id.toString())
          return socket.emit('error', { message: 'Not your turn' });

        const diceRoll = game.lastDiceRoll;
        if (diceRoll === null || diceRoll === undefined)
          return socket.emit('error', { message: 'Roll dice first' });

        const playerIdx   = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        const opponentIdx = playerIdx === 0 ? 1 : 0;
        const playerState   = game.players[playerIdx];
        const opponentState = game.players[opponentIdx];

        const validMoves = LudoEngine.getValidMoves(playerState, diceRoll, opponentState);
        const move = validMoves.find(m => m.tokenIndex === tokenIndex);
        if (!move) return socket.emit('error', { message: 'Invalid move' });

        const result = LudoEngine.applyMove(playerState, opponentState, tokenIndex, diceRoll);

        game.players[playerIdx].tokens         = result.newPlayerTokens;
        game.players[playerIdx].finishedTokens = result.finishedCount;
        game.players[opponentIdx].tokens       = result.newOpponentTokens;

        game.moveHistory.push({
          player:       socket.user._id,
          dice:         diceRoll,
          tokenIndex,
          fromPosition: move.currentProgress,
          toPosition:   move.newProgress,
        });

        game.lastDiceRoll = null;

        const moveData = {
          playerId:       socket.user._id.toString(),
          playerUsername: socket.user.username,
          tokenIndex,
          fromProgress:   move.currentProgress,
          toProgress:     move.newProgress,
          captured:       result.captured,
          extraTurn:      result.extraTurn,
          finishedCount:  result.finishedCount,
        };

        // Game over
        if (result.gameOver) {
          game.status     = 'finished';
          game.winner     = socket.user._id;
          game.loser      = opponentState.user._id;
          game.finishedAt = new Date();

          const pot         = game.betAmount * 2;
          const platformFee = Math.floor(pot * (parseInt(process.env.PLATFORM_FEE_PERCENT || 5) / 100));
          const winAmount   = pot - platformFee;
          game.winAmount    = winAmount;
          game.platformFee  = platformFee;

          await game.save();
          await settleGame(game, socket.user._id, opponentState.user._id, winAmount, platformFee);

          io.to(roomCode).emit('game-over', {
            ...moveData,
            winner:      { id: socket.user._id.toString(), username: socket.user.username },
            loser:       { id: opponentState.user._id.toString(), username: opponentState.user.username },
            winAmount,
            platformFee,
            pot,
          });
          return;
        }

        if (result.extraTurn) {
          game.currentTurn = socket.user._id;
          if (diceRoll !== 6 && result.captured) game.consecutiveSixes = 0;
        } else {
          game.currentTurn      = opponentState.user._id;
          game.consecutiveSixes = 0;
        }

        await game.save();

        io.to(roomCode).emit('token-moved', {
          ...moveData,
          gameState: {
            players: game.players.map(p => ({
              userId:         p.user._id.toString(),
              username:       p.user.username,
              color:          p.color,
              tokens:         p.tokens,
              finishedTokens: p.finishedTokens,
            })),
            currentTurn:      game.currentTurn.toString(),
            nextTurnUsername: result.extraTurn ? socket.user.username : opponentState.user.username,
          },
        });

      } catch (err) {
        console.error('move-token error:', err);
        socket.emit('error', { message: 'Server error' });
      }
    });


    // ============================
    // Global chat — socket only, no DB
    // ============================
    socket.on('join-chat', () => {
      socket.join('global-chat');
      const count = io.sockets.adapter.rooms.get('global-chat')?.size || 0;
      io.to('global-chat').emit('chat-online-count', { count });
    });

    socket.on('leave-chat', () => {
      socket.leave('global-chat');
      const count = io.sockets.adapter.rooms.get('global-chat')?.size || 0;
      io.to('global-chat').emit('chat-online-count', { count });
    });

    socket.on('send-chat', ({ text }) => {
      if (!text || !text.trim() || text.length > 150) return;
      const msg = {
        userId:    socket.user._id.toString(),
        username:  socket.user.username,
        text:      text.trim(),
        createdAt: new Date().toISOString(),
      };
      io.to('global-chat').emit('chat-message', msg);
    });

    // ============================
    // player-exit: intentional exit — settle immediately, no rejoin
    // ============================
    socket.on('player-exit', async ({ roomCode }) => {
      try {
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .populate('players.user', 'username');

        if (!game || game.status !== 'active') return;

        const playerIdx   = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        if (playerIdx === -1) return;
        const opponentIdx = playerIdx === 0 ? 1 : 0;

        const winnerId  = game.players[opponentIdx].user._id;
        const loserId   = socket.user._id;
        const pot       = game.betAmount * 2;
        const platformFee = Math.floor(pot * (parseInt(process.env.PLATFORM_FEE_PERCENT || 5) / 100));
        const winAmount = pot - platformFee;

        game.status      = 'finished';
        game.winner      = winnerId;
        game.loser       = loserId;
        game.winAmount   = winAmount;
        game.platformFee = platformFee;
        game.finishedAt  = new Date();
        await game.save();

        await settleGame(game, winnerId, loserId, winAmount, platformFee);

        // Tell opponent they won — navigate them home
        socket.to(roomCode).emit('player-exited', {
          username:  socket.user.username,
          winnerId:  winnerId.toString(),
          winAmount,
        });

        console.log(`${socket.user.username} intentionally exited room ${roomCode}`);
      } catch (err) {
        console.error('player-exit error:', err);
      }
    });

    // ============================
    // disconnect
    // ============================
    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${socket.user.username}`);
      if (!socket.currentRoom) return;

      try {
        const game = await Game.findOne({ roomCode: socket.currentRoom })
          .populate('players.user', 'username');

        if (!game) return;

        const playerIdx = game.players.findIndex(
          p => p.user._id.toString() === socket.user._id.toString()
        );
        if (playerIdx === -1) return;

        if (game.status === 'waiting') {
          cancelWaitingTimer(socket.currentRoom);

          game.status = 'aborted';
          game.finishedAt = new Date();
          await game.save();

          const creator = await User.findById(game.players[0].user._id);
          if (creator) {
            const before = creator.balance;
            creator.balance += game.betAmount;
            creator.lockedBalance = Math.max(0, creator.lockedBalance - game.betAmount);
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

          io.to(socket.currentRoom).emit('game-aborted', {
            reason: 'creator_left',
            message: 'Room creator left. Game aborted. Bet refunded.',
          });

          return;
        }

        game.players[playerIdx].isConnected = false;
        await game.save();

        socket.to(socket.currentRoom).emit('player-disconnected', {
          username: socket.user.username,
          message: `${socket.user.username} disconnected. Waiting 60 seconds for reconnect...`,
        });

        const timer = setTimeout(async () => {
          const freshGame = await Game.findOne({ roomCode: socket.currentRoom, status: 'active' });
          if (!freshGame) return;

          const disconnectedIdx = freshGame.players.findIndex(
            p => p.user._id.toString() === socket.user._id.toString()
          );
          if (disconnectedIdx === -1 || freshGame.players[disconnectedIdx].isConnected) return;

          const opponentIdx = disconnectedIdx === 0 ? 1 : 0;
          const winnerId    = freshGame.players[opponentIdx].user;
          const loserId     = socket.user._id;

          const pot         = freshGame.betAmount * 2;
          const platformFee = Math.floor(pot * (parseInt(process.env.PLATFORM_FEE_PERCENT || 5) / 100));
          const winAmount   = pot - platformFee;

          freshGame.status      = 'finished';
          freshGame.winner      = winnerId;
          freshGame.loser       = loserId;
          freshGame.winAmount   = winAmount;
          freshGame.platformFee = platformFee;
          freshGame.finishedAt  = new Date();
          await freshGame.save();

          await settleGame(freshGame, winnerId, loserId, winAmount, platformFee);

          io.to(socket.currentRoom).emit('game-over', {
            reason:  'opponent_disconnected',
            winner:  { id: winnerId.toString() },
            loser:   { id: loserId.toString(), username: socket.user.username },
            winAmount,
            message: `${socket.user.username} disconnected. You win!`,
          });
        }, 60000);

        if (!activeRooms.has(socket.currentRoom)) activeRooms.set(socket.currentRoom, {});
        activeRooms.get(socket.currentRoom).disconnectTimer = timer;

      } catch (err) {
        console.error('disconnect handler error:', err);
      }
    });

    // ============================
    // reconnect-room
    // ============================
    socket.on('reconnect-room', async ({ roomCode }) => {
      try {
        const room = activeRooms.get(roomCode);
        if (room?.disconnectTimer) {
          clearTimeout(room.disconnectTimer);
          room.disconnectTimer = null;
        }

        const game = await Game.findOne({ roomCode }).populate('players.user', 'username');
        if (!game) return;

        const playerIdx = game.players.findIndex(
          p => p.user._id.toString() === socket.user._id.toString()
        );
        if (playerIdx !== -1) {
          game.players[playerIdx].isConnected = true;
          await game.save();
          socket.join(roomCode);
          socket.currentRoom = roomCode;
          socket.emit('game-state', sanitizeGame(game, socket.user._id));
          socket.to(roomCode).emit('player-reconnected', { username: socket.user.username });
        }
      } catch (err) {
        console.error('reconnect-room error:', err);
      }
    });

  }); // end io.on('connection')

}; // end module.exports
