const User = require('../models/User');

// Shared wallet helper for Instant Ludo.
// IMPORTANT: Instant Ludo uses the exact same fields as Classic Ludo:
//   balance       = total wallet balance (₹)
//   lockedBalance = amount currently locked by any game
//   spendable     = balance - lockedBalance
//
// A bet only increases lockedBalance. The actual balance changes during
// settlement (loss/win) or when a round is refunded.

const PROJECTION = { balance: 1, lockedBalance: 1, username: 1 };

/**
 * Apply a shared-wallet change atomically.
 * @param {ObjectId|string} userId
 * @param {object} opts
 * @param {number} opts.delta   change to balance (may be negative)
 * @param {number} opts.unlock  amount to release from lockedBalance
 */
async function adjustWallet(userId, { delta = 0, unlock = 0 } = {}) {
  const inc = {};
  if (delta)  inc.balance = delta;
  if (unlock) inc.lockedBalance = -unlock;

  let doc;
  if (Object.keys(inc).length) {
    doc = await User.findOneAndUpdate(
      { _id: userId },
      { $inc: inc },
      { new: true, projection: PROJECTION }
    );
  } else {
    doc = await User.findById(userId).select(PROJECTION);
  }

  if (!doc) return null;

  // Defensive repair only if bad legacy data or an unexpected edge case ever
  // creates a negative value. Normal game paths cannot hit this because every
  // stake is atomically locked against available balance first.
  let repaired = false;
  if (doc.balance < 0) {
    await User.updateOne({ _id: userId, balance: { $lt: 0 } }, { $set: { balance: 0 } });
    repaired = true;
  }
  if (doc.lockedBalance < 0) {
    await User.updateOne({ _id: userId, lockedBalance: { $lt: 0 } }, { $set: { lockedBalance: 0 } });
    repaired = true;
  }

  if (repaired) {
    console.warn('[dice] clamped negative shared wallet value for user', String(userId));
    doc = await User.findById(userId).select(PROJECTION);
  }

  return doc;
}

/**
 * Lock an Instant Ludo stake against the same spendable wallet used by Classic Ludo.
 * The balance check and lock happen in ONE atomic operation.
 */
async function lockWallet(userId, amount) {
  return User.findOneAndUpdate(
    {
      _id: userId,
      $expr: {
        $gte: [
          { $subtract: [{ $ifNull: ['$balance', 0] }, { $ifNull: ['$lockedBalance', 0] }] },
          amount
        ]
      }
    },
    { $inc: { lockedBalance: amount } },
    { new: true, projection: PROJECTION }
  );
}

module.exports = { adjustWallet, lockWallet };
