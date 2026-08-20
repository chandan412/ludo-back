const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Game = require('../models/Game');
const { auth } = require('../middleware/auth');

// ============================================================================
// ✅ notifyAdmins — fire-and-forget push to the admin panel.
//
// Replaces admin-side polling entirely. The panel previously only showed new
// deposit/withdrawal requests after a manual page refresh; polling for them
// would have meant a permanent background query load (the counters endpoint
// alone costs 9 DB queries per call). This emits ONLY at the moment a request is
// actually created, so idle cost is zero.
//
// Never throws. A socket problem must not turn a player's successful deposit
// request into a 500 — the row is already committed by the time this runs, and
// the panel has a slow safety refresh that would pick it up regardless.
// ============================================================================
function notifyAdmins(req, payload) {
  try {
    const io = req.app.get('io');
    if (!io) return; // server.js not wired yet, or running in a test harness
    const room = req.app.get('ADMIN_ROOM') || 'admin-room';
    io.to(room).emit('admin-pending-update', { ...payload, at: Date.now() });
  } catch (e) {
    console.error('notifyAdmins failed (non-fatal):', e.message);
  }
}

// ============================================================================
// ⚠️ CRITICAL FIX — the lockedBalance reconcile was a DOUBLE-SPEND vector.
//
// The previous version did a blind read-modify-write:
//
//     if (user.lockedBalance !== expectedLocked) {
//       user.lockedBalance = expectedLocked;   // ← overwrite from a stale snapshot
//       await user.save();
//     }
//
// Wallet.js polls this endpoint every 5 seconds. POST /game/create applies the
// lock and creates the Game row in TWO separate writes:
//
//     user.lockedBalance += betAmount;  await user.save();   // phase A
//     await Game.create({ ... });                            // phase B
//
// When a poll's user-read landed after phase A but its game-read landed before
// phase B, it saw lockedBalance=500 with no matching game, computed
// expectedLocked=0, and wrote that back — ERASING the lock on a live game. The
// player could then stake the same ₹500 again, or withdraw it.
//
// The reconcile is kept (it exists to clear genuinely stale locks) but is now
// DIRECTION-AWARE:
//   • The response reports the HIGHER of stored and derived, so a stale read can
//     only ever under-report spendable money (recoverable) instead of
//     over-reporting it (an unrecoverable double-spend).
//   • RAISING a lock is always safe, so it applies immediately — this also
//     self-heals accounts already corrupted by the old code.
//   • LOWERING is the dangerous direction and now requires: no game created in
//     the last 60s, a re-verification read, and a compare-and-set on the exact
//     value we read. If anything moved underneath, the write is abandoned.
//
// MONEY SAFETY: `balance` is never touched here. Only `lockedBalance` moves.
// ============================================================================

// No lock is released if the player had ANY game activity inside this window.
// Covers the phase-A/phase-B gap in /game/create, during which a derived lock of
// zero is simply a lie.
const LOCK_RELEASE_GRACE_MS = 60 * 1000;

// Derive what lockedBalance SHOULD be from live games + pending withdrawals.
// Extracted so the lowering path can re-run it as a second opinion.
async function deriveExpectedLock(userId) {
  const activeGames = await Game.find({
    'players.user': userId,
    status: { $in: ['waiting', 'active'] },
  }).select('betAmount').lean();
  const gameLocked = activeGames.reduce((sum, g) => sum + (g.betAmount || 0), 0);

  const pendingWithdraws = await Transaction.find({
    user: userId,
    type: 'withdraw',
    status: 'pending',
  }).select('amount').lean();
  const withdrawLocked = pendingWithdraws.reduce((sum, t) => sum + (t.amount || 0), 0);

  return gameLocked + withdrawLocked;
}

router.get('/balance', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('balance lockedBalance bonusBalance username');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const storedLocked   = user.lockedBalance || 0;
    const expectedLocked = await deriveExpectedLock(req.user._id);

    // Start conservative. Nothing below may lower this without proving it's safe.
    let effectiveLocked = Math.max(storedLocked, expectedLocked);

    if (expectedLocked > storedLocked) {
      // ── RAISE ──────────────────────────────────────────────────────────────
      // Money is committed to a game or pending withdrawal but isn't locked —
      // exactly the corruption the old blind overwrite caused, and the state that
      // lets the same money be spent twice. Raising can never enable a
      // double-spend, so apply it immediately. The CAS means a concurrent lock
      // change wins instead of being clobbered; if it fails we still REPORT the
      // safe higher number and the next poll retries.
      await User.updateOne(
        { _id: user._id, lockedBalance: storedLocked },
        { $set: { lockedBalance: expectedLocked } }
      );
      effectiveLocked = expectedLocked;

    } else if (expectedLocked < storedLocked) {
      // ── LOWER (dangerous — heavily guarded) ────────────────────────────────
      // Releasing a lock frees money to be staked or withdrawn. Only do it when
      // we can prove nothing is in flight.

      // Guard 1: recent game activity means a create/join may be mid-flight.
      const recentGame = await Game.findOne({
        'players.user': req.user._id,
        createdAt: { $gte: new Date(Date.now() - LOCK_RELEASE_GRACE_MS) },
      }).select('_id').lean();

      if (!recentGame) {
        // Guard 2: re-derive. This read lands a full roundtrip later, by which
        // point any create that was mid-flight has committed its Game row.
        const reverified = await deriveExpectedLock(req.user._id);

        if (reverified === expectedLocked && reverified < storedLocked) {
          // Guard 3: compare-and-set on the exact value we read. If anything
          // changed lockedBalance underneath us this matches nothing and the
          // release is abandoned rather than overwriting a fresh lock.
          const result = await User.updateOne(
            { _id: user._id, lockedBalance: storedLocked },
            { $set: { lockedBalance: reverified } }
          );
          if (result.modifiedCount === 1) {
            effectiveLocked = reverified;
            console.log(`🔓 Stale lock released for ${user.username}: ₹${storedLocked} -> ₹${reverified}`);
          }
        }
      }
    }

    res.json({
      balance: user.balance,
      lockedBalance: effectiveLocked,
      bonusBalance: user.bonusBalance || 0,
      // availableBalance = what they can PLAY with (includes bonus, minus locks)
      availableBalance: Math.max(0, user.balance - effectiveLocked),
      // withdrawableBalance = what they can WITHDRAW (excludes the non-withdrawable bonus)
      withdrawableBalance: Math.max(0, user.balance - effectiveLocked - (user.bonusBalance || 0)),
    });
  } catch (err) {
    console.error('wallet balance error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/transactions', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const transactions = await Transaction.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('processedBy', 'username')
      .populate('gameId', 'roomCode betAmount');
    const total = await Transaction.countDocuments({ user: req.user._id });
    res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/recharge-request', auth, async (req, res) => {
  try {
    const { amount, paymentNote } = req.body;
    if (!amount || amount < 10)
      return res.status(400).json({ message: 'Minimum recharge amount is ₹10' });

    // ✅ One pending deposit at a time — mirror of the withdrawal guard below.
    // A player can't stack multiple deposit requests; they must wait for the
    // current one to be approved/rejected first.
    const pending = await Transaction.findOne({ user: req.user._id, type: 'recharge', status: 'pending' });
    if (pending)
      return res.status(400).json({ message: 'You already have a pending deposit request. Please wait for it to be processed.' });

    const transaction = await Transaction.create({
      user: req.user._id,
      type: 'recharge',
      amount,
      balanceBefore: req.user.balance,
      balanceAfter: req.user.balance,
      status: 'pending',
      rechargeNote: paymentNote || 'Payment via QR'
    });

    // ✅ Push to any admin with the panel open — no polling required.
    // Deliberately a tiny signal, not the transaction itself: the panel refetches
    // the pending list (one indexed query) so it always renders authoritative,
    // fully-populated data rather than trusting a socket payload.
    // Wrapped so a socket failure can never fail the player's request.
    notifyAdmins(req, {
      kind: 'recharge',
      username: req.user.username,
      amount,
    });

    res.status(201).json({
      message: 'Recharge request submitted. Admin will add balance after verifying payment.',
      transaction
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/withdraw-request', auth, async (req, res) => {
  try {
    const { amount, bankDetails } = req.body;
    const { accountHolderName, accountNumber, ifscCode, bankName, upiId } = bankDetails || {};
    if (!amount || amount < 100)
      return res.status(400).json({ message: 'Minimum withdrawal amount is ₹100' });
    const user = await User.findById(req.user._id);
    // ✅ Bonus is NON-withdrawable. Withdrawable money = real balance minus locks minus the
    // bonus marker. If they try to withdraw into the bonus portion, tell them clearly.
    const bonus = user.bonusBalance || 0;
    const available = Math.max(0, user.balance - user.lockedBalance - bonus);
    if (amount > available) {
      const msg = bonus > 0
        ? `You can't withdraw your referral bonus (₹${bonus}). Bonus can only be used to play. Withdrawable: ₹${available}`
        : `Insufficient balance. Available: ₹${available}`;
      return res.status(400).json({ message: msg });
    }
    if (!upiId && (!accountNumber || !ifscCode || !accountHolderName))
      return res.status(400).json({ message: 'Provide UPI ID or full bank account details' });
    const pending = await Transaction.findOne({ user: req.user._id, type: 'withdraw', status: 'pending' });
    if (pending) return res.status(400).json({ message: 'You already have a pending withdrawal request' });
    // ✅ Create transaction first, then lock balance (safer if either fails)
    const transaction = await Transaction.create({
      user: req.user._id,
      type: 'withdraw',
      amount,
      balanceBefore: user.balance,
      balanceAfter: user.balance,
      status: 'pending',
      bankDetails: { accountHolderName, accountNumber, ifscCode, bankName, upiId }
    });
    user.lockedBalance += amount;
    await user.save();

    // ✅ Push to any admin with the panel open — no polling required.
    notifyAdmins(req, {
      kind: 'withdraw',
      username: req.user.username,
      amount,
    });

    res.status(201).json({
      message: 'Withdrawal request submitted. Admin will process within 24 hours.',
      transaction
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// ✅ ADMIN REMARK NOTICES
//
// When you reject a deposit or withdrawal you write a reason, but the player had
// no way to see it — the request simply vanished from their pending list with no
// explanation, so they'd re-submit the same wrong request or message you.
//
// These two endpoints back a dismissable card on the Wallet page.
//
// SECURITY: both are scoped to req.user._id, so a player can neither READ nor
// DISMISS another player's remark even if they guess a transaction id.
// ============================================================================

// GET /api/wallet/notices — unacknowledged rejection remarks for this player.
router.get('/notices', auth, async (req, res) => {
  try {
    const notices = await Transaction.find({
      user: req.user._id,
      status: 'rejected',
      adminRemark: { $nin: [null, ''] },
      remarkAck: { $ne: true },   // $ne rather than false, so pre-existing rows
                                  // (written before this field existed) still show
    })
      .sort({ createdAt: -1 })
      .limit(5)                   // a sane cap; nobody needs 20 cards stacked up
      .select('type amount adminRemark rechargeNote createdAt processedAt')
      .lean();

    res.json(notices);
  } catch (err) {
    console.error('notices error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/wallet/notices/:id/ack — player tapped "OK, got it".
router.post('/notices/:id/ack', auth, async (req, res) => {
  try {
    const result = await Transaction.updateOne(
      { _id: req.params.id, user: req.user._id },  // ← ownership guard
      { $set: { remarkAck: true } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ message: 'Notice not found' });
    }
    res.json({ message: 'Acknowledged' });
  } catch (err) {
    // A malformed id throws a CastError — that's a bad request, not a server fault.
    if (err && err.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid notice id' });
    }
    console.error('notice ack error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/pending-requests', auth, async (req, res) => {
  try {
    const requests = await Transaction.find({
      user: req.user._id,
      status: 'pending'
    }).sort({ createdAt: -1 });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
