const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

const Transaction = require('../models/Transaction');
const BankPayment = require('../models/BankPayment');
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

// ============================================================
// n8n authentication
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
// Helpers
// ============================================================

function normalizeUtr(value) {
  if (!value) return '';

  return String(value)
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

/*
 * Your existing recharge system stores the player's
 * submitted payment reference in Transaction.rechargeNote.
 *
 * We do NOT add a UTR field to Transaction.js.
 */
function extractUtr(note) {
  if (!note) return '';

  const text = String(note).trim();

  // UTR: 123456789012
  // UTR 123456789012
  // Ref: 123456789012
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
// ============================================================

router.post(
  '/bank-sms',
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

      // IMPORTANT:
      // Debit always wins.
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
          if (err?.code !== 11000) {
            throw err;
          }
        }

        return res.json({
          accepted: false,
          reason: 'debit_sms_ignored'
        });
      }

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
        if (err?.code === 11000) {
          const existing =
            await BankPayment.findOne({
              utr: normalizedUtr
            });

          return res.json({
            accepted: true,
            duplicate: true,
            bankPaymentId:
              existing?._id || null
          });
        }

        throw err;
      }

      res.status(201).json({
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
// THIS DOES NOT CREDIT BALANCE.
//
// It only returns:
// APPROVE
// MANUAL
// NO_MATCH
//
// The actual credit remains your existing admin
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

      // --------------------------------------------------------
      // Settings
      // --------------------------------------------------------

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

      // --------------------------------------------------------
      // Find existing pending recharge
      // --------------------------------------------------------

      const candidates =
        await Transaction.find({
          type: 'recharge',
          status: 'pending',
          amount: parsedAmount
        })
          .sort({ createdAt: 1 })
          .limit(50);

      let matchedTransaction = null;

      for (const tx of candidates) {
        const txUtr =
          extractUtr(tx.rechargeNote);

        if (
          txUtr &&
          txUtr === normalizedUtr
        ) {
          matchedTransaction = tx;
          break;
        }
      }

      // --------------------------------------------------------
      // No recharge yet.
      //
      // This is allowed because bank SMS can arrive before
      // the player submits the recharge request.
      // --------------------------------------------------------

      if (!matchedTransaction) {
        return res.json({
          matched: false,
          decision: 'NO_MATCH'
        });
      }

      // --------------------------------------------------------
      // Determine bank timestamp
      // --------------------------------------------------------

      let bankTime = new Date();

      if (bankPaymentId) {
        const bankPayment =
          await BankPayment.findById(
            bankPaymentId
          );

        if (bankPayment) {
          bankTime =
            bankPayment.smsAt ||
            bankPayment.createdAt;
        }
      }

      // --------------------------------------------------------
      // Three-minute window
      // --------------------------------------------------------

      const differenceMs =
        Math.abs(
          bankTime.getTime() -
          matchedTransaction.createdAt.getTime()
        );

      const withinThreeMinutes =
        differenceMs <= 180000;

      if (!withinThreeMinutes) {
        await BankPayment.findOneAndUpdate(
          {
            _id: bankPaymentId,
            status: 'pending'
          },
          {
            $set: {
              status: 'manual',
              matchedTransaction:
                matchedTransaction._id,
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
            matchedTransaction._id,
          userId:
            matchedTransaction.user,
          amount:
            matchedTransaction.amount,
          utr: normalizedUtr
        });
      }

      // --------------------------------------------------------
      // Auto verification OFF
      // --------------------------------------------------------

      if (!settings.autoVerify) {
        return res.json({
          matched: true,
          decision: 'MANUAL',
          reason: 'auto_verify_disabled',
          transactionId:
            matchedTransaction._id,
          userId:
            matchedTransaction.user,
          amount:
            matchedTransaction.amount,
          utr: normalizedUtr
        });
      }

      // --------------------------------------------------------
      // Above configured limit
      // --------------------------------------------------------

      if (
        parsedAmount >
        settings.maxAutoAmount
      ) {
        return res.json({
          matched: true,
          decision: 'MANUAL',
          reason: 'amount_exceeds_limit',
          transactionId:
            matchedTransaction._id,
          userId:
            matchedTransaction.user,
          amount:
            matchedTransaction.amount,
          utr: normalizedUtr,
          maxAutoAmount:
            settings.maxAutoAmount
        });
      }

      // --------------------------------------------------------
      // MATCH + AUTO ENABLED + UNDER LIMIT
      //
      // DO NOT CREDIT BALANCE HERE.
      // --------------------------------------------------------

      await BankPayment.findOneAndUpdate(
        {
          _id: bankPaymentId,
          status: 'pending'
        },
        {
          $set: {
            status: 'matched',
            matchedTransaction:
              matchedTransaction._id,
            matchedAt: new Date()
          }
        }
      );

      return res.json({
        matched: true,
        decision: 'APPROVE',
        transactionId:
          matchedTransaction._id,
        userId:
          matchedTransaction.user,
        amount:
          matchedTransaction.amount,
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
// Expire old unmatched bank records
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
