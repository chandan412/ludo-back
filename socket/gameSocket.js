const mongoose = require('mongoose');
const Game = require('../models/Game');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const LudoEngine = require('./ludoEngine');
const jwt = require('jsonwebtoken');

const activeRooms = new Map();
const roomTimers = new Map(); // tracks 2-min auto-abort timers
const waitingGraceTimers = new Map(); // brief grace window so a refresh doesn't abort a waiting room

// ============================
// Per-room lock — serializes game-mutating handlers (roll-dice, move-token)
// so two events on the same room can never read-modify-save concurrently.
// This is what prevents the Mongoose "VersionError: No matching document...version N"
// crash and any double-move from a double-tap: the second event waits, then reads the
// already-updated game and harmlessly no-ops instead of racing the first save.
// ============================
const roomLocks = new Map(); // roomCode -> tail promise

function withRoomLock(roomCode, fn) {
  const key = String(roomCode || '').toUpperCase();
  const prev = roomLocks.get(key) || Promise.resolve();
  const result = prev.then(() => fn());
  const tail = result.catch(() => {}); // never rejects — keeps the chain alive
  roomLocks.set(key, tail);
  // drop the map entry once nothing else is queued behind us (prevents leak)
  tail.then(() => {
    if (roomLocks.get(key) === tail) roomLocks.delete(key);
  });
  return result;
}

// ============================
// CHAT setup (shared global chat room)
// ============================
const CHAT_ROOM = 'global-chat';
const chatSockets = new Set(); // socket ids currently in chat — used for the online count

// Shared chat message model (same one routes/chat.js reads history from).
const ChatMessage = require('../models/ChatMessage');

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
    // CHAT: join / leave / send / invite / invite-accepted
    // Shared global chat room — independent of game rooms, touches no game logic.
    // ============================
    const broadcastChatCount = () => {
      io.to(CHAT_ROOM).emit('chat-online-count', { count: chatSockets.size });
    };

    socket.on('join-chat', () => {
      socket.join(CHAT_ROOM);
      chatSockets.add(socket.id);
      broadcastChatCount();
    });

    socket.on('leave-chat', () => {
      socket.leave(CHAT_ROOM);
      chatSockets.delete(socket.id);
      broadcastChatCount();
    });

    // Plain text message → save + broadcast to everyone in chat
    socket.on('send-chat', async ({ text }) => {
      try {
        const clean = (text || '').toString().trim().slice(0, 200);
        if (!clean) return;
        const msg = await ChatMessage.create({
          userId:   socket.user._id,
          username: socket.user.username,
          type:     'chat',
          text:     clean,
        });
        io.to(CHAT_ROOM).emit('chat-message', {
          _id:       msg._id.toString(),
          userId:    socket.user._id.toString(),
          username:  socket.user.username,
          type:      'chat',
          text:      clean,
          createdAt: msg.createdAt,
        });
      } catch (err) {
        console.error('send-chat error:', err);
      }
    });

    // Challenge / invite card → save + broadcast so others can tap Accept
    socket.on('send-invite', async ({ betAmount, roomCode }) => {
      try {
        const amount = Number(betAmount) || 0;
        if (amount < 10 || !roomCode) return;
        const msg = await ChatMessage.create({
          userId:    socket.user._id,
          username:  socket.user.username,
          type:      'invite',
          betAmount: amount,
          roomCode:  roomCode,
          text:      '',
        });
        io.to(CHAT_ROOM).emit('chat-message', {
          _id:       msg._id.toString(),
          userId:    socket.user._id.toString(),
          username:  socket.user.username,
          type:      'invite',
          betAmount: amount,
          roomCode:  roomCode,
          createdAt: msg.createdAt,
        });
      } catch (err) {
        console.error('send-invite error:', err);
      }
    });

    // Relay invite acceptance — frontend filters so only the challenger reacts
    socket.on('invite-accepted', ({ roomCode, challengerId, acceptedBy }) => {
      io.to(CHAT_ROOM).emit('invite-accepted', { roomCode, challengerId, acceptedBy });
    });

    // ============================
    // delete-chat: ADMIN ONLY. Permanently removes a chat message for everyone.
    // The admin check is enforced HERE on the server (socket.user.role), so even a
    // forged event from a non-admin client is ignored. On success we broadcast
    // 'chat-deleted' so every connected client removes the message live.
    // ============================
    socket.on('delete-chat', async ({ messageId } = {}) => {
      try {
        if (!socket.user || socket.user.role !== 'admin') return; // only admins may delete
        if (!messageId) return;
        await ChatMessage.findByIdAndDelete(messageId);
        io.to(CHAT_ROOM).emit('chat-deleted', { messageId: messageId.toString() });
      } catch (err) {
        console.error('delete-chat error:', err);
      }
    });

    // ============================
    // created-room: fired by creator right after creating a game
    // Starts the 2-minute waiting countdown
    // ============================
    socket.on('created-room', async ({ roomCode }) => {
      try {
        socket.join(roomCode);
        socket.currentRoom = roomCode;

        // Start 2-minute auto-abort countdown
        startWaitingTimer(io, roomCode);

        console.log(`${socket.user.username} created room ${roomCode}, waiting timer started`);
      } catch (err) {
        console.error('created-room error:', err);
        socket.emit('error', { message: 'Failed to initialize room' });
      }
    });

    // ============================
    // join-room: fired when a player enters an existing room
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

        // ✅ Player came back (e.g. from a refresh) — cancel any pending
        // waiting-room grace abort so their room isn't killed.
        const gt = waitingGraceTimers.get(roomCode);
        if (gt) { clearTimeout(gt); waitingGraceTimers.delete(roomCode); }

        socket.emit('game-state', sanitizeGame(game, socket.user._id));
        socket.to(roomCode).emit('player-connected', { username: socket.user.username });

        // ✅ ANTI-CHEAT resync: if it's this player's turn and they already rolled
        // (lastDiceRoll set), restore the dice + valid moves on their refreshed UI
        // so they can't re-roll and don't get a blank dice.
        if (game.status === 'active' &&
            game.lastDiceRoll !== null && game.lastDiceRoll !== undefined &&
            game.currentTurn.toString() === socket.user._id.toString()) {
          const pIdx = playerIdx;
          const oIdx = pIdx === 0 ? 1 : 0;
          if (game.players[oIdx]) {
            const existing = LudoEngine.getValidMoves(game.players[pIdx], game.lastDiceRoll, game.players[oIdx]);
            socket.emit('dice-rolled', {
              diceRoll:       game.lastDiceRoll,
              playerId:       socket.user._id,
              playerUsername: socket.user.username,
              validMoves:     existing.map(m => ({ tokenIndex: m.tokenIndex, newProgress: m.newProgress, canCapture: m.canCapture })),
              hasValidMoves:  existing.length > 0,
              currentTurn:    game.currentTurn.toString(),
              resync:         true,
            });
          }
        }

        // ✅ Count connected players — if both are in, cancel the waiting timer
        const connectedCount = game.players.filter(p => p.isConnected).length;
        if (connectedCount >= 2) {
          cancelWaitingTimer(roomCode);

          const creatorId    = game.players[0]?.user?._id?.toString();
          const opponentName = game.players[1]?.user?.username;

          io.to(roomCode).emit('opponent-joined', {
            username: socket.user.username,
            message: 'Opponent joined! Game starting...',
            roomCode,      // ✅ so a global "game started" banner knows which room to open
            creatorId,     // ✅ so ONLY the creator shows the join banner (not the joiner)
            opponentName,  // ✅ who just joined
          });

          // ✅ Tell the global chat this invite's room is now full → the matching
          // invite card flips to green / "Accepted" for everyone in chat.
          io.to(CHAT_ROOM).emit('invite-filled', {
            roomCode,
            acceptedBy: opponentName || socket.user.username,
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
      await withRoomLock(roomCode, async () => {
      try {
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .populate('players.user', 'username');

        if (!game || game.status !== 'active')
          return socket.emit('error', { message: 'Game not active' });

        if (game.currentTurn.toString() !== socket.user._id.toString())
          return socket.emit('error', { message: 'Not your turn' });

        // ✅ ANTI-CHEAT: if a dice value is already committed for this turn (player
        // refreshed or re-emitted roll-dice), DO NOT roll again. Re-send the existing
        // value + valid moves so the UI restores, but the number cannot change.
        if (game.lastDiceRoll !== null && game.lastDiceRoll !== undefined) {
          const pIdx = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
          const oIdx = pIdx === 0 ? 1 : 0;
          const existing = LudoEngine.getValidMoves(game.players[pIdx], game.lastDiceRoll, game.players[oIdx]);
          socket.emit('dice-rolled', {
            diceRoll:       game.lastDiceRoll,
            playerId:       socket.user._id,
            playerUsername: socket.user.username,
            validMoves:     existing.map(m => ({ tokenIndex: m.tokenIndex, newProgress: m.newProgress, canCapture: m.canCapture })),
            hasValidMoves:  existing.length > 0,
            currentTurn:    game.currentTurn.toString(),
            resync:         true,
          });
          return;
        }

        const playerIdx   = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        const opponentIdx = playerIdx === 0 ? 1 : 0;
        const playerState   = game.players[playerIdx];
        const opponentState = game.players[opponentIdx];

        // ✅ If player already has 2 consecutive sixes, 3rd roll must NOT be six — reroll until non-six
        let diceRoll = LudoEngine.rollDice();
        if ((game.consecutiveSixes || 0) >= 2) {
          while (diceRoll === 6) {
            diceRoll = LudoEngine.rollDice();
          }
        }
        game.lastDiceRoll = diceRoll;

        if (diceRoll === 6) {
          game.consecutiveSixes = (game.consecutiveSixes || 0) + 1;
        } else {
          game.consecutiveSixes = 0;
        }

        const validMoves = LudoEngine.getValidMoves(playerState, diceRoll, opponentState);

        // No valid moves — emit the rolled number, then pass the turn AFTER a short
        // delay so both players can actually SEE the number on the dice. Previously
        // 'turn-passed' was emitted in the same instant as 'dice-rolled', and the
        // client's turn-passed handler cleared the dice immediately — so the number
        // flashed for a few ms and the player never saw it on a no-move roll.
        if (validMoves.length === 0) {
          game.currentTurn  = opponentState.user._id;
          game.lastDiceRoll = null;
          await game.save();

          // 1) Show the number to BOTH players right away.
          io.to(roomCode).emit('dice-rolled', {
            diceRoll,
            playerId: socket.user._id,
            playerUsername: socket.user.username,
            validMoves: [],
            hasValidMoves: false,
            currentTurn: game.currentTurn.toString(),
          });

          // 2) Pass the turn ~1.5s later, so the dice number stays visible first.
          //    (The turn is already committed in the DB above; this only controls
          //    when the clients are told to clear the dice and move on.)
          const passRoom = roomCode;
          const passPayload = {
            reason: 'No valid moves',
            nextTurn: opponentState.user._id.toString(),
            nextTurnUsername: opponentState.user.username,
          };
          setTimeout(() => {
            io.to(passRoom).emit('turn-passed', passPayload);
          }, 1500);
          return;
        }

        await game.save();

        io.to(roomCode).emit('dice-rolled', {
          diceRoll,
          playerId: socket.user._id,
          playerUsername: socket.user.username,
          validMoves: validMoves.map(m => ({
            tokenIndex: m.tokenIndex,
            newProgress: m.newProgress,
            canCapture: m.canCapture,
          })),
          hasValidMoves: true,
          currentTurn: game.currentTurn.toString(),
        });

      } catch (err) {
        console.error('roll-dice error:', err);
        socket.emit('error', { message: 'Server error' });
      }
      });
    });

    // ============================
    // move-token
    // ============================
    socket.on('move-token', async ({ roomCode, tokenIndex }) => {
      await withRoomLock(roomCode, async () => {
      try {
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .populate('players.user', 'username');

        if (!game || game.status !== 'active')
          return socket.emit('error', { message: 'Game not active' });

        if (game.currentTurn.toString() !== socket.user._id.toString())
          return socket.emit('error', { message: 'Not your turn' });

        // ✅ FIX: Capture diceRoll into a local variable FIRST before nulling game.lastDiceRoll
        const diceRoll = game.lastDiceRoll;
        if (diceRoll === null || diceRoll === undefined)
          return socket.emit('error', { message: 'Roll dice first' });

        const playerIdx   = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        const opponentIdx = playerIdx === 0 ? 1 : 0;
        const playerState   = game.players[playerIdx];
        const opponentState = game.players[opponentIdx];

        // ✅ FIX: Use local diceRoll variable (not game.lastDiceRoll) for all validation & logic
        const validMoves = LudoEngine.getValidMoves(playerState, diceRoll, opponentState);
        const move = validMoves.find(m => m.tokenIndex === tokenIndex);
        if (!move) return socket.emit('error', { message: 'Invalid move' });

        // ✅ FIX: Use local diceRoll variable here too
        const result = LudoEngine.applyMove(playerState, opponentState, tokenIndex, diceRoll);

        game.players[playerIdx].tokens         = result.newPlayerTokens;
        game.players[playerIdx].finishedTokens = result.finishedCount;
        game.players[opponentIdx].tokens       = result.newOpponentTokens;

        game.moveHistory.push({
          player: socket.user._id,
          dice: diceRoll, // ✅ FIX: use local variable
          tokenIndex,
          fromPosition: move.currentProgress,
          toPosition:   move.newProgress,
        });

        // ✅ FIX: Null lastDiceRoll AFTER all logic that depends on it is done
        game.lastDiceRoll = null;

        const moveData = {
          playerId: socket.user._id.toString(),
          playerUsername: socket.user.username,
          tokenIndex,
          fromProgress:  move.currentProgress,
          toProgress:    move.newProgress,
          captured:      result.captured,
          extraTurn:     result.extraTurn,
          finishedCount: result.finishedCount,
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
            winner: { id: socket.user._id.toString(), username: socket.user.username },
            loser:  { id: opponentState.user._id.toString(), username: opponentState.user.username },
            winAmount,
            platformFee,
            pot,
          });
          return;
        }

        if (result.extraTurn) {
          game.currentTurn = socket.user._id;
          // ✅ FIX: Use local diceRoll variable (game.lastDiceRoll is already null here)
          if (diceRoll !== 6 && result.captured) {
            game.consecutiveSixes = 0;
          }
        } else {
          game.currentTurn      = opponentState.user._id;
          game.consecutiveSixes = 0; // ✅ reset when turn passes to opponent
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
    });

    // ============================
    // forfeit: player intentionally exits an ACTIVE game (pressed the Exit button).
    // The exiting player LOSES their bet and the opponent WINS immediately. Money is
    // settled here and a game-over is broadcast to both players in real time.
    // NOTE: this is NOT a network disconnect — a disconnect gives a 60s rejoin window
    // and is handled separately in the disconnect handler below.
    // ============================
    socket.on('forfeit', async ({ roomCode }) => {
      try {
        // ✅ Atomic + membership guard in one step: only proceed if the game is still
        // ACTIVE and this user is actually a player in it. Flipping to 'finished'
        // atomically means a forfeit can NEVER double-settle (e.g. racing a normal
        // win or a disconnect-timeout win) — whichever flips it first wins, the rest
        // match nothing and no-op.
        const game = await Game.findOneAndUpdate(
          { roomCode: roomCode.toUpperCase(), status: 'active', 'players.user': socket.user._id },
          { $set: { status: 'finished', finishedAt: new Date() } },
          { new: true }
        ).populate('players.user', 'username');

        if (!game) return; // not an active game this player is in (already over, etc.)

        const loserIdx  = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        const winnerIdx = loserIdx === 0 ? 1 : 0;
        const winnerId  = game.players[winnerIdx].user._id;
        const loserId   = game.players[loserIdx].user._id;

        const pot         = game.betAmount * 2;
        const platformFee = Math.floor(pot * (parseInt(process.env.PLATFORM_FEE_PERCENT || 5) / 100));
        const winAmount   = pot - platformFee;

        game.winner      = winnerId;
        game.loser       = loserId;
        game.winAmount   = winAmount;
        game.platformFee = platformFee;
        await game.save();

        // Same settlement as a normal win: loser loses their bet, winner gets pot − fee.
        await settleGame(game, winnerId, loserId, winAmount, platformFee);

        io.to(roomCode).emit('game-over', {
          reason:      'forfeit',
          winner:      { id: winnerId.toString(), username: game.players[winnerIdx].user.username },
          loser:       { id: loserId.toString(),  username: game.players[loserIdx].user.username },
          winAmount,
          platformFee,
          pot,
        });

        console.log(`Forfeit: ${game.players[loserIdx].user.username} exited, ${game.players[winnerIdx].user.username} wins ₹${winAmount}`);
      } catch (err) {
        console.error('forfeit error:', err);
        socket.emit('error', { message: 'Failed to forfeit' });
      }
    });

    // ============================
    // player-away / player-back
    // The client emits these on visibilitychange (app backgrounded / tab hidden,
    // then returned) WHILE the socket is still alive. We use them to tell apart
    // "stepped away, will be back" from a real network drop:
    //   • away signalled  → a later disconnect is treated as "away" (calm)
    //   • no away signal  → a disconnect is treated as "network" (Wi-Fi alarm)
    // This changes ONLY the label/icon shown to the opponent — it does NOT touch
    // isConnected, the 60s reconnect timer, or any money logic.
    // ============================
    socket.on('player-away', ({ roomCode } = {}) => {
      socket._away = true;
      const room = roomCode || socket.currentRoom;
      if (room) socket.to(room).emit('opponent-away', { username: socket.user.username });
    });

    socket.on('player-back', ({ roomCode } = {}) => {
      socket._away = false;
      const room = roomCode || socket.currentRoom;
      if (room) socket.to(room).emit('opponent-back', { username: socket.user.username });
    });

    // ============================
    // disconnect
    // ============================
    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${socket.user.username}`);

      // ✅ Chat cleanup — must run BEFORE the game-room early-return below,
      // because chat-only users never have socket.currentRoom set.
      if (chatSockets.has(socket.id)) {
        chatSockets.delete(socket.id);
        io.to(CHAT_ROOM).emit('chat-online-count', { count: chatSockets.size });
      }

      if (!socket.currentRoom) return;

      try {
        const game = await Game.findOne({ roomCode: socket.currentRoom })
          .populate('players.user', 'username');

        if (!game) return;

        // ✅ If the game is already over (player forfeited via Exit, or it finished
        // normally), there is nothing to do on disconnect — don't fire a spurious
        // "opponent disconnected" or start a 60s timer.
        if (game.status !== 'waiting' && game.status !== 'active') return;

        const playerIdx = game.players.findIndex(
          p => p.user._id.toString() === socket.user._id.toString()
        );
        if (playerIdx === -1) return;

        // ✅ SCENARIO 1: Player disconnects while room is still WAITING.
        // Do NOT abort immediately — a page refresh looks identical to leaving.
        // Give a short grace window; if they don't reconnect (join-room clears this),
        // THEN abort + refund. The existing 2-min timer still backstops truly idle rooms.
        if (game.status === 'waiting') {
          game.players[playerIdx].isConnected = false;
          await game.save();

          const roomForGrace = socket.currentRoom;
          const graceTimer = setTimeout(async () => {
            waitingGraceTimers.delete(roomForGrace);
            try {
              const fresh = await Game.findOne({ roomCode: roomForGrace, status: 'waiting' });
              if (!fresh) return; // already started (opponent joined) or aborted — nothing to do

              // Still waiting and creator never came back → abort + refund.
              cancelWaitingTimer(roomForGrace);
              fresh.status = 'aborted';
              fresh.finishedAt = new Date();
              await fresh.save();

              const creator = await User.findById(fresh.players[0].user);
              if (creator) {
                const before = creator.balance;
                creator.lockedBalance = Math.max(0, creator.lockedBalance - fresh.betAmount);
                await creator.save();
                await Transaction.create({
                  user: creator._id,
                  type: 'refund',
                  amount: fresh.betAmount,
                  balanceBefore: before,
                  balanceAfter: creator.balance,
                  status: 'completed',
                  gameId: fresh._id,
                });
              }

              io.to(roomForGrace).emit('game-aborted', {
                reason: 'creator_left',
                message: 'Room creator left. Game aborted. Bet refunded.',
              });
            } catch (e) {
              console.error('waiting grace abort error:', e);
            }
          }, 20000); // 20s grace — long enough to cover a refresh, short enough to free the room

          waitingGraceTimers.set(roomForGrace, graceTimer);
          return; // don't run the active-game 60s logic below
        }

        // ✅ SCENARIO 2: Player disconnects during active game → 60s reconnect window
        game.players[playerIdx].isConnected = false;
        await game.save();

        // ✅ Was this a deliberate "step away" (backgrounded, socket later dropped),
        // or an unexpected network drop? Drives a calm "away" UI vs a Wi-Fi alarm on
        // the opponent's screen. The 60s reconnect→forfeit window is identical either way.
        const wasAway = socket._away === true;
        socket.to(socket.currentRoom).emit('player-disconnected', {
          username: socket.user.username,
          reason: wasAway ? 'away' : 'network',
          message: wasAway
            ? `${socket.user.username} stepped away. Waiting 60s...`
            : `${socket.user.username} lost connection. Waiting 60s for reconnect...`,
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
    // reconnect-room: player comes back within 60s
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
