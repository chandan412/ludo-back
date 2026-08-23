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
   expirePendingRecharges().

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
   PLAYER RECHARGE EXPIRY — 3 MINUTES

   The 3-minute clock starts at:

   Transaction.createdAt

   It does NOT start at:

   BankPayment.smsAt

   SMS can therefore arrive before the player request.

   After 3 minutes:
   - no bank payment                -> REJECT
   - bank payment + wrong amount    -> REJECT
   - bank payment + same amount     -> APPROVE (if autoVerify
                                       is on and the amount is
                                       within maxAutoAmount),
                                       otherwise MANUAL

   WHY APPROVAL HAPPENS HERE TOO
   -----------------------------
   /match runs exactly once, at the moment the bank SMS lands.
   When the SMS arrives BEFORE the player has submitted their
   request, /match finds no pending recharge and returns
   WAITING — and nothing ever calls it again.

   Without an approval path in this sweep, every
   SMS-before-request payment would sit waiting for a human
   even with autoVerify switched on. This closes that gap.

   The logic is written as a plain function so it can be
   called directly by the in-process scheduler as well as over
   HTTP. See jobs/paymentScheduler.js.
   ============================================================ */

async function expirePendingRecharges() {

  // 3 minutes. The player has this long for their bank SMS to
  // arrive and match before the request is rejected.
  const cutoff =
    new Date(
      Date.now() -
      180000
    );

  const pendingRecharges =
    await Transaction.find({
      type:
        'recharge',
      status:
        'pending',
      createdAt: {
        $lt:
          cutoff
      }
    })
      .sort({
        createdAt: 1
      })
      .limit(100);

  let approved = 0;
  let rejected = 0;
  let manual = 0;
  let skipped = 0;

  for (
    const transaction
    of pendingRecharges
  ) {

    const playerUtr =
      extractUtr(
        transaction.rechargeNote
      );

    /* No player UTR */

    if (!playerUtr) {

      const rejectedTx =
        await rejectRecharge(
          transaction,
          'We could not verify your payment within 3 minutes because no valid UTR/payment reference was submitted. Please submit a new recharge request with the correct UTR.'
        );

      if (rejectedTx) {
        rejected++;
      } else {
        skipped++;
      }

      continue;
    }

    /* Already successfully used UTR */

    const successfulRecharge =
      await findSuccessfulRechargeByUtr(
        playerUtr
      );

    if (
      successfulRecharge
    ) {

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

    /* Find bank payment — ignored rows must not count */

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

    /* No bank payment */

    if (!bankPayment) {

      const rejectedTx =
        await rejectRecharge(
          transaction,
          'We could not verify your payment within 3 minutes. Please submit a new recharge request with the correct UTR.'
        );

      if (rejectedTx) {
        rejected++;
      } else {
        skipped++;
      }

      continue;
    }

    /* Bank payment found — amount check */

    const bankAmount =
      Number(
        bankPayment.amount
      );

    if (
      bankAmount !==
      Number(
        transaction.amount
      )
    ) {

      const rejectedTx =
        await rejectRecharge(
          transaction,
          `Wrong payment amount. Your UTR belongs to a ₹${bankAmount} payment, but your recharge request was for ₹${transaction.amount}. Please submit a new recharge request with the correct amount.`
        );

      if (rejectedTx) {
        rejected++;
      } else {
        skipped++;
      }

      continue;
    }

    /* ========================================================
       SAME UTR + SAME AMOUNT

       This is a verified payment. Credit it if automatic
       verification is enabled and the amount is within the
       configured ceiling; otherwise hand it to an admin.
       ======================================================== */

    const settings =
      await getSettings();

    if (
      settings.autoVerify &&
      bankAmount <= settings.maxAutoAmount
    ) {

      try {

        const approval =
          await approveRecharge(
            transaction,
            bankPayment
          );

        if (approval.ok) {
          approved++;
          continue;
        }

        if (approval.alreadyProcessed) {
          skipped++;
          continue;
        }

      } catch (err) {

        // Approval failing must not stop the sweep. Fall
        // through to MANUAL so an admin sees it rather than
        // the payment silently vanishing.
        console.error(
          'Auto-approve at expiry failed:',
          err.message
        );
      }
    }

    /* Not auto-approved — flag for manual review */

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

    manual++;
  }

  return {
    success: true,
    checked:
      pendingRecharges.length,
    approved,
    rejected,
    manual,
    skipped
  };
}

router.post(
  '/expire-pending-recharges',
  automationSecret,
  async (req, res) => {
    try {

      const result =
        await expirePendingRecharges();

      return res.json(result);

    } catch (err) {

      console.error(
        'Expire pending recharge error:',
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
   BANK PAYMENT CLEANUP

   This is separate from the player's 3-minute window and must
   always be LONGER than it.
   ============================================================ */

async function expireBankPayments() {

  // 5 minutes. MUST stay longer than the recharge window above.
  // If the two matched, a recharge reaching its expiry check at
  // the same moment its bank payment was marked expired would be
  // a race: the player could be rejected despite having paid.
  const cutoff =
    new Date(
      Date.now() -
      300000
    );

  const result =
    await BankPayment.updateMany(
      {
        direction:
          'credit',
        status:
          'pending',
        createdAt: {
          $lt:
            cutoff
        }
      },
      {
        $set: {
          status:
            'expired'
        }
      }
    );

  return {
    expired:
      result.modifiedCount ||
      0
  };
}

router.post(
  '/expire-bank-payments',
  automationSecret,
  async (req, res) => {
    try {

      const result =
        await expireBankPayments();

      return res.json(result);

    } catch (err) {

      console.error(
        'Expire bank payments error:',
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

   The two sweep functions are attached to it so the in-process
   scheduler can call them directly, with no HTTP hop and no
   secret header to misconfigure.
   ============================================================ */

module.exports = router;
module.exports.expirePendingRecharges = expirePendingRecharges;
module.exports.expireBankPayments = expireBankPayments;
module.exports.matchBankPayment = matchBankPayment;
