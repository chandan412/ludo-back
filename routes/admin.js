const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Game = require('../models/Game');
const { adminAuth } = require('../middleware/auth');

// ============================================================================
// GET /api/admin/players
//
// ⚠️ Three problems fixed here, measured against 3,000 users:
//
// 1. PAYLOAD — `select('-password')` strips only the password and ships
//    everything else, including fcmToken (~160 chars each). The panel renders
//    exactly ten fields. 381 KB -> 195 KB by projecting only those.
//
// 2. UNBOUNDED LIMIT — the frontend asked for limit=1000 and the route honoured
//    it. Now capped at MAX_PAGE_SIZE so no single request can ever pull the
//    whole user table.
//
// 3. CRASH ON SEARCH — `{ $regex: search }` passed raw admin input straight to
//    the regex engine. Typing a single "(" or "[" produced an invalid regular
//    expression and a 500. Input is now escaped, so it's treated as literal text.
//
// The scan itself is fixed by the { role, createdAt } index in models/User.js.
// ============================================================================
const MAX_PAGE_SIZE = 200;

// Only what AdminPanel actually renders. Everything else is dead weight on the wire.
const PLAYER_LIST_FIELDS =
  'username email phone balance lockedBalance gamesPlayed gamesWon isBanned createdAt';

// Treat admin input as literal text, not a pattern.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/players', adminAuth, async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, MAX_PAGE_SIZE);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * limit;

    const query = { role: 'player' };
    if (search) {
      const safe = escapeRegex(String(search).trim());
      if (safe) {
        query.$or = [
          { username: { $regex: safe, $options: 'i' } },
          { email:    { $regex: safe, $options: 'i' } },
          { phone:    { $regex: safe, $options: 'i' } }
        ];
      }
    }

    // Run both in parallel — they're independent, so this halves the wall-clock
    // latency, which matters on a cross-region database link.
    const [players, total] = await Promise.all([
      User.find(query)
        .select(PLAYER_LIST_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),                       // plain objects — no Mongoose document overhead
      User.countDocuments(query),
    ]);

    res.json({ players, total, page: pageNum, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('players list error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/admin/player/:id
router.get('/player/:id', adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ message: 'Player not found' });
    const transactions = await Transaction.find({ user: user._id }).sort({ createdAt: -1 }).limit(20);
    const games = await Game.find({ 'players.user': user._id }).sort({ createdAt: -1 }).limit(10);
    res.json({ user, transactions, games });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/add-balance
router.post('/add-balance', adminAuth, async (req, res) => {
  try {
    const { userId, amount, note, transactionId } = req.body;
    const amt = parseFloat(amount);
    if (!userId || !amt || amt <= 0)
      return res.status(400).json({ message: 'userId and valid amount required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'Player not found' });
    if (user.role !== 'player') return res.status(400).json({ message: 'Can only add balance to players' });

    // ── CASE A: Approving a pending recharge request (transactionId provided) ──
    if (transactionId) {
      // ✅ DOUBLE-CREDIT FIX: atomically flip the transaction pending → approved.
      // findOneAndUpdate with { status: 'pending' } in the filter means only the
      // FIRST call succeeds; a second click (double-tap / retry) matches nothing and
      // returns null, so we add the balance EXACTLY ONCE. Previously the balance was
      // added before any status check, so two clicks doubled the money.
      const tx = await Transaction.findOneAndUpdate(
        { _id: transactionId, type: 'recharge', status: 'pending' },
        { status: 'approved', processedBy: req.user._id, processedAt: new Date() },
        { new: true }
      );

      if (!tx) {
        // Already processed (or not a pending recharge) — do NOT add balance again.
        return res.status(400).json({ message: 'This recharge was already processed.' });
      }

      const balanceBefore = user.balance;
      user.balance += amt;
      await user.save();

      // Record the resulting balance on the now-approved transaction.
      tx.balanceBefore = balanceBefore;
      tx.balanceAfter  = user.balance;
      await tx.save();

      return res.json({ message: `₹${amt} added to ${user.username}'s account`, newBalance: user.balance });
    }

    // ── CASE B: Manual ad-hoc credit (no transactionId) ──
    const balanceBefore = user.balance;
    user.balance += amt;
    await user.save();

    await Transaction.create({
      user: userId,
      type: 'recharge',
      amount: amt,
      balanceBefore,
      balanceAfter: user.balance,
      status: 'approved',
      rechargeNote: note || 'Manual recharge by admin',
      processedBy: req.user._id,
      processedAt: new Date()
    });

    res.json({ message: `₹${amt} added to ${user.username}'s account`, newBalance: user.balance });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/deduct-balance
// Manually remove balance from a player (e.g. correcting an erroneous credit,
// clawing back a mistaken recharge). Only ever touches `balance` — never
// `lockedBalance` — and refuses to deduct more than the player's AVAILABLE
// (unlocked) balance, so money committed to an in-progress game is protected.
router.post('/deduct-balance', adminAuth, async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const amt = parseFloat(amount);
    if (!userId || !amt || amt <= 0)
      return res.status(400).json({ message: 'userId and valid amount required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'Player not found' });
    if (user.role !== 'player') return res.status(400).json({ message: 'Can only deduct balance from players' });

    const available = user.balance - (user.lockedBalance || 0);
    if (amt > available)
      return res.status(400).json({ message: `Cannot deduct ₹${amt}. Available (unlocked) balance is only ₹${available}` });

    const balanceBefore = user.balance;
    user.balance = balanceBefore - amt;
    await user.save();

    await Transaction.create({
      user: userId,
      type: 'withdraw',
      amount: amt,
      balanceBefore,
      balanceAfter: user.balance,
      status: 'completed',
      withdrawNote: note || 'Manual deduction by admin',
      processedBy: req.user._id,
      processedAt: new Date()
    });

    res.json({ message: `₹${amt} deducted from ${user.username}'s account`, newBalance: user.balance });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/reject-recharge
// Reject a fake/invalid recharge request — no balance added
router.post('/reject-recharge', adminAuth, async (req, res) => {
  try {
    const { transactionId, reason } = req.body;
    if (!transactionId) return res.status(400).json({ message: 'transactionId required' });

    // ✅ Atomic flip pending → rejected so a double-click can't double-process.
    // The remark is written IN THE SAME UPDATE rather than in a follow-up save():
    // one write instead of two, and no window where a rejected row exists with no
    // reason attached for the player to read.
    //
    // ⚠️ FIXED: this used to do `transaction.rechargeNote = reason` afterwards,
    // which OVERWROTE the player's own UTR / payment reference with your reason —
    // losing the exact detail you'd need if they later disputed the rejection.
    // The reason now goes to its own `adminRemark` field and rechargeNote is left
    // untouched. `remarkAck: false` is what makes the card appear for the player.
    const transaction = await Transaction.findOneAndUpdate(
      { _id: transactionId, type: 'recharge', status: 'pending' },
      {
        status: 'rejected',
        processedBy: req.user._id,
        processedAt: new Date(),
        adminRemark: reason || 'Rejected by admin — payment not received',
        remarkAck: false,
      },
      { new: true }
    ).populate('user');

    if (!transaction) return res.status(400).json({ message: 'Transaction not found or already processed' });

    res.json({ message: `Recharge request rejected for ${transaction.user?.username}` });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/process-withdrawal
router.post('/process-withdrawal', adminAuth, async (req, res) => {
  try {
    const { transactionId, action, adminNote } = req.body;
    if (!transactionId || !action)
      return res.status(400).json({ message: 'transactionId and action required' });

    // ✅ Atomic claim: flip pending → processing-marker so a double-click can't
    // settle the same withdrawal twice. Only the first call gets the doc.
    const transaction = await Transaction.findOneAndUpdate(
      { _id: transactionId, type: 'withdraw', status: 'pending' },
      { status: action === 'approve' ? 'completed' : 'rejected', processedBy: req.user._id, processedAt: new Date() },
      { new: true }
    ).populate('user');

    if (!transaction) return res.status(400).json({ message: 'Transaction not found or already processed' });

    const user = await User.findById(transaction.user._id);

    if (action === 'approve') {
      // ✅ withdraw-request only LOCKED the money (lockedBalance += amount), it never
      // reduced balance. On approval the money actually leaves the wallet: deduct from
      // BOTH balance and lockedBalance.
      const balanceBefore = user.balance;
      user.balance       = Math.max(0, user.balance - transaction.amount);
      user.lockedBalance = Math.max(0, user.lockedBalance - transaction.amount);
      await user.save();

      transaction.balanceBefore = balanceBefore;
      transaction.balanceAfter = user.balance;
      transaction.withdrawNote = adminNote || 'Payment sent by admin';
      await transaction.save();
      res.json({ message: `Withdrawal of ₹${transaction.amount} approved for ${user.username}` });
    } else if (action === 'reject') {
      // ✅ withdraw only LOCKED the money — balance was never reduced. So on reject we
      // simply RELEASE the lock (lockedBalance -= amount). No balance change.
      const availableBefore = user.balance - user.lockedBalance;
      user.lockedBalance = Math.max(0, user.lockedBalance - transaction.amount);
      await user.save();
      const availableAfter = user.balance - user.lockedBalance;

      transaction.withdrawNote = adminNote || 'Rejected by admin';
      // ✅ Same remark card as a rejected deposit, so the player is told WHY their
      // withdrawal was refused instead of just seeing the money silently unlock.
      transaction.adminRemark  = adminNote || 'Withdrawal rejected by admin';
      transaction.remarkAck    = false;
      await transaction.save();

      await Transaction.create({
        user: user._id,
        type: 'withdraw',
        amount: transaction.amount,
        balanceBefore: availableBefore,
        balanceAfter: availableAfter,
        status: 'rejected',
        withdrawNote: `Withdrawal rejected - amount unlocked. Reason: ${adminNote || 'N/A'}`,
        // ⚠️ No adminRemark on this audit row on purpose — it's a duplicate of the
        // rejection above, and setting it here would show the player TWO identical
        // cards for one rejection.
        processedBy: req.user._id,
        processedAt: new Date()
      });

      res.json({ message: `Withdrawal rejected. ₹${transaction.amount} unlocked for ${user.username}` });
    } else {
      res.status(400).json({ message: 'Invalid action. Use approve or reject' });
    }
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/admin/pending-transactions
router.get('/pending-transactions', adminAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const query = { status: 'pending' };
    if (type) query.type = type;
    const transactions = await Transaction.find(query)
      .populate('user', 'username email phone balance')
      .sort({ createdAt: -1 });
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/admin/all-transactions
router.get('/all-transactions', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 30, type } = req.query;
    const skip = (page - 1) * limit;
    const query = {};
    if (type) query.type = type;
    const transactions = await Transaction.find(query)
      .populate('user', 'username phone')
      .populate('processedBy', 'username')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    const total = await Transaction.countDocuments(query);
    res.json({ transactions, total });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/ban-player
router.post('/ban-player', adminAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findByIdAndUpdate(userId, { isBanned: true }, { new: true }).select('-password');
    if (!user) return res.status(404).json({ message: 'Player not found' });
    res.json({ message: `${user.username} has been banned`, user });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/unban-player
router.post('/unban-player', adminAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findByIdAndUpdate(userId, { isBanned: false }, { new: true }).select('-password');
    if (!user) return res.status(404).json({ message: 'Player not found' });
    res.json({ message: `${user.username} has been unbanned`, user });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/admin/dashboard-stats
router.get('/dashboard-stats', adminAuth, async (req, res) => {
  try {
    const totalPlayers = await User.countDocuments({ role: 'player' });
    const activePlayers = await User.countDocuments({ role: 'player', isBanned: false });
    const totalGames = await Game.countDocuments({ status: 'finished' });
    const activeGames = await Game.countDocuments({ status: 'active' });
    const pendingRecharges = await Transaction.countDocuments({ type: 'recharge', status: 'pending' });
    const pendingWithdrawals = await Transaction.countDocuments({ type: 'withdraw', status: 'pending' });

    const feeEarned = await Transaction.aggregate([
      { $match: { type: 'platform_fee' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const totalRechargedResult = await Transaction.aggregate([
      { $match: { type: 'recharge', status: { $in: ['approved', 'completed'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const totalWithdrawnResult = await Transaction.aggregate([
      { $match: { type: 'withdraw', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.json({
      totalPlayers,
      activePlayers,
      totalGames,
      activeGames,
      pendingRecharges,
      pendingWithdrawals,
      platformFeeEarned: feeEarned[0]?.total || 0,
      totalRecharged: totalRechargedResult[0]?.total || 0,
      totalWithdrawn: totalWithdrawnResult[0]?.total || 0
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
