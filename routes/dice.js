const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const { auth, adminAuth } = require('../middleware/auth');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const DiceRound   = require('../models/DiceRound');
const DiceBet     = require('../models/DiceBet');
const { getConfig, setConfig } = require('../utils/diceConfig');
const { adjustCoins, lockCoins } = require('../utils/diceCoins');
const diceSocket  = require('../socket/diceSocket');

// ============================================================================
// INSTANT LUDO — HTTP API
//
// Bets go over HTTP, not over the socket, deliberately. A bet moves a balance,
// and the HTTP layer already has the auth middleware, the ban/inactive checks,
// validation and real status codes. A socket event would need all of that
// rebuilt, and a failed bet would have no natural way to answer "why".
//
// ⚠️ COINS ONLY. Nothing in this file reads or writes `balance`, `lockedBalance`
// or `bonusBalance`, and nothing in it may ever convert coins into rupees.
// ============================================================================

// ----------------------------------------------------------------------------
// GET /api/dice/current
// ----------------------------------------------------------------------------
router.get('/current', auth, async (req, res) => {
  try {
    const cfg = await getConfig();

    const me = await User.findById(req.user._id).select('coins lockedCoins').lean();
    const coins       = me?.coins || 0;
    const lockedCoins = me?.lockedCoins || 0;

    const round = await DiceRound.findOne({ status: 'betting' })
      .sort({ createdAt: -1 })
      .lean();

    let myBets = [];
    if (round) {
      myBets = await DiceBet.find({ round: round._id, user: req.user._id })
        .select('number amount status payout')
        .lean();
    }

    res.json({
      enabled:    cfg.enabled,
      multiplier: round ? round.multiplier : cfg.multiplier,
      minBet:     cfg.minBet,
      maxBet:     cfg.maxBet,
      maxNumbers: cfg.maxNumbers,
      coins,
      lockedCoins,
      spendable:  Math.max(0, coins - lockedCoins),
      // serverTime lets the client correct for device clock drift instead of
      // trusting its own clock against bettingEndsAt.
      serverTime: new Date().toISOString(),
      round: round ? {
        roundId:       String(round._id),
        roundNumber:   round.roundNumber,
        status:        round.status,
        bettingEndsAt: round.bettingEndsAt,
        secondsLeft:   Math.max(0, Math.ceil((new Date(round.bettingEndsAt).getTime() - Date.now()) / 1000)),
      } : null,
      myBets,
    });
  } catch (err) {
    console.error('[dice] /current error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// POST /api/dice/bet   { number, amount }
// ----------------------------------------------------------------------------
router.post('/bet', auth, async (req, res) => {
  const number = parseInt(req.body?.number, 10);
  const amount = parseInt(req.body?.amount, 10);

  try {
    const cfg = await getConfig();
    if (!cfg.enabled) return res.status(403).json({ message: 'Instant Ludo is currently off' });

    if (!Number.isInteger(number) || number < 1 || number > 6) {
      return res.status(400).json({ message: 'Pick a number from 1 to 6' });
    }
    if (!Number.isInteger(amount) || amount < cfg.minBet) {
      return res.status(400).json({ message: `Minimum bet is ${cfg.minBet} coins` });
    }
    if (amount > cfg.maxBet) {
      return res.status(400).json({ message: `Maximum bet is ${cfg.maxBet} coins` });
    }

    // ✅ The window is checked HERE, on the server, against the server's own
    // clock. A client that keeps its bet button alive past the countdown gets
    // a 409, not a late bet.
    const round = await DiceRound.findOne({ status: 'betting' }).sort({ createdAt: -1 });
    if (!round) return res.status(409).json({ message: 'No round is open right now' });
    if (Date.now() >= new Date(round.bettingEndsAt).getTime()) {
      return res.status(409).json({ message: 'Betting has closed for this round' });
    }

    // ========================================================================
    // ✅ ONE PICK PER ROUND. No top-ups, no second stake on the same number.
    //
    // A player gets one chance per turn: choose a number, stake once, the die
    // rolls, the round clears. `maxNumbers` (default 1) is how many DIFFERENT
    // numbers an admin allows, and each one can be backed exactly once.
    //
    // Checked here AND enforced by the atomic create below — this read is for
    // the friendly error message, the create is what actually holds the line.
    // ========================================================================
    const mine = await DiceBet.find({ round: round._id, user: req.user._id }).select('number').lean();

    if (mine.some(b => b.number === number)) {
      return res.status(400).json({ message: 'You already picked that number this round' });
    }
    if (mine.length >= cfg.maxNumbers) {
      return res.status(400).json({
        message: cfg.maxNumbers === 1
          ? 'You have already taken your turn this round'
          : `You can pick at most ${cfg.maxNumbers} numbers per round`
      });
    }

    // ========================================================================
    // ✅ ATOMIC LOCK.
    //
    // The balance check and the lock are ONE operation. $expr evaluates
    // (coins - lockedCoins) >= amount inside the same update that increments
    // lockedCoins, against the document as it is at that instant.
    //
    // Read-then-write is what this replaces, and it is exactly the shape that
    // the withdrawal race was: five taps 100ms apart all read the same
    // spendable total and all pass. Here, four of the five simply match no
    // document and get null back.
    //
    // `coins` is NOT reduced — only locked. That is what makes a cancelled
    // round refundable without any coins having moved.
    // ========================================================================
    const locked = await lockCoins(req.user._id, amount);

    if (!locked) {
      return res.status(400).json({ message: 'Not enough coins' });
    }

    // From here on, coins are locked. Every failure path below MUST release
    // them — an orphaned lock is coins the player can see but never spend.
    let bet;
    try {
      // ✅ A plain create, and the unique index on (round, user, number) is what
      // actually holds the line — the check above is only for the friendlier
      // error. A losing concurrent insert throws 11000 here, gets its coins
      // released in the catch, and exactly one bet survives.
      bet = await DiceBet.create({
        round: round._id, user: req.user._id, number, amount,
        status: 'pending', payout: 0,
      });

      // ✅ Re-check the window AFTER the write. The round can lock in the
      // milliseconds between the check above and this insert, and a bet that
      // lands after the number has been drawn is a bet placed on a known
      // result — even if the player could not possibly have known it.
      const still = await DiceRound.findOne({ _id: round._id, status: 'betting' }).select('_id').lean();
      if (!still) throw new Error('ROUND_CLOSED');

      await Transaction.create({
        user:          req.user._id,
        type:          'coin_lock',
        currency:      'COIN',
        amount,
        // Unchanged on both sides: a lock moves nothing out of the wallet.
        balanceBefore: locked.coins,
        balanceAfter:  locked.coins,
        status:        'completed',
        diceRoundId:   round._id,
      });
    } catch (err) {
      // Compensate: undo the lock, and undo the stake we just added.
      await adjustCoins(req.user._id, { delta: 0, unlock: amount }).catch(() => {});

      // Only clean up a row we actually created. A duplicate-key failure created
      // nothing, so there is nothing to delete — and deleting by (round, user,
      // number) here would remove the winning insert belonging to the tap that
      // succeeded.
      if (bet?._id) await DiceBet.deleteOne({ _id: bet._id, status: 'pending' }).catch(() => {});

      if (err.code === 11000) {
        return res.status(400).json({ message: 'You already picked that number this round' });
      }
      if (err.message === 'ROUND_CLOSED') {
        return res.status(409).json({ message: 'Betting has closed for this round' });
      }
      throw err;
    }

    await DiceRound.updateOne({ _id: round._id }, { $inc: { totalStaked: amount } });

    const myBets = await DiceBet.find({ round: round._id, user: req.user._id })
      .select('number amount status payout')
      .lean();

    res.json({
      message:     'Bet placed',
      roundNumber: round.roundNumber,
      coins:       locked.coins,
      lockedCoins: locked.lockedCoins,
      spendable:   Math.max(0, locked.coins - locked.lockedCoins),
      myBets,
    });
  } catch (err) {
    console.error('[dice] /bet error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// GET /api/dice/history?limit=20
// ----------------------------------------------------------------------------
router.get('/history', auth, async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const rounds = await DiceRound.find({ status: 'settled' })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('roundNumber drawnNumber multiplier settledAt')
      .lean();

    const ids = rounds.map(r => r._id);
    const mine = await DiceBet.find({ round: { $in: ids }, user: req.user._id })
      .select('round number amount status payout')
      .lean();

    const byRound = new Map();
    for (const b of mine) {
      const k = String(b.round);
      if (!byRound.has(k)) byRound.set(k, []);
      byRound.get(k).push({ number: b.number, amount: b.amount, status: b.status, payout: b.payout });
    }

    res.json({
      rounds: rounds.map(r => ({
        roundNumber: r.roundNumber,
        drawnNumber: r.drawnNumber,
        multiplier:  r.multiplier,
        settledAt:   r.settledAt,
        myBets:      byRound.get(String(r._id)) || [],
      })),
    });
  } catch (err) {
    console.error('[dice] /history error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// ADMIN
// ============================================================================

// ----------------------------------------------------------------------------
// GET /api/dice/admin/config
// ----------------------------------------------------------------------------
router.get('/admin/config', adminAuth, async (req, res) => {
  try {
    res.json(await getConfig(true));
  } catch (err) {
    console.error('[dice] /admin/config error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/dice/admin/config
// ----------------------------------------------------------------------------
router.put('/admin/config', adminAuth, async (req, res) => {
  try {
    const before = await getConfig(true);
    const cfg    = await setConfig(req.body || {});

    // Flipping the switch takes effect now, not at the next round boundary.
    if (before.enabled !== cfg.enabled) {
      await diceSocket.applyEnabledChange();
    }

    res.json({ message: 'Settings updated', config: cfg });
  } catch (err) {
    console.error('[dice] PUT /admin/config error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// GET /api/dice/admin/stats?days=1
// ----------------------------------------------------------------------------
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const days  = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 1));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const agg = await DiceRound.aggregate([
      { $match: { status: 'settled', settledAt: { $gte: since } } },
      { $group: {
          _id: null,
          rounds:  { $sum: 1 },
          staked:  { $sum: '$totalStaked' },
          paidOut: { $sum: '$totalPaidOut' },
      }}
    ]);

    const row     = agg[0] || { rounds: 0, staked: 0, paidOut: 0 };
    const cfg     = await getConfig();
    const staked  = row.staked  || 0;
    const paidOut = row.paidOut || 0;

    // ✅ ACTUAL margin, measured. Not the theoretical figure.
    //
    // Theoretical at 5× is 1 - 5/6 = 16.67%. Expect the actual number to swing
    // wildly over a few hundred rounds — variance on a 1-in-6 event is
    // enormous and a gap early means nothing. A gap that PERSISTS over many
    // thousands of rounds is the signal, and it means the settlement code is
    // wrong, not that the dice are unlucky.
    const actualMargin = staked > 0 ? ((staked - paidOut) / staked) * 100 : 0;
    const theoretical  = (1 - (cfg.multiplier / 6)) * 100;

    const totalCoins = await User.aggregate([
      { $group: { _id: null, coins: { $sum: '$coins' }, locked: { $sum: '$lockedCoins' } } }
    ]);

    res.json({
      days,
      rounds:  row.rounds || 0,
      staked,
      paidOut,
      actualMargin:      Math.round(actualMargin * 100) / 100,
      theoreticalMargin: Math.round(theoretical * 100) / 100,
      coinsInCirculation: totalCoins[0]?.coins  || 0,
      coinsLocked:        totalCoins[0]?.locked || 0,
      config: cfg,
    });
  } catch (err) {
    console.error('[dice] /admin/stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// POST /api/dice/admin/grant-coins   { userId, amount, note }
//
// The ONLY way coins enter the system. There is deliberately no purchase route
// and no rupee-to-coin conversion anywhere in this codebase.
// ----------------------------------------------------------------------------
router.post('/admin/grant-coins', adminAuth, async (req, res) => {
  try {
    const { userId, note } = req.body || {};
    const amount = parseInt(req.body?.amount, 10);

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid user' });
    }
    // Negative amounts are allowed — an admin needs to be able to take back a
    // mistaken grant — but the $max clamp below stops it going below zero.
    if (!Number.isInteger(amount) || amount === 0) {
      return res.status(400).json({ message: 'Amount must be a non-zero whole number' });
    }

    const exists = await User.exists({ _id: userId });
    if (!exists) return res.status(404).json({ message: 'User not found' });

    const updated = await adjustCoins(userId, { delta: amount });
    if (!updated) return res.status(404).json({ message: 'User not found' });

    await Transaction.create({
      user:          userId,
      type:          'coin_grant',
      currency:      'COIN',
      amount:        Math.abs(amount),
      balanceBefore: Math.max(0, updated.coins - amount),
      balanceAfter:  updated.coins,
      status:        'completed',
      adminRemark:   String(note || '').slice(0, 200),
      processedBy:   req.user._id,
      processedAt:   new Date(),
    });

    res.json({
      message:  amount > 0 ? 'Coins granted' : 'Coins removed',
      username: updated.username,
      coins:    updated.coins,
      lockedCoins: updated.lockedCoins,
    });
  } catch (err) {
    console.error('[dice] /admin/grant-coins error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// POST /api/dice/admin/cancel-round — refund whatever is currently open.
// ----------------------------------------------------------------------------
router.post('/admin/cancel-round', adminAuth, async (req, res) => {
  try {
    const open = await DiceRound.findOne({ status: { $in: ['betting', 'locked'] } })
      .sort({ createdAt: -1 })
      .select('_id roundNumber')
      .lean();

    if (!open) return res.status(404).json({ message: 'No open round' });

    await diceSocket.cancelRound(open._id, String(req.body?.reason || 'cancelled by admin'));
    res.json({ message: `Round ${open.roundNumber} cancelled and refunded` });
  } catch (err) {
    console.error('[dice] /admin/cancel-round error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
