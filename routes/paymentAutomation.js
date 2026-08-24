const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

const Transaction = require('../models/Transaction');
const BankPayment = require('../models/BankPayment');
const User = require('../models/User');
const { adminAuth } = require('../middleware/auth');

const settingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      unique: true,
      required: true
    },

    autoVerify: {
      type: Boolean,
      default: false
    },

    maxAutoAmount: {
      type: Number,
      default: 5000,
      min: 0
    }
  },
  {
    timestamps: true
  }
);

const PaymentAutomationSettings =
  mongoose.models.PaymentAutomationSettings ||
  mongoose.model(
    'PaymentAutomationSettings',
    settingsSchema
  );

function automationSecret(req, res, next) {
  const configuredSecret =
    process.env.PAYMENT_AUTOMATION_SECRET;

  if (!configuredSecret) {
    return res.status(503).json({
      message: 'Payment automation secret is not configured'
    });
  }

  const suppliedSecret =
    req.headers['x-payment-automation-secret'];

  if (
    !suppliedSecret ||
    suppliedSecret !== configuredSecret
  ) {
    return res.status(401).json({
      message: 'Unauthorized'
    });
  }

  next();
}

/* ============================================================
   BANK ACCOUNT ALLOWLIST

   Only credit SMS for accounts listed in
   ALLOWED_BANK_ACCOUNTS are eligible for matching.

   Example env value:
   ALLOWED_BANK_ACCOUNTS=XX794,XX1234

   Leave the env var empty to allow every account
   (single-account setups).
   ============================================================ */

function getAllowedBankAccounts() {
  return String(
    process.env.ALLOWED_BANK_ACCOUNTS || ''
  )
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
}

function isAllowedBankAccount(bankAccount) {
  const allowed = getAllowedBankAccounts();

  if (allowed.length === 0) {
    return true;
  }

  return allowed.includes(
    String(bankAccount || '').trim().toUpperCase()
  );
}

function normalizeUtr(value) {
  if (!value) return '';

  return String(value)
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

function extractUtr(note) {
  if (!note) return '';

  const text = String(note).trim();

  const labelled = text.match(
    /(?:UTR|REF(?:ERENCE)?|TRANSACTION(?:\s*ID)?|TXN(?:\s*ID)?)\s*[:#-]?\s*([A-Z0-9]{6,30})/i
  );

  if (labelled) {
    return normalizeUtr(labelled[1]);
  }

  if (/^[A-Z0-9]{6,30}$/i.test(text)) {
    return normalizeUtr(text);
  }

  const numeric = text.match(/\b\d{8,30}\b/);

  if (numeric) {
    return normalizeUtr(numeric[0]);
  }

  return '';
}

async function rejectRecharge(transaction, reason) {
  if (!transaction) return null;

  return Transaction.findOneAndUpdate(
    {
      _id: transaction._id,
      type: 'recharge',
      status: 'pending'
    },
    {
      $set: {
        status: 'rejected',
        adminRemark: reason,
        remarkAck: false,
        processedAt: new Date()
      }
    },
    {
      new: true
    }
  );
}

async function approveRecharge(transaction, bankPayment) {
  if (!transaction || !bankPayment) {
    return {
      ok: false,
      reason: 'missing_transaction_or_bank_payment'
    };
  }

  // Claim the pending transaction first.
  // This prevents the same recharge from being credited twice.
  const claimed = await Transaction.findOneAndUpdate(
    {
      _id: transaction._id,
      type: 'recharge',
      status: 'pending'
    },
    {
      $set: {
        status: 'approved',
        processedAt: new Date()
      }
    },
    {
      new: true
    }
  );

  if (!claimed) {
    return {
      ok: false,
      alreadyProcessed: true,
      transaction: await Transaction.findById(
        transaction._id
      )
    };
  }

  try {
    const user =
      await User.findById(claimed.user);

    if (!user) {
      await Transaction.findOneAndUpdate(
        {
          _id: claimed._id,
          status: 'approved'
        },
        {
          $set: {
            status: 'pending',
            processedAt: null
          }
        }
      );

      throw new Error(
        'Player not found while approving recharge'
      );
    }

    const amount =
      Number(claimed.amount);

    const balanceBefore =
      Number(user.balance || 0);

    const balanceAfter =
      balanceBefore + amount;

    user.balance =
      balanceAfter;

    await user.save();

    claimed.balanceBefore =
      balanceBefore;

    claimed.balanceAfter =
      balanceAfter;

    claimed.processedAt =
      new Date();

    await claimed.save();

    /* ========================================================
       DELETE THE BANK PAYMENT ONCE CREDITED

       The unique index on BankPayment.utr is what stops the
       same bank SMS being processed twice. Once the recharge
       has actually been credited, that row has done its job.

       Deleting it releases the UTR from the unique index so a
       recycled reference number from another bank cannot be
       rejected as a false duplicate.

       Replay protection after this point comes from
       findSuccessfulRechargeByUtr, which scans approved
       recharges.
       ======================================================== */

    await BankPayment.deleteOne({
      _id: bankPayment._id
    });

    return {
      ok: true,
      transaction: claimed,
      balanceBefore,
      balanceAfter
    };

  } catch (error) {

    // Roll back transaction status if approval fails.
    await Transaction.findOneAndUpdate(
      {
        _id: claimed._id,
        status: 'approved'
      },
      {
        $set: {
          status: 'pending',
          processedAt: null
        }
      }
    );

    throw error;
  }
}

async function findSuccessfulRechargeByUtr(utr) {
  const normalizedUtr =
    normalizeUtr(utr);

  if (!normalizedUtr) {
    return null;
  }

  // Lookback raised from 500 to 5000. Because approved bank
  // payments are now deleted, this scan is the only guard
  // against a previously credited UTR being replayed, so the
  // window needs to cover far more history.
  const approvedTransactions =
    await Transaction.find({
      type: 'recharge',
      status: 'approved'
    })
      .sort({
        processedAt: -1,
        createdAt: -1
      })
      .limit(5000);

  for (
    const tx of approvedTransactions
  ) {
    const txUtr =
      extractUtr(
        tx.rechargeNote
      );

    if (
      txUtr &&
      txUtr === normalizedUtr
    ) {
      return tx;
    }
  }

  return null;
}

async function getSettings() {
  let settings =
    await PaymentAutomationSettings.findOne({
      key: 'default'
    });

  if (!settings) {
    settings =
      await PaymentAutomationSettings.create({
        key: 'default',
        autoVerify: false,
        maxAutoAmount: 5000
      });
  }

  return settings;
}

async function getPendingRecharges() {
  return Transaction.find({
    type: 'recharge',
    status: 'pending'
  })
    .sort({
      createdAt: 1
    })
    .limit(200);
}

/* ============================================================
   ADMIN SETTINGS
   ============================================================ */

router.get(
  '/settings',
  adminAuth,
  async (req, res) => {
    try {
      const settings =
        await getSettings();

      res.json({
        autoVerify:
          settings.autoVerify,
        maxAutoAmount:
          settings.maxAutoAmount,
        allowedBankAccounts:
          getAllowedBankAccounts()
      });

    } catch (err) {
      console.error(
        'Payment automation settings error:',
        err
      );

      res.status(500).json({
        message: 'Server error'
      });
    }
  }
);

router.put(
  '/settings',
  adminAuth,
  async (req, res) => {
    try {
      const autoVerify =
        req.body.autoVerify === true ||
        req.body.autoVerify === 'true';

      const maxAutoAmount =
        Number(req.body.maxAutoAmount);

      if (
        !Number.isFinite(maxAutoAmount) ||
        maxAutoAmount < 0
      ) {
        return res.status(400).json({
          message:
            'Maximum amount must be a valid number'
        });
      }

      const settings =
        await PaymentAutomationSettings.findOneAndUpdate(
          {
            key: 'default'
          },
          {
            $set: {
              autoVerify,
              maxAutoAmount
            }
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
          }
        );

      res.json({
        autoVerify:
          settings.autoVerify,
        maxAutoAmount:
          settings.maxAutoAmount
      });

    } catch (err) {
      console.error(
        'Save automation settings error:',
        err
      );

      res.status(500).json({
        message: 'Server error'
      });
    }
  }
);

/* ============================================================
   SAFE MATCH WRAPPER

   Recording the bank payment is the critical step: once that
   row exists, the expiry sweep can always match it later.

   So a failure inside the matcher must never turn a
   successfully recorded payment into a 500. The error is
   logged and reported in the response instead.
   ============================================================ */

async function runMatch(input) {
  try {

    const result =
      await matchBankPayment(input);

    return result.payload;

  } catch (err) {

    console.error(
      'Inline match failed (payment still recorded):',
      err.message
    );

    return {
      matched: false,
      decision: 'ERROR',
      reason: 'match_failed'
    };
  }
}

/* ============================================================
   RECEIVE BANK SMS
   ============================================================ */

router.post(
  ['/bank-sms', '/sms'],
  automationSecret,
  async (req, res) => {
    try {
      const {
        amount,
        utr,
        bankAccount,
        direction,
        smsText,
        smsAt
      } = req.body;

      const parsedAmount =
        Number(amount);

      const normalizedUtr =
        normalizeUtr(utr);

      if (
        !Number.isFinite(parsedAmount) ||
        parsedAmount <= 0
      ) {
        return res.status(400).json({
          message: 'Invalid amount'
        });
      }

      if (!normalizedUtr) {
        return res.status(400).json({
          message: 'UTR is required'
        });
      }

      const normalizedDirection =
        String(
          direction || ''
        ).toLowerCase();

      if (
        normalizedDirection === 'debit'
      ) {
        try {
          await BankPayment.create({
            amount:
              parsedAmount,
            utr:
              normalizedUtr,
            bankAccount:
              bankAccount || '',
            direction:
              'debit',
            smsText:
              smsText || '',
            smsAt:
              smsAt
                ? new Date(smsAt)
                : new Date(),
            status:
              'ignored'
          });

        } catch (err) {

          if (
            err?.code !== 11000
          ) {
            throw err;
          }
        }

        return res.json({
          accepted: false,
          reason:
            'debit_sms_ignored'
        });
      }

      if (
        normalizedDirection !==
        'credit'
      ) {
        return res.status(400).json({
          message:
            'direction must be credit or debit'
        });
      }

      /* ========================================================
         ACCOUNT ALLOWLIST

         A credit into an account that is not on the allowlist
         is recorded for audit but marked 'ignored', so it can
         never be matched to a player recharge.

         Without this, once a second bank account forwards SMS,
         a payment into ANY of those accounts could be claimed
         as a recharge.
         ======================================================== */

      if (!isAllowedBankAccount(bankAccount)) {

        try {
          await BankPayment.create({
            amount:
              parsedAmount,
            utr:
              normalizedUtr,
            bankAccount:
              bankAccount || '',
            direction:
              'credit',
            smsText:
              smsText || '',
            smsAt:
              smsAt
                ? new Date(smsAt)
                : new Date(),
            status:
              'ignored'
          });

        } catch (err) {

          if (
            err?.code !== 11000
          ) {
            throw err;
          }
        }

        return res.json({
          accepted: false,
          reason:
            'account_not_allowlisted'
        });
      }

      let bankPayment;

      try {

        bankPayment =
          await BankPayment.create({
            amount:
              parsedAmount,
            utr:
              normalizedUtr,
            bankAccount:
              bankAccount || '',
            direction:
              'credit',
            smsText:
              smsText || '',
            smsAt:
              smsAt
                ? new Date(smsAt)
                : new Date(),
            status:
              'pending'
          });

      } catch (err) {

        if (
          err?.code === 11000
        ) {

          const existing =
            await BankPayment.findOne({
              utr:
                normalizedUtr
            });

          // The SMS is a repeat, but the player may have
          // submitted their request since the first one arrived.
          // Re-running the match is safe: approveRecharge claims
          // the transaction atomically, and an already-credited
          // UTR is caught by findSuccessfulRechargeByUtr.
          const dupMatch =
            await runMatch({
              amount:
                existing?.amount ??
                parsedAmount,
              utr:
                normalizedUtr,
              bankPaymentId:
                existing?._id ||
                null
            });

          return res.json({
            accepted: true,
            duplicate: true,
            bankPaymentId:
              existing?._id ||
              null,
            amount:
              existing?.amount ??
              parsedAmount,
            utr:
              normalizedUtr,
            match:
              dupMatch
          });
        }

        throw err;
      }

      /* ========================================================
         MATCH IMMEDIATELY

         Previously an external workflow made a second HTTP call
         to /match after this one returned. That hop is gone:
         the match runs in-process, so the phone gets the final
         decision in a single request and there is no third-party
         service sitting in the payment path.
         ======================================================== */

      const matchResult =
        await runMatch({
          amount:
            bankPayment.amount,
          utr:
            bankPayment.utr,
          bankPaymentId:
            bankPayment._id
        });

      return res.status(201).json({
        accepted: true,
        duplicate: false,
        bankPaymentId:
          bankPayment._id,
        amount:
          bankPayment.amount,
        utr:
          bankPayment.utr,
        match:
          matchResult
      });

    } catch (err) {

      console.error(
        'Bank SMS processing error:',
        err
      );

      res.status(500).json({
        message: 'Server error'
      });
    }
  }
);

/* ============================================================
   GET PENDING BANK PAYMENTS

   Money that arrived but has not yet been claimed by a player.

   These rows are kept indefinitely. A credit is real money in
   the account, so it stays available to match whenever the
   player gets around to submitting their request — minutes or
   days later. There is no expiry sweep for bank payments.

   A row leaves this list in exactly two ways: it is matched and
   credited (approveRecharge deletes it), or an admin disposes
   of it manually.
   ============================================================ */

router.get(
  '/pending-bank-payments',
  automationSecret,
  async (req, res) => {
    try {

      const payments =
        await BankPayment.find({
          direction:
            'credit',
          status:
            'pending'
        })
          .sort({
            createdAt: 1
          })
          .limit(50);

      res.json(
        payments
      );

    } catch (err) {

      console.error(
        'Pending bank payments error:',
        err
      );

      res.status(500).json({
        message: 'Server error'
      });
    }
  }
);

/* ============================================================
   MATCH BANK PAYMENT TO PLAYER RECHARGE

   IMPORTANT:

   Bank SMS can arrive BEFORE player request.

   Bank SMS can arrive AFTER player request.

   smsAt is stored for audit only.

   smsAt is NEVER compared with Transaction.createdAt.

   Player's 3-minute expiry is handled separately by:
   /expire-pending-recharges
   ============================================================ */

/* ============================================================
   MATCH BANK PAYMENT TO PLAYER RECHARGE

   Bank SMS can arrive BEFORE the player request.
   Bank SMS can arrive AFTER the player request.

   smsAt is stored for audit only.
   smsAt is NEVER compared with Transaction.createdAt.

   The player's expiry window is handled separately by
   sweepPendingRecharges().

   Written as a plain function so /sms can call it directly the
   moment a credit is recorded. There is no second HTTP hop and
   no external workflow engine in the payment path.
   ============================================================ */

function ok(payload) {
  return { httpStatus: 200, payload };
}

function fail(httpStatus, payload) {
  return { httpStatus, payload };
}

async function matchBankPayment(input) {


      const {
        amount,
        utr,
        bankPaymentId
      } = input || {};

      const bankSmsAmount =
        Number(amount);

      const bankSmsUtr =
        normalizeUtr(utr);

      if (
        !Number.isFinite(
          bankSmsAmount
        ) ||
        bankSmsAmount <= 0
      ) {
        return fail(400, {
          message:
            'Invalid amount'
        });
      }

      if (!bankSmsUtr) {
        return fail(400, {
          message:
            'UTR is required'
        });
      }

      let bankPayment =
        null;

      if (bankPaymentId) {

        bankPayment =
          await BankPayment.findById(
            bankPaymentId
          );
      }

      if (!bankPayment) {

        bankPayment =
          await BankPayment.findOne({
            utr:
              bankSmsUtr,
            direction:
              'credit'
          });
      }

      if (!bankPayment) {

        return ok({
          matched: false,
          decision:
            'WAITING',
          reason:
            'bank_payment_not_found',
          amount:
            bankSmsAmount,
          utr:
            bankSmsUtr
        });
      }

      /* ========================================================
         NEVER MATCH AN IGNORED BANK PAYMENT

         Rows marked 'ignored' are debits or credits into
         accounts that are not on the allowlist. They exist for
         audit only and must never be credited to a player.
         ======================================================== */

      if (
        bankPayment.status === 'ignored'
      ) {
        return ok({
          matched: false,
          decision:
            'NO_MATCH',
          reason:
            'bank_payment_ignored',
          amount:
            Number(bankPayment.amount),
          utr:
            normalizeUtr(bankPayment.utr)
        });
      }

      const actualBankAmount =
        Number(
          bankPayment.amount
        );

      const actualBankUtr =
        normalizeUtr(
          bankPayment.utr
        );

      if (
        actualBankUtr !==
        bankSmsUtr
      ) {
        return fail(400, {
          message:
            'Bank payment UTR does not match supplied bank UTR'
        });
      }

      /* ========================================================
         CHECK IF UTR WAS ALREADY APPROVED
         ======================================================== */

      const successfulRecharge =
        await findSuccessfulRechargeByUtr(
          actualBankUtr
        );

      if (successfulRecharge) {

        const pendingRecharges =
          await getPendingRecharges();

        let duplicateTransaction =
          null;

        for (
          const tx of pendingRecharges
        ) {

          const playerUtr =
            extractUtr(
              tx.rechargeNote
            );

          if (
            playerUtr &&
            playerUtr ===
              actualBankUtr
          ) {
            duplicateTransaction =
              tx;

            break;
          }
        }

        if (
          duplicateTransaction
        ) {

          const rejected =
            await rejectRecharge(
              duplicateTransaction,
              'This UTR has already been used for another successful recharge. Please submit a new recharge request with a valid UTR.'
            );

          return ok({
            matched: false,
            decision:
              'REJECTED',
            reason:
              'utr_already_used',
            transactionId:
              rejected?._id ||
              duplicateTransaction._id,
            userId:
              duplicateTransaction.user,
            amount:
              duplicateTransaction.amount,
            utr:
              actualBankUtr,
            previousTransactionId:
              successfulRecharge._id
          });
        }

        return ok({
          matched: false,
          decision:
            'NO_MATCH',
          reason:
            'utr_already_used',
          amount:
            actualBankAmount,
          utr:
            actualBankUtr,
          previousTransactionId:
            successfulRecharge._id
        });
      }

      /* ========================================================
         FIND PENDING PLAYER REQUESTS
         ======================================================== */

      const pendingRecharges =
        await getPendingRecharges();

      let exactUtrTransaction =
        null;

      for (
        const tx of pendingRecharges
      ) {

        const playerUtr =
          extractUtr(
            tx.rechargeNote
          );

        if (
          playerUtr &&
          playerUtr ===
            actualBankUtr
        ) {
          exactUtrTransaction =
            tx;

          break;
        }
      }

      /* ========================================================
         EXACT UTR FOUND
         ======================================================== */

      if (
        exactUtrTransaction
      ) {

        /* ======================================================
           SAME UTR + WRONG AMOUNT
           ====================================================== */

        if (
          Number(
            exactUtrTransaction.amount
          ) !==
          actualBankAmount
        ) {

          const rejected =
            await rejectRecharge(
              exactUtrTransaction,
              `Wrong payment amount. Your UTR belongs to a ₹${actualBankAmount} payment, but your recharge request was for ₹${exactUtrTransaction.amount}. Please submit a new recharge request with the correct amount.`
            );

          return ok({
            matched: false,
            decision:
              'REJECTED',
            reason:
              'amount_mismatch',
            transactionId:
              rejected?._id ||
              exactUtrTransaction._id,
            userId:
              exactUtrTransaction.user,
            requestedAmount:
              exactUtrTransaction.amount,
            actualPaymentAmount:
              actualBankAmount,
            utr:
              actualBankUtr
          });
        }

        /* ======================================================
           SAME UTR + SAME AMOUNT

           NO SMS TIME COMPARISON.

           This works when SMS arrived:
           - before the player request
           - after the player request
        ====================================================== */

        const settings =
          await getSettings();

        if (
          !settings.autoVerify
        ) {
          return ok({
            matched: true,
            decision:
              'MANUAL',
            reason:
              'auto_verify_disabled',
            transactionId:
              exactUtrTransaction._id,
            userId:
              exactUtrTransaction.user,
            amount:
              exactUtrTransaction.amount,
            utr:
              actualBankUtr
          });
        }

        if (
          actualBankAmount >
          settings.maxAutoAmount
        ) {
          return ok({
            matched: true,
            decision:
              'MANUAL',
            reason:
              'amount_exceeds_limit',
            transactionId:
              exactUtrTransaction._id,
            userId:
              exactUtrTransaction.user,
            amount:
              exactUtrTransaction.amount,
            utr:
              actualBankUtr,
            maxAutoAmount:
              settings.maxAutoAmount
          });
        }

        // Actually approve the recharge and credit the player's
        // balance. The transaction changes from pending -> approved,
        // so it automatically disappears from the Pending list.
        // The BankPayment row is deleted inside approveRecharge.

        const approval =
          await approveRecharge(
            exactUtrTransaction,
            bankPayment
          );

        if (
          approval.alreadyProcessed
        ) {
          return ok({
            matched: true,
            decision:
              'ALREADY_PROCESSED',
            reason:
              'recharge_already_processed',
            transactionId:
              exactUtrTransaction._id,
            userId:
              exactUtrTransaction.user,
            amount:
              exactUtrTransaction.amount,
            utr:
              actualBankUtr
          });
        }

        if (!approval.ok) {
          return fail(500, {
            matched: false,
            decision:
              'ERROR',
            reason:
              approval.reason ||
              'approval_failed',
            transactionId:
              exactUtrTransaction._id,
            utr:
              actualBankUtr
          });
        }

        return ok({
          matched: true,
          decision:
            'APPROVE',
          transactionId:
            approval.transaction._id,
          userId:
            approval.transaction.user,
          amount:
            approval.transaction.amount,
          utr:
            actualBankUtr,
          balanceBefore:
            approval.balanceBefore,
          balanceAfter:
            approval.balanceAfter
        });
      }

      /* ========================================================
         NO UTR MATCH

         DO NOT REJECT IMMEDIATELY.

         Player remains pending until the 3-minute expiry.
         ======================================================== */

      return ok({
        matched: false,
        decision:
          'WAITING',
        reason:
          'utr_mismatch_or_pending_bank_sms',
        amount:
          actualBankAmount,
        bankUtr:
          actualBankUtr
      });

}

router.post(
  '/match',
  automationSecret,
  async (req, res) => {
    try {

      const result =
        await matchBankPayment(req.body);

      return res
        .status(result.httpStatus)
        .json(result.payload);

    } catch (err) {

      console.error(
        'Payment matching error:',
        err
      );

      return res.status(500).json({
        message:
          'Server error'
      });
    }
  }
);

/* ============================================================
   RECHARGE SWEEP

   Runs on a timer (every 30s -- see jobs/paymentScheduler.js)
   AND is what /sms calls inline the moment a bank credit lands.

   THIS IS THE ONLY PLACE THE APPROVAL DECISION IS MADE.
   Both entry points below end up calling matchBankPayment() --
   there is no second copy of the amount-check / autoVerify /
   approve logic living in this sweep. That used to be true only
   in principle; earlier versions of this sweep re-implemented
   the same checks by hand, which is exactly the kind of thing
   that quietly drifts out of sync over time.

   WHY IT CHECKS EVERY PENDING RECHARGE, NOT JUST OLD ONES
   ---------------------------------------------------------
   The previous version only looked at a recharge once it had
   been pending for 5+ minutes. That meant even a PERFECT match
   -- bank SMS already sitting there, amount correct, autoVerify
   on -- still wasn't credited until the full 5 minutes had
   passed, because nothing re-checked it in between.

   Now every pending recharge is checked on every tick. A match
   that already exists is caught and approved on the very next
   tick (worst case ~30s), regardless of how old the request is.
   The REVIEW_WINDOW_MS below is no longer "how long before we
   look" -- it is purely "how long to wait before handing an
   unmatched request to an admin instead of continuing to wait
   for a delayed SMS."

   WHAT HAPPENS ON EACH TICK, PER PENDING RECHARGE
   --------------------------------------------------
   - No UTR on the request at all: left alone until the review
     window passes, then rejected. (In practice this should be
     rare -- wallet.js now requires a UTR at submission time.
     This is a safety net for anything created before that
     validation existed.)
   - The UTR was already used on a different, already-approved
     recharge: rejected immediately, any age. Waiting cannot fix
     a UTR that has already been spent.
   - No matching BankPayment yet: left pending. Checked again
     next tick. Only once the review window passes does it get
     flagged for manual review (still left as 'pending' -- it
     already shows up in the existing admin queue) rather than
     rejected outright, since the SMS may simply be delayed
     rather than missing.
   - A matching BankPayment exists: matchBankPayment() decides.
     APPROVE credits the player immediately. REJECTED (wrong
     amount, or the UTR turns out to already be used) rejects
     immediately, any age -- these are not timing issues. MANUAL
     (autoVerify off, or over the auto-approve ceiling) flags the
     BankPayment for the admin queue and waits for a human.

   A NOTE ON QUERY VOLUME
   -----------------------
   Every tick now does real work for every pending recharge, and
   matchBankPayment() itself queries recent approved recharges
   and the full pending list. At the volumes this system was
   built for (a handful of pending recharges at once) that is
   nothing. If pending recharges ever number in the hundreds at
   once, this deserves a second look -- but that is a real scale
   problem to solve then, not a reason to complicate this now.
   ============================================================ */

const REVIEW_WINDOW_MS = 300000; // 5 minutes

async function sweepPendingRecharges() {

  const cutoff =
    new Date(
      Date.now() -
      REVIEW_WINDOW_MS
    );

  const pendingRecharges =
    await Transaction.find({
      type:
        'recharge',
      status:
        'pending'
    })
      .sort({
        createdAt: 1
      })
      .limit(100);

  let approved = 0;
  let rejected = 0;
  let manual = 0;
  let awaitingManual = 0;
  let skipped = 0;

  for (
    const transaction
    of pendingRecharges
  ) {

    const isPastReviewWindow =
      transaction.createdAt < cutoff;

    const playerUtr =
      extractUtr(
        transaction.rechargeNote
      );

    /* No UTR at all -- safety net; wallet.js should prevent this
       at submission time now. Give it the review window before
       giving up, in case this is a race on a very fresh row. */

    if (!playerUtr) {

      if (isPastReviewWindow) {

        const rejectedTx =
          await rejectRecharge(
            transaction,
            'No valid UTR / payment reference was submitted with this request. Please submit a new recharge request with the correct UTR.'
          );

        if (rejectedTx) {
          rejected++;
        } else {
          skipped++;
        }
      }

      continue;
    }

    /* This UTR was already used on a different, already-approved
       recharge. Not a timing problem -- reject immediately,
       regardless of age. This also catches a resubmission of a
       UTR whose BankPayment row was already deleted by a prior
       approval (approveRecharge deletes it on success), which is
       exactly the case the lookup below can no longer see. */

    const successfulRecharge =
      await findSuccessfulRechargeByUtr(
        playerUtr
      );

    if (successfulRecharge) {

      const rejectedTx =
        await rejectRecharge(
          transaction,
          'This UTR has already been used for another successful recharge. Please submit a new recharge request with a valid UTR.'
        );

      if (rejectedTx) {
        rejected++;
      } else {
        skipped++;
      }

      continue;
    }

    /* Find a live bank payment -- ignored rows must not count */

    const bankPayment =
      await BankPayment.findOne({
        utr:
          playerUtr,
        direction:
          'credit',
        status: {
          $ne: 'ignored'
        }
      });

    if (!bankPayment) {

      if (isPastReviewWindow) {
        awaitingManual++;
      }

      // Not past the window yet: leave pending, try again next
      // tick. If the SMS lands after the window has passed, this
      // stays 'pending' -- /sms will still find and match it.

      continue;
    }

    /* A bank payment exists. matchBankPayment is the single
       source of truth for what happens next -- same function
       /sms and /match both call. */

    let matchResult;

    try {

      matchResult =
        await matchBankPayment({
          amount:
            bankPayment.amount,
          utr:
            bankPayment.utr,
          bankPaymentId:
            bankPayment._id
        });

    } catch (err) {

      console.error(
        'Sweep match failed for transaction',
        transaction._id,
        err.message
      );

      skipped++;
      continue;
    }

    const decision =
      matchResult?.payload?.decision;

    if (decision === 'APPROVE') {
      approved++;

    } else if (decision === 'REJECTED') {
      rejected++;

    } else if (
      decision === 'MANUAL' ||
      decision === 'ALREADY_PROCESSED'
    ) {

      // Flag the bank payment for the admin queue, but only
      // write once -- this branch can be reached again on every
      // future tick until an admin acts, and there is no reason
      // to keep rewriting the same status.

      if (bankPayment.status !== 'manual') {

        await BankPayment.findOneAndUpdate(
          {
            _id:
              bankPayment._id
          },
          {
            $set: {
              status:
                'manual',
              matchedTransaction:
                transaction._id,
              matchedAt:
                new Date()
            }
          }
        );
      }

      manual++;

    } else {

      // WAITING / NO_MATCH: a bank payment exists but
      // matchBankPayment could not tie it to this transaction --
      // most likely a duplicate-UTR edge case where a different
      // pending recharge claimed the match first. Leave as-is;
      // retried next tick.

      skipped++;
    }
  }

  return {
    success: true,
    checked:
      pendingRecharges.length,
    approved,
    rejected,
    manual,
    awaitingManual,
    skipped
  };
}

router.post(
  '/expire-pending-recharges',
  automationSecret,
  async (req, res) => {
    try {

      const result =
        await sweepPendingRecharges();

      return res.json(result);

    } catch (err) {

      console.error(
        'Recharge sweep error:',
        err
      );

      return res.status(500).json({
        message:
          'Server error'
      });
    }
  }
);


/* ============================================================
   EXPORTS

   The router is the default export so
   app.use('/api/payment-automation', require(...)) keeps
   working unchanged.

   sweepPendingRecharges and matchBankPayment are attached to
   it so the scheduler and the /sms route can call them
   directly, with no HTTP hop and no secret header to
   misconfigure.
   ============================================================ */

module.exports = router;
module.exports.sweepPendingRecharges = sweepPendingRecharges;
module.exports.matchBankPayment = matchBankPayment;
