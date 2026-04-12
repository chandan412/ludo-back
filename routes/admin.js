const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Game = require('../models/Game');
const { adminAuth } = require('../middleware/auth');

// GET /api/admin/players
router.get('/players', adminAuth, async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;
    const query = { role: 'player' };
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }
    const players = await User.find(query).select('-password').sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit));
    const total = await User.countDocuments(query);
    res.json({ players, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
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
    if (!userId || !amount || amount <= 0)
      return res.status(400).json({ message: 'userId and valid amount required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'Player not found' });
    if (user.role !== 'player') return res.status(400).json({ message: 'Can only add balance to players' });

    const balanceBefore = user.balance;
    user.balance += parseFloat(amount);
    await user.save();

    if (transactionId) {
      // ✅ balanceAfter = balanceBefore (stored in tx at request time) + amount added now
      const tx = await Transaction.findById(transactionId);
      await Transaction.findByIdAndUpdate(transactionId, {
        status: 'approved',
        balanceAfter: (tx?.balanceBefore || user.balance - parseFloat(amount)) + parseFloat(amount),
        processedBy: req.user._id,
        processedAt: new Date()
      });
    } else {
      await Transaction.create({
        user: userId,
        type: 'recharge',
        amount: parseFloat(amount),
        balanceBefore,
        balanceAfter: user.balance,
        status: 'approved',
        rechargeNote: note || 'Manual recharge by admin',
        processedBy: req.user._id,
        processedAt: new Date()
      });
    }

    res.json({ message: `₹${amount} added to ${user.username}'s account`, newBalance: user.balance });
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

    const transaction = await Transaction.findById(transactionId).populate('user');
    if (!transaction) return res.status(404).json({ message: 'Transaction not found' });
    if (transaction.type !== 'withdraw') return res.status(400).json({ message: 'Not a withdrawal transaction' });
    if (transaction.status !== 'pending') return res.status(400).json({ message: 'Transaction already processed' });

    const user = await User.findById(transaction.user._id);

    if (action === 'approve') {
      transaction.status = 'completed';
      transaction.withdrawNote = adminNote || 'Payment sent by admin';
      transaction.processedBy = req.user._id;
      transaction.processedAt = new Date();
      await transaction.save();
      res.json({ message: `Withdrawal of ₹${transaction.amount} approved for ${user.username}` });
    } else if (action === 'reject') {
      const balanceBefore = user.balance;
      user.balance += transaction.amount;
      await user.save();

      transaction.status = 'rejected';
      transaction.withdrawNote = adminNote || 'Rejected by admin';
      transaction.processedBy = req.user._id;
      transaction.processedAt = new Date();
      await transaction.save();

      await Transaction.create({
        user: user._id,
        type: 'recharge',
        amount: transaction.amount,
        balanceBefore,
        balanceAfter: user.balance,
        status: 'completed',
        rechargeNote: `Withdrawal rejected - refund. Reason: ${adminNote || 'N/A'}`,
        processedBy: req.user._id,
        processedAt: new Date()
      });

      res.json({ message: `Withdrawal rejected. ₹${transaction.amount} refunded to ${user.username}` });
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
