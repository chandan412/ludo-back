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

router.get('/balance', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('balance lockedBalance bonusBalance username');

    // ✅ Auto-reconcile lockedBalance against active games + pending withdrawals.
    // Prevents stale "money in game" when no game exists.
    const activeGames = await Game.find({
      'players.user': req.user._id,
      status: { $in: ['waiting', 'active'] },
    }).select('betAmount');
    const gameLocked = activeGames.reduce((sum, g) => sum + (g.betAmount || 0), 0);

    const pendingWithdraws = await Transaction.find({
      user: req.user._id,
      type: 'withdraw',
      status: 'pending',
    }).select('amount');
    const withdrawLocked = pendingWithdraws.reduce((sum, t) => sum + (t.amount || 0), 0);

    const expectedLocked = gameLocked + withdrawLocked;

    // If user's stored lockedBalance is different from the real expected, reconcile
    if (user.lockedBalance !== expectedLocked) {
      user.lockedBalance = expectedLocked;
      await user.save();
    }

    res.json({
      balance: user.balance,
      lockedBalance: user.lockedBalance,
      bonusBalance: user.bonusBalance || 0,
      // availableBalance = what they can PLAY with (includes bonus, minus locks)
      availableBalance: user.balance - user.lockedBalance,
      // withdrawableBalance = what they can WITHDRAW (excludes the non-withdrawable bonus)
      withdrawableBalance: Math.max(0, user.balance - user.lockedBalance - (user.bonusBalance || 0)),
    });
  } catch (err) {
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
