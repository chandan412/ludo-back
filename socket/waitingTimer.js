// waitingTimer.js — shared server-side timer module
// Timer starts at game creation (HTTP), not socket connection
// Page refreshes have zero effect on the timer

const Game        = require('../models/Game');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');

const roomTimers = new Map(); // roomCode → { abortTimer, tickInterval }

let _io = null;
function setIO(io) { _io = io; }

const WAIT_MS = 2 * 60 * 1000; // 2 minutes

function startWaitingTimer(roomCode, remainingSeconds = 120) {
  // ✅ Guard — never start two timers for the same room
  if (roomTimers.has(roomCode)) return;
  if (remainingSeconds <= 0) {
    abortGame(roomCode);
    return;
  }

  let secs = Math.max(0, Math.floor(remainingSeconds));

  // Tick every second — broadcast to room
  const tickInterval = setInterval(() => {
    secs -= 1;
    if (_io) _io.to(roomCode).emit('waiting-countdown', { secondsLeft: secs });
    if (secs <= 0) clearInterval(tickInterval);
  }, 1000);

  // Abort after remaining time
  const abortTimer = setTimeout(() => {
    clearInterval(tickInterval);
    abortGame(roomCode);
  }, secs * 1000);

  roomTimers.set(roomCode, { abortTimer, tickInterval });
  console.log(`⏱ Timer started for ${roomCode} — ${secs}s remaining`);
}

async function abortGame(roomCode) {
  roomTimers.delete(roomCode);
  try {
    const game = await Game.findOne({ roomCode, status: 'waiting' });
    if (!game) return; // already started or aborted elsewhere

    game.status = 'aborted';
    game.finishedAt = new Date();
    await game.save();

    // ✅ Only unlock lockedBalance — never add to balance
    const creator = await User.findById(game.players[0].user);
    if (creator) {
      const availableBefore = creator.balance - creator.lockedBalance;
      creator.lockedBalance = Math.max(0, creator.lockedBalance - game.betAmount);
      await creator.save();
      await Transaction.create({
        user: creator._id,
        type: 'refund',
        amount: game.betAmount,
        balanceBefore: availableBefore,
        balanceAfter: creator.balance - creator.lockedBalance,
        status: 'completed',
        gameId: game._id,
      });
    }

    console.log(`✅ Game ${roomCode} auto-aborted — no opponent joined`);
    if (_io) {
      _io.to(roomCode).emit('game-aborted', {
        reason: 'no_opponent',
        message: 'No opponent joined in 2 minutes. Game aborted. Bet unlocked.',
      });
    }
  } catch (err) {
    console.error('Auto-abort error:', err);
  }
}

function cancelWaitingTimer(roomCode) {
  const timers = roomTimers.get(roomCode);
  if (timers) {
    clearTimeout(timers.abortTimer);
    clearInterval(timers.tickInterval);
    roomTimers.delete(roomCode);
    console.log(`⏹ Timer cancelled for ${roomCode} — opponent joined`);
  }
}

function hasTimer(roomCode) {
  return roomTimers.has(roomCode);
}

// ✅ On server restart — resume timers for any waiting games still in DB
async function resumeTimersOnStartup() {
  try {
    const waitingGames = await Game.find({ status: 'waiting' });
    let resumed = 0, expired = 0;
    for (const game of waitingGames) {
      const elapsed  = Math.floor((Date.now() - new Date(game.createdAt).getTime()) / 1000);
      const remaining = Math.max(0, 120 - elapsed);
      if (remaining <= 0) {
        await abortGame(game.roomCode);
        expired++;
      } else {
        startWaitingTimer(game.roomCode, remaining);
        resumed++;
      }
    }
    if (resumed || expired) {
      console.log(`🔄 Startup: resumed ${resumed} timers, aborted ${expired} expired games`);
    }
  } catch (err) {
    console.error('Timer resume error:', err);
  }
}

module.exports = { setIO, startWaitingTimer, cancelWaitingTimer, hasTimer, resumeTimersOnStartup };
