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
function startWaitingTimer(io, roomCode, remainingSecondsOverride) {
  // ✅ Guard against double-start: if `created-room` fires twice (socket reconnect,
  // accidental double-emit), don't spawn a second timer for the same room.
  if (roomTimers.has(roomCode)) {
    console.log(`[timer] already running for ${roomCode}, skipping double-start`);
    return;
  }
  // ✅ Accept an override for resume-on-startup: lets us start a timer with
  // whatever time is still left (instead of always 120s).
  let remainingSeconds = (typeof remainingSecondsOverride === 'number' && remainingSecondsOverride > 0)
    ? Math.floor(remainingSecondsOverride)
    : 120;
  const WAIT_DURATION = remainingSeconds * 1000;

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
      // ✅ Atomic: only succeeds if game is still waiting (prevents double refund if user cancelled)
      const game = await Game.findOneAndUpdate(
        { roomCode, status: 'waiting' },
        { $set: { status: 'aborted', finishedAt: new Date() } },
        { new: true }
      );
      if (!game) return; // already started or aborted

      // Refund creator
      const creator = await User.findById(game.players[0].user);
      if (creator) {
        const before = creator.balance;
        // ✅ FIX: Only reduce lockedBalance — balance was never deducted
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

  // ✅ On server startup: scan DB for any games still in `waiting` status and
  // restart their 2-minute auto-abort timers. Without this, a Railway restart
  // mid-wait would leave games orphaned forever (locked balance never refunded).
  // Runs async so it doesn't block io setup.
  (async function resumeTimersOnStartup() {
    try {
      const waitingGames = await Game.find({ status: 'waiting' });
      let resumed = 0, expired = 0;
      for (const game of waitingGames) {
        const elapsedMs = Date.now() - new Date(game.createdAt).getTime();
        const remainingSec = Math.max(0, 120 - Math.floor(elapsedMs / 1000));
        if (remainingSec <= 0) {
          // Past deadline — abort immediately + refund creator
          try {
            const aborted = await Game.findOneAndUpdate(
              { roomCode: game.roomCode, status: 'waiting' },
              { $set: { status: 'aborted', finishedAt: new Date() } },
              { new: true }
            );
            if (aborted && aborted.players[0]) {
              const creator = await User.findById(aborted.players[0].user);
              if (creator) {
                const before = creator.balance;
                creator.lockedBalance = Math.max(0, creator.lockedBalance - aborted.betAmount);
                await creator.save();
                await Transaction.create({
                  user: creator._id,
                  type: 'refund',
                  amount: aborted.betAmount,
                  balanceBefore: before,
                  balanceAfter: creator.balance,
                  status: 'completed',
                  gameId: aborted._id,
                });
              }
              expired++;
            }
          } catch (e) {
            console.error('startup-abort error:', e);
          }
        } else {
          // Still time left — restart timer with the remaining seconds
          startWaitingTimer(io, game.roomCode, remainingSec);
          resumed++;
        }
      }
      if (resumed || expired) {
        console.log(`🔄 Startup: resumed ${resumed} waiting timers, aborted ${expired} expired`);
      }
    } catch (err) {
      console.error('resumeTimersOnStartup error:', err);
    }
  })();

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
        // ✅ Detect reconnect BEFORE flipping isConnected — we need the old value
        const wasDisconnected = game.players[playerIdx].isConnected === false;
        game.players[playerIdx].isConnected = true;
        await game.save();

        // ✅ If the player was in the disconnect grace window, cancel pending timers
        // so we don't auto-forfeit them seconds after they returned. Covers both:
        //  - 60s active-game reconnect timer (activeRooms[room].disconnectTimer)
        //  - 15s waiting-room grace timer (activeRooms[room].waitingGraceTimer)
        const roomState = activeRooms.get(roomCode);
        if (roomState) {
          if (roomState.disconnectTimer) {
            clearTimeout(roomState.disconnectTimer);
            roomState.disconnectTimer = null;
          }
          if (roomState.waitingGraceTimer) {
            clearTimeout(roomState.waitingGraceTimer);
            roomState.waitingGraceTimer = null;
          }
        }

        socket.emit('game-state', sanitizeGame(game, socket.user._id));

        // ✅ ANTI-CHEAT: If a dice roll is pending, resend the dice value to whoever is reconnecting
        // (both rolling player AND opponent need to see the current dice value after refresh).
        if (
          game.status === 'active' &&
          game.lastDiceRoll !== null &&
          game.lastDiceRoll !== undefined
        ) {
          const rollerIdx = game.players.findIndex(p => p.user._id.toString() === game.currentTurn?.toString());
          if (rollerIdx !== -1) {
            const rollerOppIdx  = rollerIdx === 0 ? 1 : 0;
            const rollerState   = game.players[rollerIdx];
            const opponentState = game.players[rollerOppIdx];
            const isRoller = game.currentTurn?.toString() === socket.user._id.toString();

            // Compute valid moves only for the rolling player (opponent gets empty list)
            const validMoves = isRoller
              ? LudoEngine.getValidMoves(rollerState, game.lastDiceRoll, opponentState)
              : [];

            socket.emit('dice-rolled', {
              diceRoll: game.lastDiceRoll,
              playerId: rollerState.user._id,
              playerUsername: rollerState.user.username,
              validMoves: validMoves.map(m => ({
                tokenIndex: m.tokenIndex,
                newProgress: m.newProgress,
                canCapture: m.canCapture,
              })),
              hasValidMoves: validMoves.length > 0,
              resumed: true, // marks this as a state-restore, not a fresh roll
              currentTurn: game.currentTurn.toString(),
            });
          }
        }

        // ✅ Notify the opponent. If this is a reconnect (we were marked disconnected),
        // emit `player-reconnected` so the opponent's "waiting 60s..." banner clears.
        // Otherwise it's a first-time join and we emit `player-connected` as before.
        if (wasDisconnected) {
          socket.to(roomCode).emit('player-reconnected', { username: socket.user.username });
        } else {
          socket.to(roomCode).emit('player-connected', { username: socket.user.username });
        }

        // ✅ Count connected players — if both are in, cancel the waiting timer
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

        // ✅ ANTI-CHEAT: Block re-roll if a dice value is already pending
        if (game.lastDiceRoll !== null && game.lastDiceRoll !== undefined) {
          // Re-emit existing value so client recovers state — don't roll again
          return socket.emit('dice-rolled', {
            diceRoll: game.lastDiceRoll,
            playerId: socket.user._id,
            playerUsername: socket.user.username,
            validMoves: LudoEngine.getValidMoves(
              game.players.find(p => p.user._id.toString() === socket.user._id.toString()),
              game.lastDiceRoll,
              game.players.find(p => p.user._id.toString() !== socket.user._id.toString())
            ).map(m => ({ tokenIndex: m.tokenIndex, newProgress: m.newProgress, canCapture: m.canCapture })),
            hasValidMoves: true,
            currentTurn: game.currentTurn.toString(),
          });
        }

        const playerIdx   = game.players.findIndex(p => p.user._id.toString() === socket.user._id.toString());
        const opponentIdx = playerIdx === 0 ? 1 : 0;
        const playerState   = game.players[playerIdx];
        const opponentState = game.players[opponentIdx];

        // ✅ If player already has 2 consecutive sixes, 3rd roll must NOT be six — reroll until non-six
        let diceRoll = LudoEngine.rollDice();
        let thirdSixBlocked = false;
        if ((game.consecutiveSixes || 0) >= 2) {
          while (diceRoll === 6) {
            diceRoll = LudoEngine.rollDice();
            thirdSixBlocked = true;
          }
        }
        game.lastDiceRoll = diceRoll;

        if (diceRoll === 6) {
          game.consecutiveSixes = (game.consecutiveSixes || 0) + 1;
        } else {
          game.consecutiveSixes = 0;
        }

        const validMoves = LudoEngine.getValidMoves(playerState, diceRoll, opponentState);

        // ✅ DIAGNOSTIC: catch the bug where dice=6 returns 0 moves but home tokens exist
        if (validMoves.length === 0 && diceRoll === 6) {
          const tokensSummary = playerState.tokens.map(t => ({
            pos: t.position, isHome: t.isHome, isFinished: t.isFinished
          }));
          console.log('⚠️ ENGINE ANOMALY: dice=6 returned 0 moves. Player tokens:',
            JSON.stringify(tokensSummary));

          // ✅ DEFENSIVE FIX: For each home token (position=-1 OR isHome=true OR position=null),
          // manually add an exit-home move. This catches Mongoose field-type drift.
          playerState.tokens.forEach((t, idx) => {
            if (t.isFinished) return;
            const isInHome = t.position === -1
                          || t.position === null
                          || t.position === undefined
                          || t.isHome === true
                          || isNaN(Number(t.position));
            if (isInHome) {
              const globalPos = LudoEngine.getGlobalPosition(playerState.color, 0);
              const canCapture = LudoEngine.canCapture(globalPos, opponentState);
              validMoves.push({
                tokenIndex: idx,
                currentProgress: -1,
                newProgress: 0,
                canCapture,
                willFinish: false,
              });
            }
          });
          if (validMoves.length > 0) {
            console.log('✅ Recovered ' + validMoves.length + ' moves via defensive fix');
          }
        }

        // No valid moves — pass turn instantly
        if (validMoves.length === 0) {
          game.currentTurn  = opponentState.user._id;
          game.lastDiceRoll = null;
          await game.save();

          io.to(roomCode).emit('dice-rolled', {
            diceRoll,
            playerId: socket.user._id,
            playerUsername: socket.user.username,
            validMoves: [],
            hasValidMoves: false,
            currentTurn: game.currentTurn.toString(),
          });

          io.to(roomCode).emit('turn-passed', {
            reason: 'No valid moves',
            nextTurn: opponentState.user._id.toString(),
            nextTurnUsername: opponentState.user.username,
          });
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
          thirdSixBlocked, // ✅ tells frontend the 3rd-six rule kicked in
          currentTurn: game.currentTurn.toString(),
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
        // ✅ Atomic: read game + null lastDiceRoll in one op so double-click can't double-move
        const game = await Game.findOneAndUpdate(
          {
            roomCode: roomCode.toUpperCase(),
            status: 'active',
            currentTurn: socket.user._id,
            lastDiceRoll: { $ne: null },
          },
          { $set: { lastDiceRoll: null } },
          { new: false } // return pre-update doc so we still have diceRoll
        ).populate('players.user', 'username');

        if (!game) {
          // Either not active, not your turn, or dice was already nulled (double-click race)
          return socket.emit('error', { message: 'Move rejected: not your turn or dice already consumed' });
        }

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

        // Already nulled in DB by findOneAndUpdate above — reassert in-memory for the upcoming save
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

    // ============================
    // forfeit-notify: client calls REST /forfeit endpoint first,
    // then emits this so opponent learns in real-time
    // ============================
    socket.on('forfeit-notify', async ({ roomCode }) => {
      try {
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .populate('players.user', 'username')
          .populate('winner', 'username');

        if (!game || game.status !== 'finished') return;

        const winnerUser = game.players.find(p =>
          p.user._id.toString() === game.winner?._id?.toString()
        )?.user;
        const loserUser = game.players.find(p =>
          p.user._id.toString() === game.loser?.toString()
        )?.user;

        io.to(roomCode).emit('game-over', {
          reason:  'forfeit',
          winner:  { id: game.winner?._id?.toString(), username: winnerUser?.username },
          loser:   { id: game.loser?.toString(), username: loserUser?.username },
          winAmount: game.winAmount,
          platformFee: game.platformFee,
          message: `${loserUser?.username || 'Opponent'} forfeited. ${winnerUser?.username || 'You'} win!`,
        });
      } catch (err) {
        console.error('forfeit-notify error:', err);
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

        // ✅ SCENARIO 1: Player drops while room is still waiting.
        // OLD behaviour: instant abort + refund — but a browser refresh / brief
        // network blip would kill the room and force the creator to start over.
        // NEW behaviour: 15-second grace window. If they reconnect within 15s
        // (via join-room → cancels this timer above), the room survives. Otherwise
        // we abort + refund EXACTLY as before.
        if (game.status === 'waiting') {
          // Don't cancel the 2-min waiting timer yet — if they reconnect, it should
          // keep ticking from wherever it was. cancelWaitingTimer happens only on
          // confirmed abort below.

          const graceTimer = setTimeout(async () => {
            try {
              // Re-check status — they may have rejoined, or another path may have aborted/started the game
              const stillWaiting = await Game.findOne({ roomCode: socket.currentRoom, status: 'waiting' });
              if (!stillWaiting) return;
              const creatorPlayer = stillWaiting.players[0];
              if (!creatorPlayer) return;
              // If the disconnected user is no longer marked offline, they returned — abort the abort.
              if (creatorPlayer.user.toString() === socket.user._id.toString() &&
                  creatorPlayer.isConnected) {
                return;
              }

              cancelWaitingTimer(socket.currentRoom); // stop the 2-min countdown now

              const aborted = await Game.findOneAndUpdate(
                { roomCode: socket.currentRoom, status: 'waiting' },
                { $set: { status: 'aborted', finishedAt: new Date() } },
                { new: true }
              );
              if (!aborted) return; // someone else already aborted/cancelled

              // Refund creator (only creator has paid at this point)
              const creator = await User.findById(aborted.players[0].user);
              if (creator) {
                const before = creator.balance;
                // ✅ Only reduce lockedBalance — balance was never deducted
                creator.lockedBalance = Math.max(0, creator.lockedBalance - aborted.betAmount);
                await creator.save();

                await Transaction.create({
                  user: creator._id,
                  type: 'refund',
                  amount: aborted.betAmount,
                  balanceBefore: before,
                  balanceAfter: creator.balance,
                  status: 'completed',
                  gameId: aborted._id,
                });
              }

              io.to(socket.currentRoom).emit('game-aborted', {
                reason: 'creator_left',
                message: 'Room creator left. Game aborted. Bet refunded.',
              });
            } catch (e) {
              console.error('waiting-grace abort error:', e);
            } finally {
              const rs = activeRooms.get(socket.currentRoom);
              if (rs) rs.waitingGraceTimer = null;
            }
          }, 15000); // 15 seconds — enough for a browser refresh / network blip recovery

          if (!activeRooms.has(socket.currentRoom)) activeRooms.set(socket.currentRoom, {});
          activeRooms.get(socket.currentRoom).waitingGraceTimer = graceTimer;

          // Mark the player offline so join-room can detect the reconnect and clear the timer
          game.players[playerIdx].isConnected = false;
          await game.save();

          return; // stop here — abort happens via the grace timer (or doesn't, if they return)
        }

        // ✅ SCENARIO 2: Player disconnects during active game → 60s reconnect window
        game.players[playerIdx].isConnected = false;
        await game.save();

        socket.to(socket.currentRoom).emit('player-disconnected', {
          username: socket.user.username,
          message: `${socket.user.username} disconnected. Waiting 60 seconds for reconnect...`,
        });

        const timer = setTimeout(async () => {
          // ✅ Atomic: only succeeds if game is still active (prevents double settle if forfeit/move happened)
          const freshGame = await Game.findOneAndUpdate(
            { roomCode: socket.currentRoom, status: 'active' },
            { $set: { status: 'finished', finishedAt: new Date() } },
            { new: true }
          );
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

          freshGame.winner      = winnerId;
          freshGame.loser       = loserId;
          freshGame.winAmount   = winAmount;
          freshGame.platformFee = platformFee;
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
