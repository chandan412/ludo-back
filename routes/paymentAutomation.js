const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

const Transaction = require('../models/Transaction');
const BankPayment = require('../models/BankPayment');
const { adminAuth } = require('../middleware/auth');

// ============================================================
// PAYMENT AUTOMATION SETTINGS
// ============================================================

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

// ============================================================
// n8n AUTHENTICATION
// ============================================================

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

// ============================================================
// HELPERS
// ============================================================

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

// ============================================================
// REJECT PLAYER RECHARGE
// ============================================================

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

// ============================================================
// FIND SUCCESSFULLY USED UTR
//
// Only an APPROVED recharge consumes the UTR.
//
// Rejected requests do NOT consume the UTR.
// ============================================================

async function findSuccessfulRechargeByUtr(utr) {
  const normalizedUtr = normalizeUtr(utr);

  if (!normalizedUtr) {
    return null;
  }

  const approvedTransactions =
    await Transaction.find({
      type: 'recharge',
      status: 'approved'
    })
      .sort({
        processedAt: -1,
        createdAt: -1
      })
      .limit(200);

  for (const tx of approvedTransactions) {
    const txUtr =
      extractUtr(tx.rechargeNote);

    if (
      txUtr &&
      txUtr === normalizedUtr
    ) {
      return tx;
    }
  }

  return null;
}

// ============================================================
// FIND PENDING TRANSACTIONS
// ============================================================

async function findPendingRecharges() {
  return Transaction.find({
    type: 'recharge',
    status: 'pending'
  })
    .sort({
      createdAt: 1
    })
    .limit(100);
}

// ============================================================
// ADMIN PANEL — GET SETTINGS
// ============================================================

router.get(
  '/settings',
  adminAuth,
  async (req, res) => {
    try {
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

      res.json({
        autoVerify: settings.autoVerify,
        maxAutoAmount: settings.maxAutoAmount
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

// ============================================================
// ADMIN PANEL — SAVE SETTINGS
// ============================================================

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
          { key: 'default' },
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
        autoVerify: settings.autoVerify,
        maxAutoAmount: settings.maxAutoAmount
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

// ============================================================
// n8n — RECEIVE BANK SMS
//
// POST /bank-sms
// POST /sms
//
// Duplicate UTR is NOT rejected here.
//
// We reuse the existing BankPayment so that a previously
// rejected player request can submit the same UTR again.
// ============================================================

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

      const parsedAmount = Number(amount);
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
        String(direction || '').toLowerCase();

      // ========================================================
      // DEBIT
      // ========================================================

      if (
        normalizedDirection === 'debit'
      ) {
        try {
          await BankPayment.create({
            amount: parsedAmount,
            utr: normalizedUtr,
            bankAccount:
              bankAccount || '',
            direction: 'debit',
            smsText: smsText || '',
            smsAt: smsAt
              ? new Date(smsAt)
              : new Date(),
            status: 'ignored'
          });
        } catch (err) {
          if (err?.code !== 11000) {
            throw err;
          }
        }

        return res.json({
          accepted: false,
          reason: 'debit_sms_ignored'
        });
      }

      // ========================================================
      // CREDIT ONLY
      // ========================================================

      if (
        normalizedDirection !== 'credit'
      ) {
        return res.status(400).json({
          message:
            'direction must be credit or debit'
        });
      }

      let bankPayment;

      try {
        bankPayment =
          await BankPayment.create({
            amount: parsedAmount,
            utr: normalizedUtr,
            bankAccount:
              bankAccount || '',
            direction: 'credit',
            smsText: smsText || '',
            smsAt: smsAt
              ? new Date(smsAt)
              : new Date(),
            status: 'pending'
          });
      } catch (err) {
        // ======================================================
        // EXISTING UTR
        //
        // Do NOT reject.
        //
        // The same UTR may belong to a previously rejected
        // recharge and can legitimately be submitted again.
        // ======================================================

        if (err?.code === 11000) {
          const existing =
            await BankPayment.findOne({
              utr: normalizedUtr
            });

          return res.json({
            accepted: true,
            duplicate: true,
            bankPaymentId:
              existing?._id || null,
            amount:
              existing?.amount ??
              parsedAmount,
            utr: normalizedUtr
          });
        }

        throw err;
      }

      return res.status(201).json({
        accepted: true,
        duplicate: false,
        bankPaymentId:
          bankPayment._id,
        amount:
          bankPayment.amount,
        utr:
          bankPayment.utr
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

// ============================================================
// n8n — GET UNPROCESSED CREDIT SMS
// ============================================================

router.get(
  '/pending-bank-payments',
  automationSecret,
  async (req, res) => {
    try {
      const payments =
        await BankPayment.find({
          direction: 'credit',
          status: 'pending'
        })
          .sort({
            createdAt: 1
          })
          .limit(50);

      res.json(payments);

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

// ============================================================
// n8n — MATCH BANK PAYMENT
//
// IMPORTANT:
//
// A UTR mismatch does NOT immediately reject the player.
//
// We return:
//   WAITING
//
// This gives the bank SMS time to arrive.
//
// A separate /expire-pending-recharges endpoint handles the
// final 3-minute rejection.
// ============================================================

router.post(
  '/match',
  automationSecret,
  async (req, res) => {
    try {
      const {
        amount,
        utr,
        bankPaymentId
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

      // ========================================================
      // LOAD BANK PAYMENT
      // ========================================================

      let bankPayment = null;

      if (bankPaymentId) {
        bankPayment =
          await BankPayment.findById(
            bankPaymentId
          );
      }

      if (!bankPayment) {
        bankPayment =
          await BankPayment.findOne({
            utr: normalizedUtr,
            direction: 'credit'
          });
      }

      if (!bankPayment) {
        return res.json({
          matched: false,
          decision: 'WAITING',
          reason:
            'bank_payment_not_found',
          amount: parsedAmount,
          utr: normalizedUtr
        });
      }

      const bankAmount =
        Number(bankPayment.amount);

      const bankUtr =
        normalizeUtr(bankPayment.utr);

      // ========================================================
      // SAFETY CHECK
      // ========================================================

      if (
        bankUtr !== normalizedUtr
      ) {
        return res.status(400).json({
          message:
            'Bank payment UTR does not match request UTR'
        });
      }

      // ========================================================
      // ALREADY SUCCESSFULLY USED UTR?
      // ========================================================

      const successfulRecharge =
        await findSuccessfulRechargeByUtr(
          normalizedUtr
        );

      if (successfulRecharge) {

        /*
         * Find a pending recharge whose submitted UTR is the
         * already-used UTR.
         *
         * We do NOT reject unrelated pending requests.
         */

        const pendingRecharges =
          await findPendingRecharges();

        let duplicatePending = null;

        for (
          const tx of pendingRecharges
        ) {
          const txUtr =
            extractUtr(
              tx.rechargeNote
            );

          if (
            txUtr &&
            txUtr === normalizedUtr
          ) {
            duplicatePending = tx;
            break;
          }
        }

        if (duplicatePending) {
          const rejected =
            await rejectRecharge(
              duplicatePending,
              'This UTR has already been used for another successful recharge. Please submit a new recharge request with a valid UTR.'
            );

          return res.json({
            matched: false,
            decision: 'REJECTED',
            reason:
              'utr_already_used',
            transactionId:
              rejected?._id ||
              duplicatePending._id,
            userId:
              duplicatePending.user,
            amount:
              duplicatePending.amount,
            utr:
              normalizedUtr,
            previousTransactionId:
              successfulRecharge._id
          });
        }

        return res.json({
          matched: false,
          decision: 'WAITING',
          reason:
            'utr_already_used_but_no_pending_request_for_this_utr',
          amount: bankAmount,
          utr: normalizedUtr
        });
      }

      // ========================================================
      // FIND CURRENT PENDING RECHARGE WITH SAME UTR
      // ========================================================

      const pendingRecharges =
        await findPendingRecharges();

      let exactUtrTransaction = null;

      for (
        const tx of pendingRecharges
      ) {
        const txUtr =
          extractUtr(
            tx.rechargeNote
          );

        if (
          txUtr &&
          txUtr === normalizedUtr
        ) {
          exactUtrTransaction = tx;
          break;
        }
      }

      // ========================================================
      // SAME UTR FOUND
      // ========================================================

      if (exactUtrTransaction) {

        // ======================================================
        // SAME UTR BUT WRONG AMOUNT
        //
        // Bank payment is known, so amount mismatch is certain.
        // Reject this request.
        //
        // The BankPayment remains available.
        // The player can submit a new request using the same UTR
        // and the correct amount.
        // ======================================================

        if (
          Number(
            exactUtrTransaction.amount
          ) !== bankAmount
        ) {

          const rejected =
            await rejectRecharge(
              exactUtrTransaction,
              `Wrong payment amount. Your UTR belongs to a ₹${bankAmount} payment, but your recharge request was for ₹${exactUtrTransaction.amount}. Please submit a new recharge request with the correct amount.`
            );

          return res.json({
            matched: false,
            decision: 'REJECTED',
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
              bankAmount,
            utr:
              normalizedUtr
          });
        }

        // ======================================================
        // SAME UTR + SAME AMOUNT
        // ======================================================

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

        // ======================================================
        // THREE-MINUTE WINDOW
        //
        // If SMS arrived late but the player's recharge is
        // still inside the 3-minute window, continue.
        //
        // If it is already outside the window, MANUAL.
        // ======================================================

        const bankTime =
          bankPayment.smsAt ||
          bankPayment.createdAt;

        const differenceMs =
          Math.abs(
            bankTime.getTime() -
            exactUtrTransaction.createdAt.getTime()
          );

        const withinThreeMinutes =
          differenceMs <= 180000;

        if (!withinThreeMinutes) {

          await BankPayment.findOneAndUpdate(
            {
              _id: bankPayment._id,
              status: {
                $in: [
                  'pending',
                  'matched'
                ]
              }
            },
            {
              $set: {
                status: 'manual',
                matchedTransaction:
                  exactUtrTransaction._id,
                matchedAt: new Date()
              }
            }
          );

          return res.json({
            matched: true,
            decision: 'MANUAL',
            reason:
              'outside_three_minute_window',
            transactionId:
              exactUtrTransaction._id,
            userId:
              exactUtrTransaction.user,
            amount:
              exactUtrTransaction.amount,
            utr:
              normalizedUtr
          });
        }

        // ======================================================
        // AUTO VERIFY OFF
        // ======================================================

        if (!settings.autoVerify) {
          return res.json({
            matched: true,
            decision: 'MANUAL',
            reason:
              'auto_verify_disabled',
            transactionId:
              exactUtrTransaction._id,
            userId:
              exactUtrTransaction.user,
            amount:
              exactUtrTransaction.amount,
            utr:
              normalizedUtr
          });
        }

        // ======================================================
        // AMOUNT ABOVE LIMIT
        // ======================================================

        if (
          bankAmount >
          settings.maxAutoAmount
        ) {
          return res.json({
            matched: true,
            decision: 'MANUAL',
            reason:
              'amount_exceeds_limit',
            transactionId:
              exactUtrTransaction._id,
            userId:
              exactUtrTransaction.user,
            amount:
              exactUtrTransaction.amount,
            utr:
              normalizedUtr,
            maxAutoAmount:
              settings.maxAutoAmount
          });
        }

        // ======================================================
        // READY FOR EXISTING APPROVAL LOGIC
        // ======================================================

        await BankPayment.findOneAndUpdate(
          {
            _id: bankPayment._id,
            status: {
              $in: [
                'pending',
                'matched'
              ]
            }
          },
          {
            $set: {
              status: 'matched',
              matchedTransaction:
                exactUtrTransaction._id,
              matchedAt: new Date()
            }
          }
        );

        return res.json({
          matched: true,
          decision: 'APPROVE',
          transactionId:
            exactUtrTransaction._id,
          userId:
            exactUtrTransaction.user,
          amount:
            exactUtrTransaction.amount,
          utr:
            normalizedUtr
        });
      }

      // ========================================================
      // NO EXACT UTR
      //
      // IMPORTANT:
      //
      // DO NOT REJECT.
      //
      // The bank SMS may have arrived before the correct SMS,
      // or the player may have submitted a request shortly
      // before the bank notification arrives.
      //
      // Keep the recharge pending until the 3-minute expiry
      // check.
      // ========================================================

      return res.json({
        matched: false,
        decision: 'WAITING',
        reason:
          'utr_mismatch_or_pending_bank_sms',
        amount: bankAmount,
        utr: normalizedUtr
      });

    } catch (err) {
      console.error(
        'Payment matching error:',
        err
      );

      res.status(500).json({
        message: 'Server error'
      });
    }
  }
);

// ============================================================
// n8n — FINAL 3-MINUTE RECHARGE CHECK
//
// This endpoint should be called by n8n periodically.
//
// It rejects only pending recharge requests older than
// 3 minutes for which no successfully matching bank payment
// has been found.
//
// This gives delayed bank SMS enough time to arrive.
// ============================================================

router.post(
  '/expire-pending-recharges',
  automationSecret,
  async (req, res) => {
    try {
      const cutoff =
        new Date(
          Date.now() - 180000
        );

      const pendingRecharges =
        await Transaction.find({
          type: 'recharge',
          status: 'pending',
          createdAt: {
            $lt: cutoff
          }
        })
          .sort({
            createdAt: 1
          })
          .limit(100);

      let rejected = 0;
      let stillValid = 0;

      for (
        const transaction
        of pendingRecharges
      ) {

        const playerUtr =
          extractUtr(
            transaction.rechargeNote
          );

        // ------------------------------------------------------
        // No UTR submitted
        // ------------------------------------------------------

        if (!playerUtr) {
          const rejectedTx =
            await rejectRecharge(
              transaction,
              'We could not verify your payment within 3 minutes. No valid UTR/payment reference was found. Please submit a new recharge request with the correct UTR.'
            );

          if (rejectedTx) {
            rejected++;
          }

          continue;
        }

        // ------------------------------------------------------
        // Was this UTR already successfully used?
        // ------------------------------------------------------

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
          }

          continue;
        }

        // ------------------------------------------------------
        // Find bank payment by UTR
        // ------------------------------------------------------

        const bankPayment =
          await BankPayment.findOne({
            utr: playerUtr,
            direction: 'credit'
          });

        // ------------------------------------------------------
        // No bank payment yet
        //
        // Now the 3-minute window is over.
        // Reject the player request.
        // ------------------------------------------------------

        if (!bankPayment) {

          const rejectedTx =
            await rejectRecharge(
              transaction,
              'We could not verify your payment within 3 minutes. Please submit a new recharge request with the correct UTR.'
            );

          if (rejectedTx) {
            rejected++;
          }

          continue;
        }

        // ------------------------------------------------------
        // Bank payment exists.
        //
        // Check amount.
        // ------------------------------------------------------

        const bankAmount =
          Number(bankPayment.amount);

        if (
          bankAmount !==
          Number(transaction.amount)
        ) {

          const rejectedTx =
            await rejectRecharge(
              transaction,
              `Wrong payment amount. Your UTR belongs to a ₹${bankAmount} payment, but your recharge request was for ₹${transaction.amount}. Please submit a new recharge request with the correct amount.`
            );

          if (rejectedTx) {
            rejected++;
          }

          continue;
        }

        // ------------------------------------------------------
        // UTR + amount match.
        //
        // Even though the recharge is now older than 3 minutes,
        // don't reject silently. Send it to MANUAL because the
        // payment itself is valid.
        // ------------------------------------------------------

        await BankPayment.findOneAndUpdate(
          {
            _id: bankPayment._id
          },
          {
            $set: {
              status: 'manual',
              matchedTransaction:
                transaction._id,
              matchedAt: new Date()
            }
          }
        );

        stillValid++;
      }

      return res.json({
        success: true,
        checked:
          pendingRecharges.length,
        rejected,
        manual:
          stillValid
      });

    } catch (err) {
      console.error(
        'Expire pending recharge error:',
        err
      );

      res.status(500).json({
        message: 'Server error'
      });
    }
  }
);

// ============================================================
// EXPIRE OLD UNMATCHED BANK PAYMENTS
// ============================================================

router.post(
  '/expire-bank-payments',
  automationSecret,
  async (req, res) => {
    try {
      const cutoff =
        new Date(
          Date.now() - 180000
        );

      const result =
        await BankPayment.updateMany(
          {
            direction: 'credit',
            status: 'pending',
            createdAt: {
              $lt: cutoff
            }
          },
          {
            $set: {
              status: 'expired'
            }
          }
        );

      res.json({
        expired:
          result.modifiedCount || 0
      });

    } catch (err) {
      console.error(
        'Expire bank payments error:',
        err
      );

      res.status(500).json({
        message: 'Server error'
      });
    }
  }
);

module.exports = router;
