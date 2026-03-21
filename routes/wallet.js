const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth } = require('../middleware/auth');

router.get('/balance', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('balance lockedBalance username');
    res.json({
      balance: user.balance,
      lockedBalance: user.lockedBalance,
      availableBalance: user.balance - user.lockedBalance
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
    const transaction = await Transaction.create({
      user: req.user._id,
      type: 'recharge',
      amount,
      balanceBefore: req.user.balance,
      balanceAfter: req.user.balance,
      status: 'pending',
      rechargeNote: paymentNote || 'Payment via QR'
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
    if (!amount || amount < 50)
      return res.status(400).json({ message: 'Minimum withdrawal amount is ₹50' });
    const user = await User.findById(req.user._id);
    const available = user.balance - user.lockedBalance;
    if (amount > available)
      return res.status(400).json({ message: `Insufficient balance. Available: ₹${available}` });
    if (!upiId && (!accountNumber || !ifscCode || !accountHolderName))
      return res.status(400).json({ message: 'Provide UPI ID or full bank account details' });
    const pending = await Transaction.findOne({ user: req.user._id, type: 'withdraw', status: 'pending' });
    if (pending) return res.status(400).json({ message: 'You already have a pending withdrawal request' });
    user.balance -= amount;
    await user.save();
    const transaction = await Transaction.create({
      user: req.user._id,
      type: 'withdraw',
      amount,
      balanceBefore: user.balance + amount,
      balanceAfter: user.balance,
      status: 'pending',
      bankDetails: { accountHolderName, accountNumber, ifscCode, bankName, upiId }
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
