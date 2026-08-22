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

/*
 * Player's UTR is stored in Transaction.rechargeNote.
 */
function extractUtr(note) {
  if (!note) return '';

  const text = String(note).trim();

  // UTR: 123456789012
  // UTR 123456789012
  // Ref: 123456789012
  // Transaction ID: 123456789012
  // TXN ID: 123456789012
  const labelled = text.match(
    /(?:UTR|REF(?:ERENCE)?|TRANSACTION(?:\s*ID)?|TXN(?:\s*ID)?)\s*[:#-]?\s*([A-Z0-9]{6,30})/i
  );

  if (labelled) {
    return normalizeUtr(labelled[1]);
  }

  // Recharge note itself may simply be the UTR.
  if (/^[A-Z0-9]{6,30}$/i.test(text)) {
    return normalizeUtr(text);
  }

  // Fallback for a long numeric reference.
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
// Only an APPROVED recharge consumes a UTR.
//
// A rejected recharge does NOT consume the UTR.
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
      .limit(500);

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
// GET PAYMENT AUTOMATION SETTINGS
// ============================================================

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

// ============================================================
// FIND PENDING RECHARGES
// ============================================================

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

// ============================================================
// ADMIN PANEL — GET SETTINGS
// ============================================================

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
          settings.maxAutoAmount
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

// ============================================================
// n8n — RECEIVE BANK SMS
//
// POST /bank-sms
// POST /sms
//
// Duplicate UTR is NOT rejected here.
//
// If the UTR already exists, return the existing BankPayment.
// The /match endpoint decides whether that UTR is still usable.
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
        String(direction || '').toLowerCase();

      // ========================================================
      // DEBIT SMS
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
      // ONLY CREDIT SMS CAN BE MATCHED
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
        // DUPLICATE BANK UTR
        //
        // Do NOT reject.
        //
        // It may belong to a previously rejected recharge.
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
            utr:
              normalizedUtr
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
// n8n — MATCH BANK PAYMENT TO RECHARGE
//
// IMPORTANT:
//
// req.body.utr = BANK SMS UTR.
//
// Player's UTR comes from Transaction.rechargeNote.
//
// These are deliberately treated as two different values.
//
// UTR mismatch does NOT immediately reject.
// It returns WAITING.
//
// The final 3-minute rejection is handled by:
// POST /expire-pending-recharges
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

      const bankSmsAmount =
        Number(amount);

      const bankSmsUtr =
        normalizeUtr(utr);

      if (
        !Number.isFinite(bankSmsAmount) ||
        bankSmsAmount <= 0
      ) {
        return res.status(400).json({
          message: 'Invalid amount'
        });
      }

      if (!bankSmsUtr) {
        return res.status(400).json({
          message: 'UTR is required'
        });
      }

      // ========================================================
      // LOAD THE ACTUAL BANK PAYMENT
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
            utr: bankSmsUtr,
            direction: 'credit'
          });
      }

      if (!bankPayment) {
        return res.json({
          matched: false,
          decision: 'WAITING',
          reason:
            'bank_payment_not_found',
          amount: bankSmsAmount,
          utr: bankSmsUtr
        });
      }

      // ========================================================
      // USE BANK PAYMENT AS SOURCE OF TRUTH
      // ========================================================

      const actualBankAmount =
        Number(bankPayment.amount);

      const actualBankUtr =
        normalizeUtr(
          bankPayment.utr
        );

      if (
        actualBankUtr !==
        bankSmsUtr
      ) {
        return res.status(400).json({
          message:
            'Bank payment UTR does not match supplied bank UTR'
        });
      }

      // ========================================================
      // HAS THIS BANK UTR ALREADY BEEN SUCCESSFULLY USED?
      //
      // IMPORTANT:
      //
      // A rejected transaction does NOT count.
      // ========================================================

      const successfulRecharge =
        await findSuccessfulRechargeByUtr(
          actualBankUtr
        );

      if (successfulRecharge) {

        /*
         * Find a CURRENT pending player request using the
         * same UTR.
         *
         * Do not reject unrelated pending requests.
         */

        const pendingRecharges =
          await getPendingRecharges();

        let duplicateTransaction = null;

        for (
          const tx of pendingRecharges
        ) {
          const playerUtr =
            extractUtr(
              tx.rechargeNote
            );

          if (
            playerUtr &&
            playerUtr === actualBankUtr
          ) {
            duplicateTransaction =
              tx;
            break;
          }
        }

        if (duplicateTransaction) {

          const rejected =
            await rejectRecharge(
              duplicateTransaction,
              'This UTR has already been used for another successful recharge. Please submit a new recharge request with a valid UTR.'
            );

          return res.json({
            matched: false,
            decision: 'REJECTED',
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

        /*
         * No pending transaction using the duplicate UTR.
         * Do not touch another player's request.
         */

        return res.json({
          matched: false,
          decision: 'NO_MATCH',
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

      // ========================================================
      // FIND PENDING PLAYER REQUESTS
      // ========================================================

      const pendingRecharges =
        await getPendingRecharges();

      // ========================================================
      // EXACT UTR MATCH
      //
      // Compare BANK UTR with PLAYER UTR.
      // ========================================================

      let exactUtrTransaction = null;

      for (
        const tx of pendingRecharges
      ) {
        const playerUtr =
          extractUtr(
            tx.rechargeNote
          );

        if (
          playerUtr &&
          playerUtr === actualBankUtr
        ) {
          exactUtrTransaction =
            tx;
          break;
        }
      }

      // ========================================================
      // EXACT UTR FOUND
      // ========================================================

      if (exactUtrTransaction) {

        // ======================================================
        // SAME UTR BUT WRONG AMOUNT
        //
        // This is certain because the actual bank amount is known.
        //
        // Reject the player's request.
        //
        // The UTR remains reusable because this transaction
        // was rejected, not approved.
        // ======================================================

        if (
          Number(
            exactUtrTransaction.amount
          ) !== actualBankAmount
        ) {

          const rejected =
            await rejectRecharge(
              exactUtrTransaction,
              `Wrong payment amount. Your UTR belongs to a ₹${actualBankAmount} payment, but your recharge request was for ₹${exactUtrTransaction.amount}. Please submit a new recharge request with the correct amount.`
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
              actualBankAmount,
            utr:
              actualBankUtr
          });
        }

        // ======================================================
        // SAME UTR + SAME AMOUNT
        // ======================================================

        const settings =
          await getSettings();

        // ======================================================
        // THREE-MINUTE WINDOW
        // ======================================================

        const bankTime =
          bankPayment.smsAt ||
          bankPayment.createdAt;

        const rechargeTime =
          exactUtrTransaction.createdAt;

        const differenceMs =
          Math.abs(
            bankTime.getTime() -
            rechargeTime.getTime()
          );

        const withinThreeMinutes =
          differenceMs <= 60000;

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
                matchedAt:
                  new Date()
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
              actualBankUtr
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
              actualBankUtr
          });
        }

        // ======================================================
        // ABOVE AUTO APPROVAL LIMIT
        // ======================================================

        if (
          actualBankAmount >
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
              actualBankUtr,
            maxAutoAmount:
              settings.maxAutoAmount
          });
        }

        // ======================================================
        // MATCHED AND ELIGIBLE FOR EXISTING APPROVAL LOGIC
        //
        // DO NOT CREDIT BALANCE HERE.
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
              matchedAt:
                new Date()
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
            actualBankUtr
        });
      }

      // ========================================================
      // NO EXACT UTR MATCH
      //
      // IMPORTANT:
      //
      // DO NOT REJECT.
      //
      // The bank SMS may be delayed or the correct SMS may
      // arrive shortly.
      //
      // Keep all pending player requests untouched.
      // ========================================================

      return res.json({
        matched: false,
        decision: 'WAITING',
        reason:
          'utr_mismatch_or_pending_bank_sms',
        amount:
          actualBankAmount,
        bankUtr:
          actualBankUtr
      });

    } catch (err) {
      console.error(
        'Payment matching error:',
        err
      );

      return res.status(500).json({
        message: 'Server error'
      });
    }
  }
);

// ============================================================
// n8n — FINAL 3-MINUTE CHECK
//
// This endpoint should be called periodically by n8n.
//
// It checks pending player recharge requests that are older
// than 3 minutes.
//
// If the player's UTR has a matching bank payment:
//   - same amount → MANUAL
//   - wrong amount → REJECT
//
// If no matching bank payment exists:
//   - REJECT after 3 minutes
//
// This is the endpoint that performs the final timeout rejection.
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
      let manual = 0;
      let skipped = 0;

      for (
        const transaction
        of pendingRecharges
      ) {

        // ------------------------------------------------------
        // PLAYER UTR
        // ------------------------------------------------------

        const playerUtr =
          extractUtr(
            transaction.rechargeNote
          );

        // ------------------------------------------------------
        // NO PLAYER UTR
        // ------------------------------------------------------

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

        // ------------------------------------------------------
        // HAS PLAYER UTR ALREADY BEEN SUCCESSFULLY USED?
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
          } else {
            skipped++;
          }

          continue;
        }

        // ------------------------------------------------------
        // FIND BANK PAYMENT USING PLAYER UTR
        // ------------------------------------------------------

        const bankPayment =
          await BankPayment.findOne({
            utr: playerUtr,
            direction: 'credit'
          });

        // ------------------------------------------------------
        // NO BANK PAYMENT FOR PLAYER UTR
        //
        // Three minutes have passed.
        //
        // Now it is safe to reject because the correct payment
        // was not found within the allowed verification window.
        // ------------------------------------------------------

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

        // ------------------------------------------------------
        // BANK PAYMENT FOUND — CHECK AMOUNT
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
          } else {
            skipped++;
          }

          continue;
        }

        // ------------------------------------------------------
        // SAME UTR + SAME AMOUNT FOUND AFTER 3 MINUTES
        //
        // Payment is valid, but it is outside the automatic
        // approval window.
        //
        // Send to MANUAL rather than rejecting the payment.
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
              matchedAt:
                new Date()
            }
          }
        );

        manual++;
      }

      return res.json({
        success: true,
        checked:
          pendingRecharges.length,
        rejected,
        manual,
        skipped
      });

    } catch (err) {
      console.error(
        'Expire pending recharge error:',
        err
      );

      return res.status(500).json({
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

      return res.json({
        expired:
          result.modifiedCount || 0
      });

    } catch (err) {
      console.error(
        'Expire bank payments error:',
        err
      );

      return res.status(500).json({
        message: 'Server error'
      });
    }
  }
);

module.exports = router;
