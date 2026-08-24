const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Game = require('../models/Game');
const { auth } = require('../middleware/auth');

// ============================================================================
// notifyAdmins — fire-and-forget push to the admin panel.
// ============================================================================
function notifyAdmins(req, payload) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const room = req.app.get('ADMIN_ROOM') || 'admin-room';
    io.to(room).emit('admin-pending-update', { ...payload, at: Date.now() });
  } catch (e) {
    console.error('notifyAdmins failed (non-fatal):', e.message);
  }
}

// ============================================================================
// UTR EXTRACTION
// ============================================================================
function extractUtr(note) {
  if (!note) return '';

  const text = String(note).trim();

  const labelled = text.match(
    /(?:UTR|REF(?:ERENCE)?|TRANSACTION(?:\s*ID)?|TXN(?:\s*ID)?)\s*[:#-]?\s*([A-Z0-9]{6,30})/i
  );

  if (labelled) {
    return labelled[1].trim().toUpperCase();
  }

  if (/^[A-Z0-9]{6,30}$/i.test(text)) {
    return text.toUpperCase();
  }

  const numeric = text.match(/\b\d{8,30}\b/);

  if (numeric) {
    return numeric[0];
  }

  return '';
}

const MIN_UTR_LENGTH = 9;

// ============================================================================
// LOCK RELEASE GRACE
// ============================================================================
const LOCK_RELEASE_GRACE_MS = 60 * 1000;

// ============================================================================
// DERIVE EXPECTED LOCK
// ============================================================================
async function deriveExpectedLock(userId) {
  const activeGames = await Game.find({
    'players.user': userId,
    status: { $in: ['waiting', 'active'] },
  }).select('betAmount').lean();

  const gameLocked = activeGames.reduce(
    (sum, g) => sum + (g.betAmount || 0),
    0
  );

  const pendingWithdraws = await Transaction.find({
    user: userId,
    type: 'withdraw',
    status: 'pending',
  }).select('amount').lean();

  const withdrawLocked = pendingWithdraws.reduce(
    (sum, t) => sum + (t.amount || 0),
    0
  );

  return gameLocked + withdrawLocked;
}

// ============================================================================
// GET WALLET BALANCE
// ============================================================================
router.get('/balance', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      'balance lockedBalance bonusBalance username'
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const storedLocked = user.lockedBalance || 0;
    const expectedLocked = await deriveExpectedLock(req.user._id);

    let effectiveLocked = Math.max(storedLocked, expectedLocked);

    if (expectedLocked > storedLocked) {
      await User.updateOne(
        {
          _id: user._id,
          lockedBalance: storedLocked
        },
        {
          $set: {
            lockedBalance: expectedLocked
          }
        }
      );

      effectiveLocked = expectedLocked;

    } else if (expectedLocked < storedLocked) {

      const recentGame = await Game.findOne({
        'players.user': req.user._id,
        createdAt: {
          $gte: new Date(Date.now() - LOCK_RELEASE_GRACE_MS)
        },
      }).select('_id').lean();

      if (!recentGame) {

        const reverified = await deriveExpectedLock(req.user._id);

        if (
          reverified === expectedLocked &&
          reverified < storedLocked
        ) {

          const result = await User.updateOne(
            {
              _id: user._id,
              lockedBalance: storedLocked
            },
            {
              $set: {
                lockedBalance: reverified
              }
            }
          );

          if (result.modifiedCount === 1) {
            effectiveLocked = reverified;

            console.log(
              `Stale lock released for ${user.username}: ₹${storedLocked} -> ₹${reverified}`
            );
          }
        }
      }
    }

    res.json({
      balance: user.balance,
      lockedBalance: effectiveLocked,
      bonusBalance: user.bonusBalance || 0,

      availableBalance: Math.max(
        0,
        user.balance - effectiveLocked
      ),

      withdrawableBalance: Math.max(
        0,
        user.balance -
          effectiveLocked -
          (user.bonusBalance || 0)
      ),
    });

  } catch (err) {
    console.error('wallet balance error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// GET TRANSACTIONS
// ============================================================================
router.get('/transactions', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const transactions = await Transaction.find({
      user: req.user._id
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('processedBy', 'username')
      .populate('gameId', 'roomCode betAmount');

    const total = await Transaction.countDocuments({
      user: req.user._id
    });

    res.json({
      transactions,
      total,
      page,
      pages: Math.ceil(total / limit)
    });

  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// RECHARGE REQUEST
// ============================================================================
router.post('/recharge-request', auth, async (req, res) => {
  try {
    const { amount, paymentNote } = req.body;

    if (!amount || amount < 10) {
      return res.status(400).json({
        message: 'Minimum recharge amount is ₹10'
      });
    }

    const note = String(paymentNote || '').trim();

    if (!note) {
      return res.status(400).json({
        message: 'Please enter the UTR / reference number from your payment.'
      });
    }

    const utr = extractUtr(note);

    if (!utr || utr.length < MIN_UTR_LENGTH) {
      return res.status(400).json({
        message:
          'Enter a valid UTR / reference number (at least 9 characters). You will find it in your UPI app under the payment details.'
      });
    }

    const transaction = await Transaction.create({
      user: req.user._id,
      type: 'deposit',
      amount,
      balanceBefore: 0,
      balanceAfter: 0,
      status: 'pending',
      rechargeNote: note
    });

    notifyAdmins(req, {
      kind: 'recharge',
      username: req.user.username,
      amount,
    });

    res.status(201).json({
      message:
        'Recharge request submitted. Admin will add balance after verifying payment.',
      transaction
    });

  } catch (err) {
    console.error('recharge request error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// WITHDRAWAL REQUEST
//
// RULE:
// Maximum 2 withdrawal requests in any rolling 6-hour window.
//
// COUNTED:
//   - pending
//   - approved
//
// NOT COUNTED:
//   - rejected
//   - other statuses
//
// Example:
//
// 10:00 -> Withdrawal #1
// 12:00 -> Withdrawal #2
// 13:00 -> BLOCKED
// 16:01 -> Withdrawal allowed again
//
// The restriction is enforced on the backend so it cannot be bypassed
// by directly calling the API from the frontend.
// ============================================================================
router.post('/withdraw-request', auth, async (req, res) => {
  try {
    const { amount, bankDetails } = req.body;

    const {
      accountHolderName,
      accountNumber,
      ifscCode,
      bankName,
      upiId
    } = bankDetails || {};

    // ------------------------------------------------------------------------
    // BASIC AMOUNT VALIDATION
    // ------------------------------------------------------------------------
    if (!amount || amount < 100) {
      return res.status(400).json({
        message: 'Minimum withdrawal amount is ₹100'
      });
    }

    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        message: 'User not found'
      });
    }

    // ------------------------------------------------------------------------
    // WITHDRAWAL LIMIT
    //
    // Maximum 2 withdrawals during the last 6 hours.
    //
    // IMPORTANT:
    // pending + approved are counted.
    // rejected withdrawals are ignored.
    // ------------------------------------------------------------------------
    const sixHoursAgo = new Date(
      Date.now() - 6 * 60 * 60 * 1000
    );

    const withdrawalCount = await Transaction.countDocuments({
      user: req.user._id,
      type: 'withdraw',
      createdAt: {
        $gte: sixHoursAgo
      },
      status: {
        $in: ['pending', 'approved']
      }
    });

    if (withdrawalCount >= 2) {
      return res.status(400).json({
        message:
          'Withdrawal limit reached. You can withdraw only 2 times in 6 hours. Please try again later.'
      });
    }

    // ------------------------------------------------------------------------
    // BONUS IS NON-WITHDRAWABLE
    // ------------------------------------------------------------------------
    const bonus = user.bonusBalance || 0;

    const available = Math.max(
      0,
      user.balance -
        user.lockedBalance -
        bonus
    );

    if (amount > available) {
      const msg =
        bonus > 0
          ? `You can't withdraw your referral bonus (₹${bonus}). Bonus can only be used to play. Withdrawable: ₹${available}`
          : `Insufficient balance. Available: ₹${available}`;

      return res.status(400).json({
        message: msg
      });
    }

    // ------------------------------------------------------------------------
    // BANK / UPI VALIDATION
    // ------------------------------------------------------------------------
    if (
      !upiId &&
      (!accountNumber ||
        !ifscCode ||
        !accountHolderName)
    ) {
      return res.status(400).json({
        message:
          'Provide UPI ID or full bank account details'
      });
    }

    // ------------------------------------------------------------------------
    // EXISTING PENDING WITHDRAWAL
    //
    // Keep this existing restriction.
    // A player cannot have another pending withdrawal.
    // ------------------------------------------------------------------------
    const pending = await Transaction.findOne({
      user: req.user._id,
      type: 'withdraw',
      status: 'pending'
    });

    if (pending) {
      return res.status(400).json({
        message:
          'You already have a pending withdrawal request'
      });
    }

    // ------------------------------------------------------------------------
    // CREATE WITHDRAWAL TRANSACTION
    // ------------------------------------------------------------------------
    const transaction = await Transaction.create({
      user: req.user._id,
      type: 'withdraw',
      amount,
      balanceBefore: user.balance,
      balanceAfter: user.balance,
      status: 'pending',

      bankDetails: {
        accountHolderName,
        accountNumber,
        ifscCode,
        bankName,
        upiId
      }
    });

    // ------------------------------------------------------------------------
    // LOCK WITHDRAWAL AMOUNT
    // ------------------------------------------------------------------------
    user.lockedBalance += amount;

    await user.save();

    // ------------------------------------------------------------------------
    // NOTIFY ADMINS
    // ------------------------------------------------------------------------
    notifyAdmins(req, {
      kind: 'withdraw',
      username: req.user.username,
      amount,
    });

    // ------------------------------------------------------------------------
    // RESPONSE
    // ------------------------------------------------------------------------
    res.status(201).json({
      message:
        'Withdrawal request submitted. Admin will process within 24 hours.',
      transaction
    });

  } catch (err) {
    console.error('withdraw request error:', err);

    res.status(500).json({
      message: 'Server error'
    });
  }
});

// ============================================================================
// ADMIN REMARK NOTICES
// ============================================================================

router.get('/notices', auth, async (req, res) => {
  try {
    const notices = await Transaction.find({
      user: req.user._id,
      status: 'rejected',
      adminRemark: { $nin: [null, ''] },
      remarkAck: { $ne: true }
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .select(
        'type amount adminRemark rechargeNote createdAt processedAt'
      )
      .lean();

    res.json(notices);

  } catch (err) {
    console.error('notices error:', err);

    res.status(500).json({
      message: 'Server error'
    });
  }
});

// ============================================================================
// ACKNOWLEDGE NOTICE
// ============================================================================
router.post('/notices/:id/ack', auth, async (req, res) => {
  try {
    const result = await Transaction.updateOne(
      {
        _id: req.params.id,
        user: req.user._id
      },
      {
        $set: {
          remarkAck: true
        }
      }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        message: 'Notice not found'
      });
    }

    res.json({
      message: 'Acknowledged'
    });

  } catch (err) {

    if (err && err.name === 'CastError') {
      return res.status(400).json({
        message: 'Invalid notice id'
      });
    }

    console.error('notice ack error:', err);

    res.status(500).json({
      message: 'Server error'
    });
  }
});

// ============================================================================
// PENDING REQUESTS
// ============================================================================
router.get('/pending-requests', auth, async (req, res) => {
  try {
    const requests = await Transaction.find({
      user: req.user._id,
      status: 'pending'
    }).sort({ createdAt: -1 });

    res.json(requests);

  } catch (err) {
    res.status(500).json({
      message: 'Server error'
    });
  }
});

module.exports = router;
