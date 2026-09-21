const User = require('../models/User');

// ============================================================================
// COIN BALANCE WRITES
//
// One helper, used by both routes/dice.js and socket/diceSocket.js, so there is
// exactly one place in the codebase where a coin balance changes.
//
// ---------------------------------------------------------------------------
// ⚠️ WHY THIS IS NOT AN AGGREGATION-PIPELINE UPDATE
//
// The obvious way to write "add delta, but never below zero" in one atomic
// operation is a pipeline update:
//
//     User.findOneAndUpdate({ _id }, [{ $set: { coins: { $max: [0, ...] } } }])
//
// That works on the Mongoose 7 this project pins today. It THROWS on Mongoose 8
// and 9:
//
//     MongooseError: Cannot pass an array to query updates unless the
//     `updatePipeline` option is set.
//
// package.json says "^7.3.1", so a future `npm update` or a caret bump is all
// it would take — and the failure would land on the settlement path, where the
// symptom is locked coins that never release. Plain $inc has behaved the same
// way in every Mongoose version and needs no option flag.
//
// The cost is that $inc CAN go negative, so the clamp is a second, conditional
// write. It is conditional on purpose: `{ coins: { $lt: 0 } }` matches nothing
// in the normal case, so the repair costs an index hit and writes nothing, and
// it cannot clobber a concurrent update the way an unconditional $set would.
//
// Schema `min: 0` does not help here — Mongoose validators run on save(), not
// on update operations, unless runValidators is set, and even then $inc is not
// checked against min.
// ============================================================================

const PROJECTION = { coins: 1, lockedCoins: 1, username: 1 };

/**
 * Apply a coin change atomically, then clamp both fields at zero.
 *
 * @param {ObjectId|string} userId
 * @param {object} opts
 * @param {number} opts.delta   change to spendable coins (may be negative)
 * @param {number} opts.unlock  amount to release from lockedCoins
 * @returns {Promise<object|null>} the user's coin state after the write
 */
async function adjustCoins(userId, { delta = 0, unlock = 0 } = {}) {
  const inc = {};
  if (delta)  inc.coins       = delta;
  if (unlock) inc.lockedCoins = -unlock;

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

  // Repair only if something actually went negative. A negative balance from
  // one bad edge case corrupts every figure downstream of it — the player's
  // spendable total, the admin's economy numbers, and the next grant, which
  // would otherwise be adding to a negative base.
  let repaired = false;
  if (doc.coins < 0) {
    await User.updateOne({ _id: userId, coins: { $lt: 0 } }, { $set: { coins: 0 } });
    repaired = true;
  }
  if (doc.lockedCoins < 0) {
    await User.updateOne({ _id: userId, lockedCoins: { $lt: 0 } }, { $set: { lockedCoins: 0 } });
    repaired = true;
  }
  if (repaired) {
    console.warn('[dice] clamped negative coin balance for user', String(userId));
    doc = await User.findById(userId).select(PROJECTION);
  }

  return doc;
}

/**
 * Lock coins for a bet — the balance check and the lock in ONE operation.
 *
 * $expr evaluates (coins - lockedCoins) >= amount against the document as it is
 * at that instant, inside the same update that increments lockedCoins. Returns
 * null if the player cannot cover it.
 *
 * Read-then-write is what this replaces, and it is the exact shape the
 * withdrawal race had: several taps milliseconds apart all read the same
 * spendable total and all pass. Here, the losers simply match no document.
 *
 * `coins` is deliberately NOT reduced — only locked. That is what makes a
 * cancelled round refundable without any coins having moved.
 */
async function lockCoins(userId, amount) {
  return User.findOneAndUpdate(
    {
      _id: userId,
      $expr: {
        $gte: [
          { $subtract: [{ $ifNull: ['$coins', 0] }, { $ifNull: ['$lockedCoins', 0] }] },
          amount
        ]
      }
    },
    { $inc: { lockedCoins: amount } },
    { new: true, projection: PROJECTION }
  );
}

module.exports = { adjustCoins, lockCoins };
