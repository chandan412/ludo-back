const mongoose = require('mongoose');
const Game = require('../models/Game');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const LudoEngine = require('./ludoEngine');
const jwt = require('jsonwebtoken');

const activeRooms = new Map();
const roomTimers = new Map(); // tracks 2-min auto-abort timers
const waitingGraceTimers = new Map(); // brief grace window so a refresh doesn't abort a waiting room

// ============================================================================
// ⏱️ TURN INACTIVITY TIMER — anti-stalling
//
// Problem: a player who is losing simply stops taking their turn. The opponent
// has no recourse except pressing Exit, which FORFEITS their bet — so griefing
// by doing nothing was actually a winning strategy. This makes the stalling
// player lose instead.
//
// Flow (both windows tunable below):
//   turn starts ──40s no action──> WARNING broadcast to both players
//                                  └──150s more, no action──> opponent WINS
//
// "Action" means ANY move of the game forward by the current player — rolling
// the dice OR moving a token. Per-action rather than per-turn is deliberate:
// rolling and then never moving the token stalls just as effectively, and a
// per-turn timer would miss it. Sixes granting another roll legitimately extend
// a turn, and those re-arm the timer normally.
// ============================================================================
// ⚡ moveHistory is diagnostic only — nothing reads it. Capping it stops the game
// document growing without bound over a long match.
const MOVE_HISTORY_LIMIT = 50;

const TURN_GRACE_MS = 40 * 1000;   // silent window before the warning fires
const TURN_FINAL_MS = 150 * 1000;  // warned window before the turn is lost

// roomCode -> { graceTimer, finalTimer, userId, token, warned }
const turnTimers = new Map();
let turnTokenSeq = 0; // monotonic guard against a stale timer firing after a re-arm

function clearTurnTimer(roomCode, io) {
  const key = String(roomCode || '').toUpperCase();
  const t = turnTimers.get(key);
  if (!t) return;
  clearTimeout(t.graceTimer);
  clearTimeout(t.finalTimer);
  turnTimers.delete(key);
  // Tell both clients to drop any countdown they're showing.
  if (io && t.warned) io.to(key).emit('turn-timer-cleared', { roomCode: key });
}

/**
 * Arm (or re-arm) the inactivity timer for whoever currently holds the turn.
 *
 * @param onlyIfAbsent  When true, does nothing if a timer is already running.
 *   This is what stops a stalling player from REFRESHING to reset their clock:
 *   join-room passes true, so a reconnect never buys more time. Genuine actions
 *   (roll / move / turn pass) pass false and legitimately reset it.
 *
 * MONEY SAFETY: arming touches nothing. Only the final expiry settles, and it
 * does so through the same atomic status flip every other settlement path uses,
 * so it can never double-settle against a normal win, a forfeit, or a
 * disconnect timeout — whichever flips 'active' first wins and the rest no-op.
 */
function armTurnTimer(io, roomCode, userId, { onlyIfAbsent = false } = {}) {
  const key = String(roomCode || '').toUpperCase();
  if (!key || !userId) return;

  if (onlyIfAbsent && turnTimers.has(key)) return;

  clearTurnTimer(key, io);

  const uid = userId.toString();
  const token = ++turnTokenSeq;

  const graceTimer = setTimeout(async () => {
    try {
      const cur = turnTimers.get(key);
      if (!cur || cur.token !== token) return; // superseded by a newer arm

      const game = await Game.findOne({ roomCode: key, status: 'active' })
        .select('-moveHistory')
        .populate('players.user', 'username');
      // Turn already moved on (they acted) or game ended → nothing to warn about.
      if (!game || !game.currentTurn || game.currentTurn.toString() !== uid) {
        clearTurnTimer(key, io);
        return;
      }

      const stalling = game.players.find(p => p.user._id.toString() === uid);
      const waiting  = game.players.find(p => p.user._id.toString() !== uid);
      const deadlineAt = Date.now() + TURN_FINAL_MS;

      cur.warned = true;
      io.to(key).emit('turn-warning', {
        roomCode:        key,
        userId:          uid,
        username:        stalling?.user?.username || 'Player',
        opponentUsername: waiting?.user?.username || 'Opponent',
        seconds:         Math.floor(TURN_FINAL_MS / 1000),
        deadlineAt,
      });

      cur.finalTimer = setTimeout(async () => {
        try {
          const still = turnTimers.get(key);
          if (!still || still.token !== token) return;

          // Last check before taking someone's money: has the turn moved on?
          const check = await Game.findOne({ roomCode: key, status: 'active' })
            .select('currentTurn').lean();
          if (!check || !check.currentTurn || check.currentTurn.toString() !== uid) {
            clearTurnTimer(key, io);
            return;
          }

          // ✅ ATOMIC claim — identical guard to the forfeit handler. If a normal
          // win, a forfeit, or a disconnect timeout already ended this game, the
          // filter matches nothing and we no-op instead of settling twice.
          const finished = await Game.findOneAndUpdate(
            { roomCode: key, status: 'active' },
            { $set: { status: 'finished', finishedAt: new Date() } },
            { new: true }
          ).populate('players.user', 'username');
          if (!finished) { clearTurnTimer(key, io); return; }

          const loserIdx  = finished.players.findIndex(p => p.user._id.toString() === uid);
          const winnerIdx = loserIdx === 0 ? 1 : 0;
          if (loserIdx === -1) { clearTurnTimer(key, io); return; }

          const winnerId = finished.players[winnerIdx].user._id;
          const loserId  = finished.players[loserIdx].user._id;

          const pot         = finished.betAmount * 2;
          const platformFee = Math.floor(pot * (parseInt(process.env.PLATFORM_FEE_PERCENT || 5) / 100));
          const winAmount   = pot - platformFee;

          finished.winner      = winnerId;
          finished.loser       = loserId;
          finished.winAmount   = winAmount;
          finished.platformFee = platformFee;
          await finished.save();

          try {
            await settleGame(finished, winnerId, loserId, winAmount, platformFee);
          } catch (se) {
            console.error('CRITICAL: settlement failed (turn timeout)', finished._id, se);
            Game.findByIdAndUpdate(finished._id, { $set: { settlementFailed: true } }).catch(() => {});
          }

          io.to(key).emit('game-over', {
            reason:      'turn_timeout',
            winner:      { id: winnerId.toString(), username: finished.players[winnerIdx].user.username },
            loser:       { id: loserId.toString(),  username: finished.players[loserIdx].user.username },
            winAmount,
            platformFee,
            pot,
            message:     `${finished.players[loserIdx].user.username} ran out of time. You win!`,
          });

          await syncInviteCard(io, key);
          console.log(`Turn timeout: ${finished.players[loserIdx].user.username} stalled in ${key} — ${finished.players[winnerIdx].user.username} wins ₹${winAmount}`);
        } catch (e) {
          console.error('turn final timer error:', e);
        } finally {
          turnTimers.delete(key);
        }
      }, TURN_FINAL_MS);
    } catch (e) {
      console.error('turn grace timer error:', e);
    }
  }, TURN_GRACE_MS);

  turnTimers.set(key, { graceTimer, finalTimer: null, userId: uid, token, warned: false });
}


// ============================
// Per-room lock — serializes game-mutating handlers (roll-dice, move-token)
// so two events on the same room can never read-modify-save concurrently.
// This is what prevents the Mongoose "VersionError: No matching document...version N"
// crash and any double-move from a double-tap: the second event waits, then reads the
// already-updated game and harmlessly no-ops instead of racing the first save.
// ============================
const roomLocks = new Map(); // roomCode -> tail promise
const LOCK_TIMEOUT_MS = 15000; // a locked section may never hold a room longer than this

function withRoomLock(roomCode, fn) {
  const key = String(roomCode || '').toUpperCase();
  const prev = roomLocks.get(key) || Promise.resolve();

  // ✅ TIMEOUT-GUARDED LOCK (Phase 5 hardening). Previously, if fn() ever hung — a
  // stalled DB op on M0, an unresolved await — the lock chain for this room would
  // block FOREVER and every later roll/move on it would freeze. Now each locked
  // section races a LOCK_TIMEOUT_MS deadline: if fn() overruns, the guarded promise
  // settles anyway so the NEXT queued event can proceed (guaranteed release). fn()
  // may still finish later; callers have already returned and ignore its late result.
  const guarded = prev.then(() => {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        console.warn(`LOCK_TIMEOUT room=${key} — locked section exceeded ${LOCK_TIMEOUT_MS}ms; releasing to next event`);
        resolve(undefined);
      }, LOCK_TIMEOUT_MS);
    });
    return Promise.race([
      Promise.resolve().then(fn).finally(() => clearTimeout(timer)),
      deadline,
    ]);
  });

  const result = guarded;
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

// ============================================================================
// Helper: syncInviteCard — SINGLE SOURCE OF TRUTH for an invite card's state
//
// Every invite posted in global chat is a ChatMessage with type:'invite' and a
// roomCode. This helper reads the matching Game document and pushes the real
// outcome onto that card — who joined, whether it expired, who won — then
// broadcasts 'invite-updated' so every client in chat repaints the card LIVE.
//
// Why derive from the Game doc instead of passing values in at each call site:
// there are five separate places a game can end (normal win, forfeit, absence
// re-arm, disconnect forfeit, abort). Hand-passing a winner at each one is five
// chances to pass the wrong player. Reading the Game — which is already the
// authoritative record used for settlement — means the card can never disagree
// with who actually got paid.
//
// MONEY SAFETY: read-only with respect to games and balances. This function
// only ever writes DISPLAY fields onto a chat message. It never touches Game,
// User.balance, User.lockedBalance, or Transaction. Every call is wrapped so a
// failure here can never interrupt settlement or game flow.
// ============================================================================
async function syncInviteCard(io, roomCode) {
  try {
    if (!roomCode) return;
    const code = String(roomCode).toUpperCase();

    // Skip entirely if there is no invite card for this room (games created
    // from the Lobby never post one) — avoids a pointless Game lookup.
    const card = await ChatMessage.findOne({ type: 'invite', roomCode: code })
      .select('_id status')
      .lean();
    if (!card) return;
    if (card.status === 'finished' || card.status === 'expired') return; // terminal

    const game = await Game.findOne({ roomCode: code })
      .populate('players.user', 'username')
      .select('roomCode status players winner winAmount betAmount')
      .lean();

    const patch = deriveInviteState(game);
    if (!patch) return;

    await ChatMessage.updateOne({ _id: card._id }, { $set: patch });

    io.to(CHAT_ROOM).emit('invite-updated', { roomCode: code, ...patch });
  } catch (e) {
    // Non-fatal by design — a chat card never blocks a real game.
    console.error('syncInviteCard error (non-fatal):', e.message);
  }
}

// Derive an invite card's display state from its Game document.
// Kept identical in shape to the copy in routes/chat.js so the live socket path
// and the history/backfill path can never disagree about what a card should say.
function deriveInviteState(game) {
  if (!game) {
    return { status: 'expired', resultReason: 'no_opponent' };
  }

  const players  = Array.isArray(game.players) ? game.players : [];
  const opponent = players[1]?.user;

  if (game.status === 'waiting') {
    return { status: 'waiting' };
  }

  if (game.status === 'aborted' || game.status === 'cancelled') {
    return {
      status: 'expired',
      resultReason: game.status === 'cancelled' ? 'cancelled' : 'no_opponent',
      acceptedBy: opponent?.username || '',
      acceptedById: opponent?._id || null,
    };
  }

  if (game.status === 'active') {
    return {
      status: 'accepted',
      acceptedBy: opponent?.username || '',
      acceptedById: opponent?._id || null,
    };
  }

  if (game.status === 'finished') {
    const winnerIdStr = game.winner ? String(game.winner) : '';
    const winnerP = players.find(p => String(p.user?._id) === winnerIdStr);
    const loserP  = players.find(p => String(p.user?._id) !== winnerIdStr);

    if (!winnerIdStr) {
      return {
        status: 'expired',
        resultReason: 'connection_lost',
        acceptedBy: opponent?.username || '',
        acceptedById: opponent?._id || null,
      };
    }

    return {
      status: 'finished',
      acceptedBy: opponent?.username || '',
      acceptedById: opponent?._id || null,
      winnerName: winnerP?.user?.username || '',
      winnerId: game.winner || null,
      loserName: loserP?.user?.username || '',
      winAmount: game.winAmount || 0,
      resultReason: 'win',
    };
  }

  return null;
}

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
      const game = await Game.findOne({ roomCode, status: 'waiting' }).select('-moveHistory');
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

      // ⏱️ Room is dead — stop any inactivity clock.
      clearTurnTimer(roomCode, io);

      // ✅ Flip this game's chat invite card to "expired" for everyone, permanently.
      // The game row is already status:'aborted' above, so syncInviteCard reads
      // that and writes + broadcasts the expired state.
      await syncInviteCard(io, roomCode);
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
// Helper: real (live-socket) presence + active-game absence re-arm
// ----------------------------
// After a SERVER RESTART the in-memory 60s disconnect timers are gone, and the DB
// `isConnected` flags can be stale (no 'disconnect' fired for a player who was online
// at the moment of restart). So to decide whether a player is really HERE we check
// for a LIVE socket in the room — not the DB flag.
// NOTE: single-instance assumption (one Railway process). Across multiple nodes this
// would need the Socket.IO adapter's async fetchSockets() instead.
// ============================
function isUserLiveInRoom(io, roomCode, userId) {
  const room = io.sockets.adapter.rooms.get(roomCode);
  if (!room) return false;
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.user && s.user._id && s.user._id.toString() === userId.toString()) return true;
  }
  return false;
}

// Re-arm the 60s forfeit/refund window for an ACTIVE game based on who is ACTUALLY
// connected right now. Called whenever a player (re)joins an active room. This is what
// makes disconnect resolution survive a server restart: if a restart wiped the original
// timer and one player never returns, the player who DID return triggers a fresh 60s
// window. Resolution mirrors the disconnect handler exactly:
//   • absent player stays gone at fire time → present player WINS (absent forfeits)
//   • BOTH gone at fire time                → abort + refund BOTH (unlock only)
// Every settle uses an ATOMIC status flip, so this can never double-settle even if it
// races the disconnect handler's own timer (whoever flips 'active' first wins).
async function reEvaluateActivePresence(io, roomCode) {
  try {
    const game = await Game.findOne({ roomCode, status: 'active' })
      .select('-moveHistory')
      .populate('players.user', 'username');
    if (!game || game.players.length < 2) return;

    const p0 = game.players[0].user._id.toString();
    const p1 = game.players[1].user._id.toString();
    const p0Live = isUserLiveInRoom(io, roomCode, p0);
    const p1Live = isUserLiveInRoom(io, roomCode, p1);

    // Clear any previously-armed absence timer; we re-arm fresh from current presence.
    const existing = activeRooms.get(roomCode);
    if (existing && existing.absenceTimer) { clearTimeout(existing.absenceTimer); existing.absenceTimer = null; }

    if (p0Live && p1Live) return;   // both here → game continues normally
    if (!p0Live && !p1Live) return; // nobody here yet (e.g. right after a restart) → wait for a (re)join

    const presentId = p0Live ? p0 : p1;
    const absentId  = p0Live ? p1 : p0;

    const timer = setTimeout(async () => {
      try {
        const presentLive = isUserLiveInRoom(io, roomCode, presentId);
        const absentLive  = isUserLiveInRoom(io, roomCode, absentId);
        if (absentLive) return; // they came back within 60s — nothing to do

        if (!presentLive) {
          // Both now absent → abort + refund BOTH (unlock lockedBalance only).
          const aborted = await Game.findOneAndUpdate(
            { roomCode, status: 'active' },
            { $set: { status: 'aborted', finishedAt: new Date() } },
            { new: true }
          );
          if (!aborted) return;
          for (const p of aborted.players) {
            const u = await User.findById(p.user);
            if (u) {
              const before = u.balance;
              u.lockedBalance = Math.max(0, u.lockedBalance - aborted.betAmount);
              await u.save();
              await Transaction.create({
                user: u._id, type: 'refund', amount: aborted.betAmount,
                balanceBefore: before, balanceAfter: u.balance,
                status: 'completed', gameId: aborted._id,
              });
            }
          }
          io.to(roomCode).emit('game-aborted', {
            reason: 'connection_lost',
            message: 'Both players lost connection. Game aborted — bets refunded.',
          });
          // ⏱️ Game over — stop the inactivity clock.
          clearTurnTimer(roomCode, io);
          // ✅ Expire the chat invite card — the room no longer exists.
          await syncInviteCard(io, roomCode);

          console.log(`Absence re-arm: room ${roomCode} both gone — aborted + refunded`);
          return;
        }

        // Present player WINS, absent player forfeits. Atomic flip prevents double-settle.
        const finished = await Game.findOneAndUpdate(
          { roomCode, status: 'active' },
          { $set: { status: 'finished', finishedAt: new Date() } },
          { new: true }
        ).populate('players.user', 'username');
        if (!finished) return;

        const winIdx  = finished.players.findIndex(p => p.user._id.toString() === presentId);
        const loseIdx = winIdx === 0 ? 1 : 0;
        const winnerId = finished.players[winIdx].user._id;
        const loserId  = finished.players[loseIdx].user._id;

        const pot         = finished.betAmount * 2;
        const platformFee = Math.floor(pot * (parseInt(process.env.PLATFORM_FEE_PERCENT || 5) / 100));
        const winAmount   = pot - platformFee;
        finished.winner      = winnerId;
        finished.loser       = loserId;
        finished.winAmount   = winAmount;
        finished.platformFee = platformFee;
        await finished.save();

        try {
          await settleGame(finished, winnerId, loserId, winAmount, platformFee);
        } catch (se) {
          console.error('CRITICAL: settlement failed (re-arm)', finished._id, se);
          Game.findByIdAndUpdate(finished._id, { $set: { settlementFailed: true } }).catch(() => {});
        }

        io.to(roomCode).emit('game-over', {
          reason: 'opponent_disconnected',
          winner: { id: winnerId.toString(), username: finished.players[winIdx].user.username },
          loser:  { id: loserId.toString(),  username: finished.players[loseIdx].user.username },
          winAmount,
          message: 'Opponent did not return. You win!',
        });

        // ⏱️ Game over — stop the inactivity clock.
        clearTurnTimer(roomCode, io);
        // ✅ Stamp the winner permanently onto this game's chat invite card.
        await syncInviteCard(io, roomCode);
        console.log(`Absence re-arm: room ${roomCode} ${finished.players[loseIdx].user.username} did not return — ${finished.players[winIdx].user.username} wins`);
      } catch (e) {
        console.error('absence timer error:', e);
      } finally {
        const a = activeRooms.get(roomCode);
        if (a) a.absenceTimer = null;
      }
    }, 60000);

    if (!activeRooms.has(roomCode)) activeRooms.set(roomCode, {});
    activeRooms.get(roomCode).absenceTimer = timer;
  } catch (e) {
    console.error('reEvaluateActivePresence error:', e);
  }
}

// ============================
// Helper: Settle game finances
// ============================
async function settleGame(game, winnerId, loserId, winAmount, platformFee) {
  const winner = await User.findById(winnerId);
  const loser  = await User.findById(loserId);

    winner.lockedBalance = Math.max(0, winner.lockedBalance - game.betAmount);
    loser.lockedBalance  = Math.max(0, loser.lockedBalance  - game.betAmount);
    loser.balance        = Math.max(0, loser.balance - game.betAmount);
    // ✅ Bonus is non-withdrawable and lives INSIDE `balance`. When the loser's balance
    // falls, shrink their bonus marker so it can never exceed real balance — otherwise a
    // later genuine deposit would be wrongly treated as non-withdrawable. Bonus eaten by a
    // loss is simply gone. Winner's winnings stay fully withdrawable (by design).
    loser.bonusBalance   = Math.min(loser.bonusBalance || 0, loser.balance);

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

        // ✅ Store the roomCode UPPERCASED. Room codes are generated uppercase
        // in routes/game.js, and every invite lookup filters on the uppercased
        // value — storing the raw string risked a card that could never be
        // matched (and so could never be flipped to expired/finished) if a
        // lowercase code ever reached this handler.
        const code = String(roomCode).toUpperCase();

        const msg = await ChatMessage.create({
          userId:    socket.user._id,
          username:  socket.user.username,
          type:      'invite',
          betAmount: amount,
          roomCode:  code,
          text:      '',
          status:    'waiting',
        });
        io.to(CHAT_ROOM).emit('chat-message', {
          _id:       msg._id.toString(),
          userId:    socket.user._id.toString(),
          username:  socket.user.username,
          type:      'invite',
          betAmount: amount,
          roomCode:  code,
          status:    'waiting',
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
          .select('-moveHistory')   // ⚡ never read; also shrinks the game-state payload
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
        game.players[playerIdx].isConnected = true; // in-memory copy for the logic below
        // ✅ ATOMIC isConnected write — a positional $set never bumps the document __v,
        // so it can't VersionError an in-flight roll/move the way a full game.save() can.
        await Game.updateOne(
          { _id: game._id, 'players.user': socket.user._id },
          { $set: { 'players.$.isConnected': true } }
        );

        // ✅ Player came back (e.g. from a refresh) — cancel any pending
        // waiting-room grace abort so their room isn't killed.
        const gt = waitingGraceTimers.get(roomCode);
        if (gt) { clearTimeout(gt); waitingGraceTimers.delete(roomCode); }

        // ✅ Also cancel any pending 60s disconnect→forfeit timer FOR THIS USER ONLY.
        // The frontend reconnects via 'join-room' (not 'reconnect-room'), so this is
        // the path that must disarm it. Timers are stored per-user so rejoining can
        // never disarm a forfeit window armed against the OPPONENT.
        const ar = activeRooms.get(roomCode);
        const myId = socket.user._id.toString();
        if (ar?.disconnectTimers?.[myId]) {
          clearTimeout(ar.disconnectTimers[myId]);
          delete ar.disconnectTimers[myId];
        }
        // Legacy single-slot timer (pre-fix rooms still in memory): only clear if it
        // was armed for this same user.
        if (ar?.disconnectTimer && ar.disconnectTimerUser === myId) {
          clearTimeout(ar.disconnectTimer); ar.disconnectTimer = null;
        }

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

          // ✅ Persist accepted status + WHO joined, so the card still shows it
          // after a refresh. syncInviteCard reads the Game row (now 'active'
          // with both players) and broadcasts 'invite-updated' to all of chat.
          await syncInviteCard(io, roomCode);
        }

        // ⏱️ Arm the inactivity clock for whoever holds the turn.
        // onlyIfAbsent: a refresh re-fires join-room, and resetting here would let
        // a stalling player refresh forever to dodge the timeout.
        if (game.status === 'active' && game.currentTurn) {
          armTurnTimer(io, roomCode, game.currentTurn, { onlyIfAbsent: true });
        }

        // ✅ Re-arm the 60s disconnect/forfeit window from REAL presence. Survives a
        // server restart: if the timer was wiped and the opponent never returns, the
        // player who rejoined here triggers a fresh window instead of hanging forever.
        if (game.status === 'active') reEvaluateActivePresence(io, roomCode);

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
        // ⚡ PERF: moveHistory is EXCLUDED from this read.
        //
        // It grows for the whole match and is never read by anything — not this
        // handler, not the client, not any other server path. Loading it made the
        // game document heavier on every single roll:
        //     0 moves ->  1.8 KB     100 moves -> 13.5 KB     300 moves -> 36.9 KB
        // Across a 300-move match that was ~11 MB pulled from the database for ONE
        // game. Excluding it cuts that by roughly 90% and is why games used to feel
        // fine early and drag badly later.
        //
        // Verified safe: Mongoose only writes MODIFIED paths, so save() on a
        // document loaded without moveHistory leaves the stored array untouched.
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .select('-moveHistory')
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

          // ============================================================
          // ⚖️ FAIRNESS FIX — reset the six-streak when the turn passes.
          //
          // `consecutiveSixes` is a GAME-level counter, but it should only
          // ever describe the player whose turn it currently is. Every other
          // turn-change resets it (see the move-token branch below) — this
          // path did not. So the counter could still be at 2 when the turn
          // handed over, and the OPPONENT's next six was rerolled away for
          // something their opponent did.
          //
          // Effect measured over 50,000 simulated games: roughly one six
          // confiscated from the wrong player every 10 games. Small, but it
          // lands on the one mechanic players watch — a six is the only way
          // out of home — which is exactly the "mera token khulta hi nahi"
          // complaint.
          //
          // The three-six rule itself is unchanged and still applies equally
          // to both players. This only stops it leaking across a handover.
          // ============================================================
          game.consecutiveSixes = 0;

          await game.save();

          // ⏱️ They acted (rolled), and the turn passed — clock moves to the opponent.
          armTurnTimer(io, roomCode, opponentState.user._id);

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
          //
          // ✅ RACE FIX (2.1): the opponent can roll within this 1.5s window. If they
          //    have, a fresh 'dice-rolled' is already on their screen — emitting the
          //    stale 'turn-passed' now would clear THEIR dice and strand them. So at
          //    fire time we re-read the game and only clear if the opponent still
          //    hasn't rolled (lastDiceRoll still null AND it's still their turn).
          const passRoom = roomCode;
          const expectedNextTurn = opponentState.user._id.toString();
          const passPayload = {
            reason: 'No valid moves',
            nextTurn: expectedNextTurn,
            nextTurnUsername: opponentState.user.username,
          };
          setTimeout(async () => {
            try {
              const fresh = await Game.findOne({ roomCode: passRoom, status: 'active' })
                .select('lastDiceRoll currentTurn').lean();
              if (fresh &&
                  (fresh.lastDiceRoll === null || fresh.lastDiceRoll === undefined) &&
                  fresh.currentTurn && fresh.currentTurn.toString() === expectedNextTurn) {
                io.to(passRoom).emit('turn-passed', passPayload);
              }
              // else: opponent already rolled / turn moved on / game ended — do NOT
              // clobber their dice.
            } catch (e) {
              console.error('delayed turn-pass check error:', e.message);
            }
          }, 1500);
          return;
        }

        await game.save();

        // ⏱️ Rolling is an action, so the clock resets — but the turn is NOT over:
        // they still have to move a token. Re-arming for the SAME player is what
        // catches "rolled the dice then walked away", which a per-turn timer misses.
        armTurnTimer(io, roomCode, socket.user._id);

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
        // ⚡ PERF: moveHistory excluded — see the note in roll-dice. The new entry
        // is appended below with a separate atomic $push, so we never need to load
        // the existing array to add to it.
        const game = await Game.findOne({ roomCode: roomCode.toUpperCase() })
          .select('-moveHistory')
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

        // ⚡ Append history with an atomic, CAPPED $push instead of mutating a
        // loaded array. $slice: -MOVE_HISTORY_LIMIT keeps only the most recent
        // entries, so the document can never grow without bound again.
        //
        // Fire-and-forget: history is diagnostic only (nothing reads it), so a
        // failed append must never block or fail a real move.
        Game.updateOne(
          { _id: game._id },
          { $push: { moveHistory: {
              $each: [{
                player: socket.user._id,
                dice: diceRoll,
                tokenIndex,
                fromPosition: move.currentProgress,
                toPosition:   move.newProgress,
              }],
              $slice: -MOVE_HISTORY_LIMIT,
          } } }
        ).catch(e => console.error('moveHistory append failed (non-fatal):', e.message));

        // ✅ FIX: Null lastDiceRoll AFTER all logic that depends on it is done
        game.lastDiceRoll = null;

        const moveData = {
          playerId: socket.user._id.toString(),
          playerUsername: socket.user.username,
          tokenIndex,
          fromProgress:  move.currentProgress,
          toProgress:    move.newProgress,
          captured:      result.captured,
          passiveCaptured: result.passiveCaptured,
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
          let settlementOk = true;
          try {
            await settleGame(game, socket.user._id, opponentState.user._id, winAmount, platformFee);
          } catch (se) {
            settlementOk = false;
            console.error('CRITICAL: settlement failed (move-token win)', game._id, se);
            Game.findByIdAndUpdate(game._id, { $set: { settlementFailed: true } }).catch(() => {});
          }

          io.to(roomCode).emit('game-over', {
            ...moveData,
            winner: { id: socket.user._id.toString(), username: socket.user.username },
            loser:  { id: opponentState.user._id.toString(), username: opponentState.user.username },
            winAmount,
            platformFee,
            pot,
          });

          // ⏱️ Game is over — stop the inactivity clock.
          clearTurnTimer(roomCode, io);

          // ✅ Stamp the winner permanently onto this game's chat invite card.
          await syncInviteCard(io, roomCode);
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

        // ⏱️ A token moved — reset the clock for whoever holds the turn now. On an
        // extra turn that is the same player again; otherwise it's the opponent.
        armTurnTimer(io, roomCode, game.currentTurn);

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
          { new: true, projection: { moveHistory: 0 } }
        ).populate('players.user', 'username');

        if (!game) {
          // Game already finished — player likely missed game-over event (brief disconnect).
          // Re-emit the result so they see the correct screen instead of being stuck.
          try {
            const ended = await Game.findOne({ roomCode: roomCode.toUpperCase() })
              .select('-moveHistory')
              .populate('players.user', 'username');
            if (ended && ended.winner) {
              const winnerP = ended.players.find(p => p.user._id.toString() === ended.winner.toString());
              const loserP  = ended.players.find(p => p.user._id.toString() !== ended.winner.toString());
              socket.emit('game-over', {
                reason:      'recovered',
                winner:      { id: ended.winner.toString(),       username: winnerP?.user?.username },
                loser:       { id: ended.loser?.toString() || '', username: loserP?.user?.username },
                winAmount:   ended.winAmount,
                platformFee: ended.platformFee,
              });
              return;
            }
          } catch (_) {}
          socket.emit('error', { message: 'Game already ended.' });
          return;
        }

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
        try {
          await settleGame(game, winnerId, loserId, winAmount, platformFee);
        } catch (se) {
          console.error('CRITICAL: settlement failed (forfeit)', game._id, se);
          Game.findByIdAndUpdate(game._id, { $set: { settlementFailed: true } }).catch(() => {});
        }

        io.to(roomCode).emit('game-over', {
          reason:      'forfeit',
          winner:      { id: winnerId.toString(), username: game.players[winnerIdx].user.username },
          loser:       { id: loserId.toString(),  username: game.players[loserIdx].user.username },
          winAmount,
          platformFee,
          pot,
        });

        // ⏱️ Game over — stop the inactivity clock.
        clearTurnTimer(roomCode, io);

        // ✅ Stamp the winner permanently onto this game's chat invite card.
        await syncInviteCard(io, roomCode);

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
          .select('-moveHistory')
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

        // ✅ STALE-DISCONNECT GUARD (the "player loses while still playing" bug).
        // On flaky mobile networks the client reconnects with a NEW socket in ~1-2s,
        // but the OLD socket's 'disconnect' event fires on the server up to ~45s
        // LATER (default pingInterval 25s + pingTimeout 20s). Without this guard the
        // late disconnect flips isConnected=false and arms a fresh 60s forfeit timer
        // for a player who is actively playing on the new socket — and since they
        // never re-emit join-room, nothing flips it back, so 60s later they FORFEIT
        // and LOSE MONEY mid-game.
        // At 'disconnect' time this socket has already left all rooms, so
        // isUserLiveInRoom only sees OTHER live sockets of the same user: if one
        // exists, this disconnect is stale — ignore it completely.
        if (isUserLiveInRoom(io, socket.currentRoom, socket.user._id)) {
          console.log(`Stale disconnect ignored for ${socket.user.username} (newer socket live in ${socket.currentRoom})`);
          return;
        }

        // ✅ SCENARIO 1: Player disconnects while room is still WAITING.
        // Do NOT abort immediately — a page refresh looks identical to leaving.
        // Give a short grace window; if they don't reconnect (join-room clears this),
        // THEN abort + refund. The existing 2-min timer still backstops truly idle rooms.
        if (game.status === 'waiting') {
          game.players[playerIdx].isConnected = false; // in-memory copy for the logic below
          // ✅ ATOMIC isConnected write — positional $set, no __v bump, no move-race.
          await Game.updateOne(
            { _id: game._id, 'players.user': socket.user._id },
            { $set: { 'players.$.isConnected': false } }
          );

          const roomForGrace = socket.currentRoom;
          const graceTimer = setTimeout(async () => {
            waitingGraceTimers.delete(roomForGrace);
            try {
              const fresh = await Game.findOne({ roomCode: roomForGrace, status: 'waiting' }).select('-moveHistory');
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

              // ⏱️ Room is dead — stop any inactivity clock.
              clearTurnTimer(roomForGrace, io);
              // ✅ Expire this game's chat invite card too, permanently.
              await syncInviteCard(io, roomForGrace);
            } catch (e) {
              console.error('waiting grace abort error:', e);
            }
          }, 20000); // 20s grace — long enough to cover a refresh, short enough to free the room

          waitingGraceTimers.set(roomForGrace, graceTimer);
          return; // don't run the active-game 60s logic below
        }

        // ✅ SCENARIO 2: Player disconnects during active game → 60s reconnect window
        game.players[playerIdx].isConnected = false; // in-memory copy for the logic below
        // ✅ ATOMIC isConnected write — positional $set, no __v bump, no move-race.
        await Game.updateOne(
          { _id: game._id, 'players.user': socket.user._id },
          { $set: { 'players.$.isConnected': false } }
        );

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
          const freshGame = await Game.findOne({ roomCode: socket.currentRoom, status: 'active' })
            .select('-moveHistory');
          if (!freshGame) return;

          // ✅ FINAL SAFETY NET at fire time: the DB flag can be stale, but a LIVE
          // socket in the room cannot lie. If the player actually has a live socket
          // here (reconnected via any path), NEVER forfeit them — real presence
          // always beats the isConnected flag.
          if (isUserLiveInRoom(io, socket.currentRoom, socket.user._id)) return;

          const disconnectedIdx = freshGame.players.findIndex(
            p => p.user._id.toString() === socket.user._id.toString()
          );
          if (disconnectedIdx === -1 || freshGame.players[disconnectedIdx].isConnected) return;

          const opponentIdx = disconnectedIdx === 0 ? 1 : 0;

          // ✅ MONEY-SAFETY GUARD: only forfeit the disconnected player if their
          // opponent is ACTUALLY still connected. If BOTH are disconnected, this is
          // almost certainly a server/network-wide drop — NOT someone quitting — so
          // declaring a winner would take an innocent player's money. Instead abort
          // and refund BOTH (unlock lockedBalance only; balance is never touched).
          // The status flip is atomic, so the opponent's own 60s timer can't
          // double-process it (whichever flips 'active' first wins; the other no-ops).
          if (!freshGame.players[opponentIdx].isConnected) {
            try {
              const aborted = await Game.findOneAndUpdate(
                { roomCode: socket.currentRoom, status: 'active' },
                { $set: { status: 'aborted', finishedAt: new Date() } },
                { new: true }
              );
              if (!aborted) return; // already handled by the other player's timer

              for (const p of aborted.players) {
                const u = await User.findById(p.user);
                if (u) {
                  const before = u.balance;
                  u.lockedBalance = Math.max(0, u.lockedBalance - aborted.betAmount);
                  await u.save();
                  await Transaction.create({
                    user: u._id,
                    type: 'refund',
                    amount: aborted.betAmount,
                    balanceBefore: before,
                    balanceAfter: u.balance,
                    status: 'completed',
                    gameId: aborted._id,
                  });
                }
              }

              io.to(socket.currentRoom).emit('game-aborted', {
                reason: 'connection_lost',
                message: 'Both players lost connection. Game aborted — bets refunded.',
              });
              // ⏱️ Game over — stop the inactivity clock.
              clearTurnTimer(socket.currentRoom, io);
              // ✅ Expire the chat invite card — the room no longer exists.
              await syncInviteCard(io, socket.currentRoom);

              console.log(`Both-disconnected: room ${socket.currentRoom} aborted, both players refunded`);
            } catch (e) {
              console.error('both-disconnected refund error:', e);
            }
            return;
          }

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

          try {
            await settleGame(freshGame, winnerId, loserId, winAmount, platformFee);
          } catch (se) {
            console.error('CRITICAL: settlement failed (disconnect)', freshGame._id, se);
            Game.findByIdAndUpdate(freshGame._id, { $set: { settlementFailed: true } }).catch(() => {});
          }

          io.to(socket.currentRoom).emit('game-over', {
            reason:  'opponent_disconnected',
            winner:  { id: winnerId.toString() },
            loser:   { id: loserId.toString(), username: socket.user.username },
            winAmount,
            message: `${socket.user.username} disconnected. You win!`,
          });

          // ⏱️ Game over — stop the inactivity clock.
          clearTurnTimer(socket.currentRoom, io);
          // ✅ Stamp the winner permanently onto this game's chat invite card.
          await syncInviteCard(io, socket.currentRoom);
        }, 60000);

        // ✅ Store the forfeit timer PER USER (not per room) so one player's rejoin
        // can never disarm the window armed against the other. Any older timer for
        // this same user is replaced (cleared) first.
        if (!activeRooms.has(socket.currentRoom)) activeRooms.set(socket.currentRoom, {});
        const roomEntry = activeRooms.get(socket.currentRoom);
        roomEntry.disconnectTimers = roomEntry.disconnectTimers || {};
        const uidKey = socket.user._id.toString();
        if (roomEntry.disconnectTimers[uidKey]) clearTimeout(roomEntry.disconnectTimers[uidKey]);
        roomEntry.disconnectTimers[uidKey] = timer;

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
        // ✅ Clear only THIS user's forfeit timer — never the opponent's.
        const rcUid = socket.user._id.toString();
        if (room?.disconnectTimers?.[rcUid]) {
          clearTimeout(room.disconnectTimers[rcUid]);
          delete room.disconnectTimers[rcUid];
        }
        if (room?.disconnectTimer && room.disconnectTimerUser === rcUid) {
          clearTimeout(room.disconnectTimer);
          room.disconnectTimer = null;
        }

        const game = await Game.findOne({ roomCode })
          .select('-moveHistory')
          .populate('players.user', 'username');
        if (!game) return;

        const playerIdx = game.players.findIndex(
          p => p.user._id.toString() === socket.user._id.toString()
        );
        if (playerIdx !== -1) {
          game.players[playerIdx].isConnected = true; // in-memory copy for the logic below
          // ✅ ATOMIC isConnected write — positional $set, no __v bump, no move-race.
          await Game.updateOne(
            { _id: game._id, 'players.user': socket.user._id },
            { $set: { 'players.$.isConnected': true } }
          );
          socket.join(roomCode);
          socket.currentRoom = roomCode;
          socket.emit('game-state', sanitizeGame(game, socket.user._id));
          socket.to(roomCode).emit('player-reconnected', { username: socket.user.username });

          // ⏱️ Arm the inactivity clock if none is running (e.g. after a restart).
          // onlyIfAbsent so reconnecting can't be used to reset a running clock.
          if (game.status === 'active' && game.currentTurn) {
            armTurnTimer(io, roomCode, game.currentTurn, { onlyIfAbsent: true });
          }

          // ✅ Re-arm the 60s disconnect/forfeit window from REAL presence (survives restarts).
          if (game.status === 'active') reEvaluateActivePresence(io, roomCode);
        }
      } catch (err) {
        console.error('reconnect-room error:', err);
      }
    });

  }); // end io.on('connection')

  // ============================================================================
  // ✅ ORPHANED ACTIVE-GAME SWEEP (restart recovery) — fixes the "stuck active game
  // with locked balances after a redeploy" gap.
  //
  // A server restart wipes the in-memory disconnect (60s) and absence timers, so an
  // active game whose players never reconnect would sit 'active' forever with both
  // stakes locked. This periodic sweep ends + refunds those — and ONLY those.
  //
  // THREE guards make it impossible to abort a game that's actually being played:
  //   1) PRESENCE — neither player is live in the room's socket (both truly gone).
  //   2) STALENESS — the game hasn't been touched in > STALE_MS (no moves / no
  //      reconnect writes). A reconnect ($set isConnected) or any move refreshes
  //      updatedAt, so a resuming game is never stale.
  //   3) GRACE — the first run is delayed by the interval, giving clients time to
  //      reconnect after a redeploy before we judge anything orphaned.
  //
  // MONEY SAFETY: status is flipped active→aborted ATOMICALLY (so a racing
  // settlement can't double-process), and the refund is UNLOCK-ONLY
  // (lockedBalance -= bet; balance is never touched), with a 'refund' Transaction.
  // ============================================================================
  const ORPHAN_SWEEP_INTERVAL_MS = 120000; // run every 2 min (first run ~2 min after boot)
  const ORPHAN_STALE_MS          = 90000;  // only touch games idle for > 90s
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - ORPHAN_STALE_MS);
      // ⚡ Only the fields the sweep actually uses. This previously loaded EVERY
      // stale active game in full — including each one's entire moveHistory —
      // every 2 minutes.
      const stale = await Game.find({ status: 'active', updatedAt: { $lt: cutoff } })
        .select('roomCode players betAmount status')
        .lean();
      for (const g of stale) {
        const p0 = g.players[0]?.user?.toString();
        const p1 = g.players[1]?.user?.toString();
        const anyLive =
          (p0 && isUserLiveInRoom(io, g.roomCode, p0)) ||
          (p1 && isUserLiveInRoom(io, g.roomCode, p1));
        if (anyLive) continue; // someone is present — normal flow owns this game

        // Atomically claim it (active → aborted). If a settlement beat us, skip.
        const aborted = await Game.findOneAndUpdate(
          { _id: g._id, status: 'active' },
          { $set: { status: 'aborted', finishedAt: new Date() } },
          { new: true }
        );
        if (!aborted) continue;

        for (const p of aborted.players) {
          const u = await User.findById(p.user);
          if (!u) continue;
          const before = u.balance; // balance untouched — unlock only
          u.lockedBalance = Math.max(0, u.lockedBalance - aborted.betAmount);
          await u.save();
          await Transaction.create({
            user: u._id,
            type: 'refund',
            amount: aborted.betAmount,
            balanceBefore: before,
            balanceAfter: u.balance,
            status: 'completed',
            gameId: aborted._id,
          });
        }

        // ⏱️ Game is dead — stop the inactivity clock.
        clearTurnTimer(aborted.roomCode, io);

        io.to(aborted.roomCode).emit('game-aborted', {
          reason: 'server_restart',
          message: 'Game ended after a server restart — both bets refunded.',
        });
        console.log(`🧹 Orphan active sweep: aborted ${aborted.roomCode}, refunded both (₹${aborted.betAmount} each).`);
      }
    } catch (e) {
      console.error('orphan active sweep error (non-fatal):', e.message);
    }
  }, ORPHAN_SWEEP_INTERVAL_MS);

}; // end module.exports
