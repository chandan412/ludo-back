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
 * Existing recharge system stores the player's submitted
 * payment reference in Transaction.rechargeNote.
 *
 * We intentionally do NOT add a UTR field to Transaction.js.
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

  // If paymentNote is simply the UTR
  if (/^[A-Z0-9]{6,30}$/i.test(text)) {
    return normalizeUtr(text);
  }

  // Fallback: find a long numeric reference inside the note.
  const numeric = text.match(/\b\d{8,30}\b/);

  if (numeric) {
    return normalizeUtr(numeric[0]);
  }

  return '';
}

// ============================================================
// REJECTION HELPER
// ============================================================

/*
 * Rejects an existing pending recharge and stores the reason
 * in the existing adminRemark field.
 *
 * IMPORTANT:
 * rechargeNote is NEVER overwritten.
 * The player's original UTR/payment reference remains intact.
 *
 * remarkAck=false makes the notice appear on the player's wallet.
 */
async function rejectRecharge(transaction, reason) {
  if (!transaction) return null;

  const rejected = await Transaction.findOneAndUpdate(
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

  return rejected;
}

// ============================================================
// FIND APPROVED RECHARGE USING UTR
// ============================================================

/*
 * IMPORTANT:
 *
 * We determine whether a UTR has already been successfully
 * consumed by looking at APPROVED recharge transactions.
 *
 * A rejected recharge does NOT consume the UTR.
 *
 * This is what allows:
 *
 *   First request:
 *   ₹100 + UTR 123
 *        ↓
 *   rejected because actual payment was ₹10
 *
 *   Second request:
 *   ₹10 + UTR 123
 *        ↓
 *   allowed
 *
 * But after:
 *
 *   ₹10 + UTR 123
 *        ↓
 *   approved
 *
 * nobody can use UTR 123 again.
 */
async function findSuccessfulRechargeByUtr(normalizedUtr) {
  if (!normalizedUtr) return null;

  const approvedTransactions =
    await Transaction.find({
      type: 'recharge',
      status: 'approved'
    })
      .sort({ processedAt: -1, createdAt: -1 })
      .limit(100);

  for (const tx of approvedTransactions) {
    const txUtr = extractUtr(tx.rechargeNote);

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
// Accepts BOTH:
//   POST /bank-sms
//   POST /sms
//
// Existing UTRs are NOT automatically rejected here.
//
// If a UTR already exists in BankPayment, we return the existing
// BankPayment ID so /match can determine whether the UTR was
// actually consumed by a successful recharge.
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
      const normalizedUtr = normalizeUtr(utr);

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

      if (normalizedDirection === 'debit') {
        try {
          await BankPayment.create({
            amount: parsedAmount,
            utr: normalizedUtr,
            bankAccount: bankAccount || '',
            direction: 'debit',
            smsText: smsText || '',
            smsAt: smsAt
              ? new Date(smsAt)
              : new Date(),
            status: 'ignored'
          });
        } catch (err) {
          // Duplicate debit UTR is harmless.
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

      if (normalizedDirection !== 'credit') {
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
            bankAccount: bankAccount || '',
            direction: 'credit',
            smsText: smsText || '',
            smsAt: smsAt
              ? new Date(smsAt)
              : new Date(),
            status: 'pending'
          });
      } catch (err) {
        // ======================================================
        // DUPLICATE UTR
        //
        // DO NOT reject here.
        //
        // The UTR may belong to a previously rejected recharge.
        // /match will decide whether it has already been
        // successfully consumed.
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
              existing?.amount ?? parsedAmount,
            utr: normalizedUtr
          });
        }

        throw err;
      }

      return res.status(201).json({
        accepted: true,
        duplicate: false,
        bankPaymentId: bankPayment._id,
        amount: bankPayment.amount,
        utr: bankPayment.utr
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
          .sort({ createdAt: 1 })
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
// n8n — MATCH BANK PAYMENT TO EXISTING RECHARGE
//
// IMPORTANT:
// THIS DOES NOT CREDIT BALANCE.
//
// It only returns:
//   APPROVE
//   MANUAL
//   NO_MATCH
//   REJECTED
//
// Actual balance credit remains your existing admin
// /api/admin/add-balance endpoint.
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

      const parsedAmount = Number(amount);
      const normalizedUtr = normalizeUtr(utr);

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

      /*
       * If n8n didn't provide a bankPaymentId,
       * find the BankPayment using UTR.
       */
      if (!bankPayment) {
        bankPayment =
          await BankPayment.findOne({
            utr: normalizedUtr,
            direction: 'credit'
          });
      }

      /*
       * We cannot safely continue without the actual bank
       * payment record because its SMS timestamp is needed
       * for the 3-minute rule.
       */
      if (!bankPayment) {
        return res.json({
          matched: false,
          decision: 'NO_MATCH',
          reason: 'bank_payment_not_found',
          amount: parsedAmount,
          utr: normalizedUtr
        });
      }

      // ========================================================
      // BANK PAYMENT AMOUNT / UTR ARE AUTHORITATIVE
      // ========================================================

      const bankAmount =
        Number(bankPayment.amount);

      const bankUtr =
        normalizeUtr(bankPayment.utr);

      /*
       * Never allow n8n's supplied amount/UTR to disagree with
       * the actual BankPayment record.
       */
      if (
        bankUtr !== normalizedUtr
      ) {
        return res.status(400).json({
          message:
            'Bank payment UTR does not match request UTR'
        });
      }

      // ========================================================
      // CHECK WHETHER THIS UTR WAS ALREADY SUCCESSFULLY USED
      // ========================================================

      const successfulRecharge =
        await findSuccessfulRechargeByUtr(
          normalizedUtr
        );

      if (successfulRecharge) {
        /*
         * IMPORTANT:
         *
         * The UTR has already been used successfully.
         *
         * Find a CURRENT pending request using this same UTR
         * and reject that request.
         *
         * This does NOT affect the already-approved recharge.
         */

        const duplicatePending =
          await Transaction.findOne({
            type: 'recharge',
            status: 'pending'
          })
            .sort({ createdAt: 1 });

        let rejectedDuplicate = null;

        /*
         * Only reject a pending request if its submitted UTR
         * actually equals the already-consumed UTR.
         *
         * This prevents rejecting an unrelated player's request.
         */
        if (duplicatePending) {
          const pendingUtr =
            extractUtr(
              duplicatePending.rechargeNote
            );

          if (
            pendingUtr === normalizedUtr
          ) {
            rejectedDuplicate =
              await rejectRecharge(
                duplicatePending,
                'This UTR has already been used for another successful recharge. Please submit a new recharge request with a valid UTR.'
              );
          }
        }

        return res.json({
          matched: false,
          decision: 'REJECTED',
          reason: 'utr_already_used',
          transactionId:
            rejectedDuplicate?._id ||
            duplicatePending?._id ||
            null,
          amount: parsedAmount,
          utr: normalizedUtr,
          previousTransactionId:
            successfulRecharge._id
        });
      }

      // ========================================================
      // FIND CURRENT PENDING RECHARGE WITH EXACT UTR
      //
      // We search by UTR FIRST, regardless of amount.
      //
      // This is critical.
      //
      // Example:
      //
      // Bank: ₹10 + UTR ABC
      //
      // Old request:
      // ₹100 + UTR ABC
      //
      // Old request gets rejected.
      //
      // New request:
      // ₹10 + UTR ABC
      //
      // The same UTR must be reusable because it was never
      // successfully consumed.
      // ========================================================

      const pendingWithSameUtr =
        await Transaction.find({
          type: 'recharge',
          status: 'pending'
        })
          .sort({ createdAt: 1 })
          .limit(50);

      let exactUtrTransaction = null;

      for (
        const tx of pendingWithSameUtr
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
      // SAME UTR FOUND — CHECK AMOUNT
      // ========================================================

      if (exactUtrTransaction) {
        if (
          Number(exactUtrTransaction.amount) !==
          bankAmount
        ) {
          /*
           * Correct UTR but wrong amount.
           *
           * Reject the CURRENT player request.
           *
           * IMPORTANT:
           * We do NOT consume/reject BankPayment.
           *
           * The player can submit a new request with the
           * correct amount and the same UTR.
           */

          const rejected =
            await rejectRecharge(
              exactUtrTransaction,
              `Wrong payment amount. Your UTR belongs to a ₹${bankAmount} payment, but your recharge request was for ₹${exactUtrTransaction.amount}. Please submit a new recharge request with the correct amount.`
            );

          return res.json({
            matched: false,
            decision: 'REJECTED',
            reason: 'amount_mismatch',
            transactionId:
              rejected?._id ||
              exactUtrTransaction._id,
            userId:
              exactUtrTransaction.user,
            requestedAmount:
              exactUtrTransaction.amount,
            actualPaymentAmount:
              bankAmount,
            utr: normalizedUtr
          });
        }

        /*
         * SAME UTR + SAME AMOUNT
         *
         * This is the normal successful match.
         */

        // ======================================================
        // SETTINGS
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
                $in: ['pending', 'matched']
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
            utr: normalizedUtr
          });
        }

        // ======================================================
        // AUTO VERIFICATION OFF
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
            utr: normalizedUtr
          });
        }

        // ======================================================
        // ABOVE CONFIGURED LIMIT
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
            utr: normalizedUtr,
            maxAutoAmount:
              settings.maxAutoAmount
          });
        }

        // ======================================================
        // MATCH + AUTO ENABLED + UNDER LIMIT
        //
        // DO NOT CREDIT BALANCE HERE.
        // ======================================================

        await BankPayment.findOneAndUpdate(
          {
            _id: bankPayment._id,
            status: {
              $in: ['pending', 'matched']
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
          utr: normalizedUtr
        });
      }

      // ========================================================
      // NO EXACT UTR
      //
      // Now check whether there is a pending recharge with
      // the SAME AMOUNT but a DIFFERENT UTR.
      //
      // If exactly ONE exists, we can safely identify it as the
      // likely wrong-UTR request and reject it.
      //
      // If multiple players have the same amount pending,
      // DO NOT guess which player is wrong.
      // Leave them for admin/manual review.
      // ========================================================

      const sameAmountCandidates =
        await Transaction.find({
          type: 'recharge',
          status: 'pending',
          amount: bankAmount
        })
          .sort({ createdAt: 1 })
          .limit(50);

      if (
        sameAmountCandidates.length === 1
      ) {
        const candidate =
          sameAmountCandidates[0];

        const candidateUtr =
          extractUtr(
            candidate.rechargeNote
          );

        /*
         * Only reject when the candidate actually has a UTR
         * and it differs from the bank UTR.
         */
        if (
          candidateUtr &&
          candidateUtr !== normalizedUtr
        ) {
          const rejected =
            await rejectRecharge(
              candidate,
              'The UTR submitted with your recharge request does not match the payment received. Please submit a new recharge request with the correct UTR.'
            );

          return res.json({
            matched: false,
            decision: 'REJECTED',
            reason: 'utr_mismatch',
            transactionId:
              rejected?._id ||
              candidate._id,
            userId:
              candidate.user,
            amount:
              candidate.amount,
            submittedUtr:
              candidateUtr,
            receivedUtr:
              normalizedUtr
          });
        }
      }

      // ========================================================
      // NO SAFE MATCH
      // ========================================================

      return res.json({
        matched: false,
        decision: 'NO_MATCH',
        reason:
          sameAmountCandidates.length > 1
            ? 'multiple_same_amount_pending_requests'
            : 'no_matching_pending_recharge',
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
// EXPIRE OLD UNMATCHED BANK RECORDS
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
