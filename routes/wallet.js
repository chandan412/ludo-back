const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Game = require('../models/Game');
const { auth } = require('../middleware/auth');
const {
  claimWithdrawSlot,
  releaseWithdrawSlot,
  peekWithdrawSlots,
} = require('../utils/withdrawLimit');
const { getAmountLimits, resolveWithdrawMinimum } = require('../utils/amountLimits');

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
// ✅ UTR EXTRACTION — must stay identical to extractUtr() in
// routes/paymentAutomation.js.
//
// The payment automation matches a player's recharge to a bank SMS by pulling
// the UTR out of rechargeNote with this exact logic. If the two copies ever
// diverge, a note that passes validation at submission time can silently fail
// to match at approval time, and the player gets auto-rejected after a minute
// with no way to tell what went wrong.
//
// If you change one, change both.
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

// Indian bank UTR / UPI reference numbers are at least 9 characters.
// Anything shorter is almost certainly the player typing the wrong thing
// (an amount, a phone number fragment, a date).
const MIN_UTR_LENGTH = 9;

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

// ============================================================================
// ✅ RECHARGE REQUEST — UTR IS NOW MANDATORY
//
// The payment automation matches a recharge to a bank SMS purely on the UTR
// found in rechargeNote. A request without one can NEVER be matched: it sits
// pending until /expire-pending-recharges rejects it a minute later, and the
// player is left confused.
//
// The old default of 'Payment via QR' contained no UTR at all, so every request
// that relied on it was guaranteed to fail. It has been removed — the note the
// player actually types is stored instead.
//
// NOTE FOR THE FRONTEND: the recharge form must now present the UTR field as
// REQUIRED. If it is still optional, players will hit a 400 they cannot resolve
// from the form.
// ============================================================================
router.post('/recharge-request', auth, async (req, res) => {
  try {
    const { amount, paymentNote } = req.body;

    // ✅ Minimum deposit is admin-configurable now (was hard-coded ₹10).
    const limits = await getAmountLimits();
    if (!amount || amount < limits.minDeposit)
      return res.status(400).json({ message: `Minimum recharge amount is ₹${limits.minDeposit}` });

    const note = String(paymentNote || '').trim();

    if (!note) {
      return res.status(400).json({
        message: 'Please enter the UTR / reference number from your payment.'
      });
    }

    const utr = extractUtr(note);

    if (!utr || utr.length < MIN_UTR_LENGTH) {
      return res.status(400).json({
        message: 'Enter a valid UTR / reference number (at least 9 characters). You will find it in your UPI app under the payment details.'
      });
    }

    // ✅ One pending deposit at a time — mirror of the withdrawal guard below.
    // A player can't stack multiple deposit requests; they must wait for the
    // current one to be approved/rejected first.
    const pending = await Transaction.findOne({ user: req.user._id, type: 'recharge', status: 'pending' });
    if (pending)
      return res.status(400).json({ message: 'You already have a pending deposit request. Please wait for it to be processed.' });

    // Reject an already-used UTR at submission time rather than letting the
    // matcher discover it a minute later. Better error message, and it stops
    // the pending slot being wasted.
    //
    // PERFORMANCE: this is an unindexed regex scan over recharge transactions.
    // Acceptable at current volume; when the table grows, store the extracted
    // UTR as its own indexed field on Transaction and query that instead.
    const alreadyUsed = await Transaction.findOne({
      type: 'recharge',
      status: 'approved',
      rechargeNote: { $regex: utr, $options: 'i' }
    }).select('_id').lean();

    if (alreadyUsed) {
      return res.status(400).json({
        message: 'This UTR has already been used for a previous recharge. Please enter the reference number of your new payment.'
      });
    }

    const transaction = await Transaction.create({
      user: req.user._id,
      type: 'recharge',
      amount,
      balanceBefore: req.user.balance,
      balanceAfter: req.user.balance,
      status: 'pending',
      rechargeNote: note
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
    console.error('recharge request error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/withdraw-request', auth, async (req, res) => {
  try {
    const { amount, bankDetails } = req.body;
    const { accountHolderName, accountNumber, ifscCode, bankName, upiId } = bankDetails || {};

    // ✅ TIERED MINIMUM — see utils/amountLimits.js.
    // The bar rises once a player has been paid out a set number of times, so a
    // new player's first cash-out stays easy while regulars batch into fewer,
    // larger payouts. The message explains WHY the number changed; a bare
    // "minimum is ₹200" reads as a bug to someone who withdrew ₹100 last week.
    const wMin = await resolveWithdrawMinimum(req.user._id);
    if (!amount || amount < wMin.min) {
      const why = wMin.tierApplied
        ? ` You've completed ${wMin.paidCount} withdrawal${wMin.paidCount === 1 ? '' : 's'},` +
          ` so your minimum is now ₹${wMin.min}.`
        : '';
      return res.status(400).json({
        message: `Minimum withdrawal amount is ₹${wMin.min}.${why}`,
        minWithdraw: wMin.min,
        tierApplied: wMin.tierApplied,
      });
    }
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

    // ========================================================================
    // ✅ RATE LIMIT — default 2 requests per 6 hours, admin-configurable.
    //
    // Claimed LAST, immediately before the write, and deliberately AFTER every
    // validation above. Order matters: if this ran first, a player who fat-
    // fingered their UPI ID or asked for more than their balance would burn one
    // of their two attempts on a request that was never going to be created.
    // They'd be locked out for six hours over a typo.
    //
    // The claim is atomic (a conditional $inc), so two requests fired at the
    // same moment cannot both take the last remaining slot.
    // ========================================================================
    const slot = await claimWithdrawSlot(req.user._id);
    if (!slot.allowed) {
      return res.status(429).json({
        message: slot.message,
        rateLimited: true,
        used: slot.used,
        max: slot.max,
        windowHours: slot.windowHours,
        resetAt: slot.resetAt,
      });
    }

    // ========================================================================
    // ✅ ATOMIC LOCK, THEN ATOMIC INSERT.
    //
    // The previous version did `user.lockedBalance += amount; await user.save()`
    // — a read-modify-write on a document already read further up. Under
    // concurrent taps every request read lockedBalance as 0 and wrote the same
    // value, so three of four locks silently vanished: ₹4,000 of pending
    // withdrawals sat against a ₹1,000 balance with only ₹1,000 locked.
    //
    // Now the lock is a single conditional $inc. The $expr in the FILTER
    // re-evaluates withdrawable balance against the CURRENT document, inside the
    // same operation that applies the increment — so the second concurrent
    // request sees the first one's lock and matches nothing. Over-locking is
    // arithmetically impossible rather than merely unlikely.
    // ========================================================================
    const locked = await User.findOneAndUpdate(
      {
        _id: req.user._id,
        $expr: {
          $gte: [
            { $subtract: [
              '$balance',
              { $add: [{ $ifNull: ['$lockedBalance', 0] }, { $ifNull: ['$bonusBalance', 0] }] },
            ] },
            amount,
          ],
        },
      },
      { $inc: { lockedBalance: amount } },
      { new: true }
    );

    if (!locked) {
      // Another request claimed the balance between the check above and here.
      await releaseWithdrawSlot(req.user._id);
      return res.status(400).json({ message: `Insufficient balance. Available: ₹${available}` });
    }

    let transaction;
    try {
      transaction = await Transaction.create({
        user: req.user._id,
        type: 'withdraw',
        amount,
        balanceBefore: locked.balance,
        balanceAfter: locked.balance,
        status: 'pending',
        bankDetails: { accountHolderName, accountNumber, ifscCode, bankName, upiId }
      });
    } catch (writeErr) {
      // Money first: the lock is already applied, so release it before anything
      // else. Leaving it would freeze the player's balance with no request to
      // show for it and no way for them to clear it.
      await User.updateOne(
        { _id: req.user._id, lockedBalance: { $gte: amount } },
        { $inc: { lockedBalance: -amount } }
      );
      await releaseWithdrawSlot(req.user._id);

      // 11000 = the partial unique index rejected a second pending withdrawal.
      // This is the guard working, not a fault — report it as the same friendly
      // message the pre-check gives.
      if (writeErr.code === 11000) {
        return res.status(400).json({ message: 'You already have a pending withdrawal request' });
      }
      throw writeErr;
    }

    // Kept only so the response below can report the post-lock figures.
    user.balance = locked.balance;
    user.lockedBalance = locked.lockedBalance;

    // ✅ Push to any admin with the panel open — no polling required.
    notifyAdmins(req, {
      kind: 'withdraw',
      username: req.user.username,
      amount,
    });

    res.status(201).json({
      message: 'Withdrawal request submitted. Admin will process within 24 hours.',
      transaction,
      // Echo the limit back so the wallet screen can tell the player how many
      // attempts they have left, rather than them discovering the limit only by
      // hitting it.
      withdrawLimit: slot.unlimited ? null : {
        used: slot.used,
        remaining: Math.max(0, slot.max - slot.used),
        max: slot.max,
        windowHours: slot.windowHours,
        resetAt: slot.resetAt,
      },
    });
  } catch (err) {
    console.error('withdraw request error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// POST /api/wallet/cancel-withdrawal — the PLAYER withdraws their own request.
//
// Until now only an admin could end a pending withdrawal. A player who typed
// the wrong UPI ID, or simply changed their mind, had their money locked and
// no way to release it — they had to message you and wait. That is support
// work for you and a frozen balance for them, over something they should be
// able to undo themselves.
//
// MONEY HANDLING — mirrors the admin REJECT path exactly.
// Requesting a withdrawal only LOCKED the money (`lockedBalance += amount`);
// `balance` was never reduced. So cancelling only has to RELEASE the lock.
// There is no `balance +=` anywhere below, and there must never be: adding to
// balance here would mint money out of a cancelled request.
//
// THE RACE THAT MATTERS
// You cancel and the admin approves in the same second. Both paths would
// otherwise unlock and settle the same transaction. The atomic status flip
// below is the guard: `status: 'pending'` is part of the FILTER, so whichever
// call lands first flips it and the other matches nothing and is told the
// request was already processed. Only one side can ever act.
// ============================================================================
router.post('/cancel-withdrawal', auth, async (req, res) => {
  try {
    const { transactionId } = req.body || {};

    // Claim atomically. `user: req.user._id` in the filter means a player can
    // only ever cancel their OWN request, even if they send someone else's id.
    const filter = {
      user: req.user._id,
      type: 'withdraw',
      status: 'pending',
    };
    if (transactionId) filter._id = transactionId;

    const transaction = await Transaction.findOneAndUpdate(
      filter,
      { $set: { status: 'cancelled', processedAt: new Date(), withdrawNote: 'Cancelled by player' } },
      { new: true, sort: { createdAt: -1 } }
    );

    if (!transaction) {
      return res.status(400).json({
        message: 'No pending withdrawal to cancel. It may have already been processed by admin.',
      });
    }

    const amount = transaction.amount;

    // Release the lock atomically. The `$gte` guard means the decrement can
    // never drive lockedBalance negative — which would silently inflate the
    // player's withdrawable balance, since withdrawable is
    // (balance − lockedBalance − bonusBalance).
    let user = await User.findOneAndUpdate(
      { _id: req.user._id, lockedBalance: { $gte: amount } },
      { $inc: { lockedBalance: -amount } },
      { new: true }
    );

    if (!user) {
      // lockedBalance was already lower than this request — data drift from
      // some earlier issue. Clamp to zero rather than leaving it stuck, and log
      // it loudly because it means something upstream mis-tracked a lock.
      console.error(
        `cancel-withdrawal: lockedBalance < amount for user ${req.user._id} ` +
        `(tx ${transaction._id}, amount ${amount}) — clamping to 0`
      );
      user = await User.findOneAndUpdate(
        { _id: req.user._id },
        { $set: { lockedBalance: 0 } },
        { new: true }
      );
    }

    const availableAfter = Math.max(0, user.balance - user.lockedBalance);

    // Audit row, matching the shape the admin reject path writes so the
    // player's wallet history reads consistently either way.
    await Transaction.create({
      user: req.user._id,
      type: 'withdraw',
      amount,
      balanceBefore: Math.max(0, availableAfter - amount),
      balanceAfter: availableAfter,
      status: 'cancelled',
      withdrawNote: 'Withdrawal cancelled by player — amount unlocked',
      processedAt: new Date(),
    });

    // Tell the admin panel so the request disappears from the pending list
    // instead of sitting there until someone clicks it and gets an error.
    notifyAdmins(req, {
      kind: 'withdraw-cancelled',
      username: req.user.username,
      amount,
    });

    res.json({
      message: `Withdrawal request cancelled. ₹${amount} unlocked.`,
      amount,
      balance: user.balance,
      lockedBalance: user.lockedBalance,
      available: availableAfter,
    });
  } catch (err) {
    console.error('cancel-withdrawal error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// GET /api/wallet/withdraw-limit — how many requests the player has left.
//
// Read-only; peeking never consumes a slot. Lets the wallet screen show the
// rule up front instead of the player finding out by being refused.
// ============================================================================
router.get('/withdraw-limit', auth, async (req, res) => {
  try {
    const info = await peekWithdrawSlots(req.user._id);
    // Include the resolved MINIMUM as well, so the wallet screen can show the
    // real figure for THIS player instead of a hard-coded ₹100 that may be
    // wrong for them.
    const wMin = await resolveWithdrawMinimum(req.user._id);
    res.json({
      ...info,
      minWithdraw: wMin.min,
      minWithdrawBase: wMin.base,
      tierApplied: wMin.tierApplied,
      paidWithdrawals: wMin.paidCount,
      tierAfter: wMin.tierAfter,
    });
  } catch (err) {
    console.error('withdraw-limit error:', err);
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
