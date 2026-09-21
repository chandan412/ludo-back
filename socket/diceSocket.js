const crypto = require('crypto');

const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const DiceRound   = require('../models/DiceRound');
const DiceBet     = require('../models/DiceBet');
const { getConfig } = require('../utils/diceConfig');
const { adjustCoins } = require('../utils/diceCoins');

// ============================================================================
// INSTANT LUDO — round engine + real-time layer
//
// One server-authoritative round loop:
//
//   betting (config.bettingSeconds) → locked (draw committed)
//     → drawing animation (DRAW_MS) → settled → hold (RESULT_MS) → next round
//
// THE CLOCK RUNS HERE, NOT ON THE CLIENT. Clients are given `bettingEndsAt` and
// `serverTime` and derive their own countdown from the difference. If each
// client counted down locally, two phones with a two-second clock skew would
// show two different timers and one of them would try to bet after lock.
//
// ⚠️ SINGLE INSTANCE ONLY, for now. This scheduler assumes one Node process.
// Railway Hobby runs one, so this is correct today. If the backend is ever
// scaled to two instances, both will run a scheduler and both will try to open
// round N — the unique index on roundNumber stops the duplicate document, but
// you would still get two overlapping loops. That is the same Redis-adapter
// work already anticipated for Socket.IO; do them together.
// ============================================================================

const DICE_ROOM = 'dice-room';
const userRoom  = (id) => `dice-user-${String(id)}`;

const DRAW_MS   = 1600;  // dice animation on the client
const RESULT_MS = 4000;  // result held on screen before the next round opens
const LOCK_MS   = 800;   // brief pause between lock and the reveal

let ioRef   = null;
let timer   = null;
let running = false;

// ----------------------------------------------------------------------------
// The draw.
//
// crypto.randomInt(1, 7) → an integer in [1, 7), i.e. 1..6 inclusive, uniform
// and unpredictable. Same call LudoEngine.rollDice() already uses.
//
// NOT Math.random(): V8's generator is seeded, fast and reversible — given a
// run of outputs its internal state can be recovered and every future value
// predicted. This game publishes one output every fifteen seconds, to
// everybody, forever. That is a gift-wrapped sequence for an attacker.
//
// NOT randomBytes(1)[0] % 6 either: a byte is 0-255, and 256 is not divisible
// by 6, so 1-4 would land fractionally more often than 5-6. Invisible over a
// hundred rounds, measurable over a million, and exactly the kind of thing a
// player who logs results will eventually find.
// ----------------------------------------------------------------------------
function drawNumber() {
  return crypto.randomInt(1, 7);
}

function emitAll(event, payload) {
  if (ioRef) ioRef.to(DICE_ROOM).emit(event, payload);
}

// ============================================================================
// OPEN
// ============================================================================
async function openRound() {
  const cfg = await getConfig();
  if (!cfg.enabled) { running = false; return null; }

  // roundNumber is derived from the highest existing round, not from a counter
  // in memory, so a restart continues the sequence instead of colliding.
  const last = await DiceRound.findOne().sort({ roundNumber: -1 }).select('roundNumber').lean();
  const next = (last?.roundNumber || 0) + 1;

  const bettingEndsAt = new Date(Date.now() + cfg.bettingSeconds * 1000);

  let round;
  try {
    round = await DiceRound.create({
      roundNumber:   next,
      status:        'betting',
      bettingEndsAt,
      // Frozen for the life of this round — see the field comment in the model.
      multiplier:    cfg.multiplier,
    });
  } catch (err) {
    // Duplicate roundNumber: another path opened this round first. Back off a
    // beat and retry rather than crashing the loop.
    if (err && err.code === 11000) {
      timer = setTimeout(() => openRound().catch(console.error), 500);
      return null;
    }
    throw err;
  }

  emitAll('dice:round-start', {
    roundId:       String(round._id),
    roundNumber:   round.roundNumber,
    bettingEndsAt: round.bettingEndsAt.toISOString(),
    serverTime:    new Date().toISOString(),
    multiplier:    round.multiplier,
    minBet:        cfg.minBet,
    maxBet:        cfg.maxBet,
    maxNumbers:    cfg.maxNumbers,
  });

  const wait = Math.max(0, round.bettingEndsAt.getTime() - Date.now());
  timer = setTimeout(() => lockRound(round._id).catch(console.error), wait);
  return round;
}

// ============================================================================
// LOCK + DRAW
//
// The draw is generated and WRITTEN TO THE DATABASE in the same atomic update
// that flips the status to 'locked'. Only after that write succeeds is any
// client told the round is locked, and the number itself is withheld until the
// reveal.
// ============================================================================
async function lockRound(roundId) {
  const number = drawNumber();

  const round = await DiceRound.findOneAndUpdate(
    { _id: roundId, status: 'betting' },
    { $set: { status: 'locked', drawnNumber: number } },
    { new: true }
  );

  // Null means somebody already moved this round out of 'betting' — a manual
  // cancel, or a duplicate timer. Stop; do not draw twice.
  if (!round) return;

  emitAll('dice:locked', { roundNumber: round.roundNumber });

  timer = setTimeout(() => settleRound(round._id).catch(console.error), LOCK_MS + DRAW_MS);
}

// ============================================================================
// SETTLE
//
// Credit PROFIT, not payout.
//
// The stake was never taken out of `coins` — it was moved into `lockedCoins`.
// So a winner is owed (payout - stake), and releasing the lock returns the
// stake itself. Crediting the full payout here would pay every winner their
// stake twice.
// ============================================================================
async function settleRound(roundId) {
  // ✅ ATOMIC CLAIM. Exactly the guard every settlement path in gameSocket.js
  // uses. If two callers reach this line at once — a timer and a manual
  // trigger, or a restart racing a live loop — only one gets a document back.
  // The other gets null and stops. This is what makes a double payout
  // impossible; a read-then-write check is not, however many guards precede it.
  const round = await DiceRound.findOneAndUpdate(
    { _id: roundId, status: 'locked' },
    { $set: { status: 'settled', settledAt: new Date() } },
    { new: true }
  );

  if (!round) return;

  const drawn = round.drawnNumber;
  const mult  = round.multiplier;

  const bets = await DiceBet.find({ round: round._id, status: 'pending' });

  // Aggregate per user so each player's document takes ONE write, not one per
  // number they backed.
  const perUser = new Map();
  let totalStaked  = 0;
  let totalPaidOut = 0;

  for (const bet of bets) {
    const u = String(bet.user);
    if (!perUser.has(u)) perUser.set(u, { unlock: 0, delta: 0, bets: [] });
    const acc = perUser.get(u);

    acc.unlock += bet.amount;      // release the lock either way
    totalStaked += bet.amount;

    if (bet.number === drawn) {
      const payout = Math.round(bet.amount * mult);
      const profit = payout - bet.amount;
      acc.delta += profit;          // ✅ profit, not payout
      totalPaidOut += payout;
      acc.bets.push({ bet, won: true, payout, profit });
    } else {
      acc.delta -= bet.amount;
      acc.bets.push({ bet, won: false, payout: 0, profit: -bet.amount });
    }
  }

  for (const [userId, acc] of perUser.entries()) {
    try {
      // Release the lock and apply the net result in one write, clamped at
      // zero. See utils/diceCoins.js for why this is not a pipeline update.
      const updated = await adjustCoins(userId, { delta: acc.delta, unlock: acc.unlock });

      const after  = updated ? updated.coins : 0;
      const before = Math.max(0, after - acc.delta);

      for (const r of acc.bets) {
        await DiceBet.updateOne(
          { _id: r.bet._id, status: 'pending' },
          { $set: { status: r.won ? 'won' : 'lost', payout: r.payout, settledAt: new Date() } }
        );

        await Transaction.create({
          user:        userId,
          type:        r.won ? 'coin_win' : 'coin_loss',
          currency:    'COIN',
          amount:      Math.abs(r.profit),
          balanceBefore: before,
          balanceAfter:  after,
          status:      'completed',
          diceRoundId: round._id,
        });
      }

      // Personal result — only this player's own bets and payout.
      if (ioRef) {
        ioRef.to(userRoom(userId)).emit('dice:result', {
          roundNumber: round.roundNumber,
          drawnNumber: drawn,
          myBets: acc.bets.map(r => ({
            number: r.bet.number,
            amount: r.bet.amount,
            won:    r.won,
            payout: r.payout,
          })),
          myPayout: acc.bets.reduce((s, r) => s + r.payout, 0),
          coins:       after,
          lockedCoins: updated ? updated.lockedCoins : 0,
        });
      }
    } catch (err) {
      console.error('[dice] settle failed for user', userId, err.message);
    }
  }

  await DiceRound.updateOne(
    { _id: round._id },
    { $set: { totalStaked, totalPaidOut } }
  );

  // Public result for everyone watching, including players who sat this one out.
  emitAll('dice:drawn', {
    roundNumber: round.roundNumber,
    drawnNumber: drawn,
    totalStaked,
    totalPaidOut,
  });

  timer = setTimeout(() => openRound().catch(console.error), RESULT_MS);
}

// ============================================================================
// CANCEL — refund every pending bet.
//
// Releases the lock and leaves `coins` ALONE, because nothing was ever taken
// out of it. Touching coins here would hand every player their stake a second
// time. This is the whole payoff of locking instead of deducting.
// ============================================================================
async function cancelRound(roundId, reason = 'cancelled') {
  const round = await DiceRound.findOneAndUpdate(
    { _id: roundId, status: { $in: ['betting', 'locked'] } },
    { $set: { status: 'cancelled', cancelReason: reason, settledAt: new Date() } },
    { new: true }
  );
  if (!round) return null;

  const bets = await DiceBet.find({ round: round._id, status: 'pending' });

  const perUser = new Map();
  for (const bet of bets) {
    const u = String(bet.user);
    perUser.set(u, (perUser.get(u) || 0) + bet.amount);
  }

  for (const [userId, unlock] of perUser.entries()) {
    try {
      // delta 0 — `coins` is deliberately untouched. Only the lock is released.
      const updated = await adjustCoins(userId, { delta: 0, unlock });

      await Transaction.create({
        user:          userId,
        type:          'coin_refund',
        currency:      'COIN',
        amount:        unlock,
        // Unchanged on both sides, deliberately: a refund of a lock moves no
        // spendable coins. The row exists so the player can see what happened.
        balanceBefore: updated ? updated.coins : 0,
        balanceAfter:  updated ? updated.coins : 0,
        status:        'completed',
        diceRoundId:   round._id,
      });

      if (ioRef) {
        ioRef.to(userRoom(userId)).emit('dice:cancelled', {
          roundNumber: round.roundNumber,
          reason,
          refunded:    unlock,
          coins:       updated ? updated.coins : 0,
          lockedCoins: updated ? updated.lockedCoins : 0,
        });
      }
    } catch (err) {
      console.error('[dice] refund failed for user', userId, err.message);
    }
  }

  await DiceBet.updateMany(
    { round: round._id, status: 'pending' },
    { $set: { status: 'refunded', settledAt: new Date() } }
  );

  emitAll('dice:cancelled', { roundNumber: round.roundNumber, reason });
  return round;
}

// ============================================================================
// BOOT RECOVERY
//
// A deploy or a crash mid-round leaves a round stuck in 'betting' or 'locked'
// with players' coins locked and no timer alive to release them. Railway
// redeploys on every push, so this is not a rare edge case — it is most
// deploys. Sweep on start.
// ============================================================================
async function recoverStuckRounds() {
  const stuck = await DiceRound.find({ status: { $in: ['betting', 'locked'] } }).select('_id').lean();
  for (const r of stuck) {
    try {
      await cancelRound(r._id, 'server restarted');
    } catch (err) {
      console.error('[dice] recovery failed for round', r._id, err.message);
    }
  }
  if (stuck.length) console.log(`[dice] recovered ${stuck.length} stuck round(s)`);
}

// ============================================================================
// LOOP CONTROL
// ============================================================================
async function startLoop() {
  if (running) return;
  const cfg = await getConfig(true);
  if (!cfg.enabled) return;
  running = true;
  await openRound();
}

function stopLoop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

// Called by the admin route when the on/off switch is flipped, so the game
// starts or stops immediately instead of at the next round boundary.
async function applyEnabledChange() {
  const cfg = await getConfig(true);
  if (cfg.enabled && !running) {
    await startLoop();
  } else if (!cfg.enabled && running) {
    stopLoop();
    const open = await DiceRound.findOne({ status: { $in: ['betting', 'locked'] } }).select('_id').lean();
    if (open) await cancelRound(open._id, 'game disabled by admin');
  }
}

// ============================================================================
// SOCKET WIRING
//
// Attaches to the SAME io as gameSocket, which means gameSocket's io.use()
// auth middleware has already run and socket.user is populated.
// ⚠️ diceSocket(io) must therefore be called AFTER gameSocket(io) in server.js.
// ============================================================================
module.exports = function diceSocket(io) {
  ioRef = io;

  io.on('connection', (socket) => {
    socket.on('dice:join', async () => {
      try {
        socket.join(DICE_ROOM);
        if (socket.user?._id) socket.join(userRoom(socket.user._id));

        const cfg = await getConfig();
        const round = await DiceRound.findOne({ status: 'betting' }).sort({ createdAt: -1 }).lean();

        socket.emit('dice:state', {
          enabled:    cfg.enabled,
          serverTime: new Date().toISOString(),
          round: round ? {
            roundId:       String(round._id),
            roundNumber:   round.roundNumber,
            bettingEndsAt: round.bettingEndsAt,
            multiplier:    round.multiplier,
          } : null,
          minBet:     cfg.minBet,
          maxBet:     cfg.maxBet,
          maxNumbers: cfg.maxNumbers,
        });
      } catch (err) {
        console.error('[dice] join failed:', err.message);
      }
    });

    socket.on('dice:leave', () => {
      socket.leave(DICE_ROOM);
      if (socket.user?._id) socket.leave(userRoom(socket.user._id));
    });
  });

  // Boot: clean up anything a restart orphaned, then start if enabled.
  recoverStuckRounds()
    .then(startLoop)
    .catch(err => console.error('[dice] boot failed:', err.message));
};

module.exports.startLoop           = startLoop;
module.exports.stopLoop            = stopLoop;
module.exports.applyEnabledChange  = applyEnabledChange;
module.exports.cancelRound         = cancelRound;
module.exports.userRoom            = userRoom;
module.exports.DICE_ROOM           = DICE_ROOM;
