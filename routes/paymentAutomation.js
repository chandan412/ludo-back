const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Transaction = require('../models/Transaction');
const BankPayment = require('../models/BankPayment');

// ============================================================================
// PAYMENT AUTOMATION
//
// IMPORTANT:
// This route does NOT modify User.balance.
// It does NOT modify lockedBalance.
// It does NOT modify bonusBalance.
//
// Its job is only:
//   1. Receive/store bank SMS information.
//   2. Find an existing pending recharge.
//   3. Compare amount + UTR.
//   4. Check Auto Verify ON/OFF.
//   5. Check maximum auto-approval amount.
//   6. Return the existing transaction ID so the existing admin approval
//      mechanism can be used.
//
// ============================================================================

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
  mongoose.model('PaymentAutomationSettings', settingsSchema);

// ---------------------------------------------------------------------------
// Secret authentication for n8n
// ---------------------------------------------------------------------------

function automationSecret(req, res, next) {
  const configuredSecret = process.env.PAYMENT_AUTOMATION_SECRET;

  if (!configuredSecret) {
    return res.status(503).json({
      message: 'Payment automation secret is not configured'
    });
  }

  const suppliedSecret =
    req.headers['x-payment-automation-secret'];

  if (!suppliedSecret || suppliedSecret !== configuredSecret) {
    return res.status(401).json({
      message: 'Unauthorized'
    });
  }

  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeUtr(value) {
  if (!value) return '';

  return String(value)
    .trim()
    .replace(/\s+/g, '');
}

/**
 * Your current recharge system stores the player's payment reference
 * inside Transaction.rechargeNote.
 *
 * We intentionally DO NOT add another UTR field to Transaction.js here.
 *
 * This helper extracts a likely UTR/reference from that existing field.
 */
function extractUtrFromRechargeNote(note) {
  if (!note) return '';

  const text = String(note).trim();

  // Common labels:
  // UTR: 123456789012
  // UTR 123456789012
  // Ref: 123456789012
  // Reference: 123456789012
  const labelled = text.match(
    /(?:UTR|REF(?:ERENCE)?|TRANSACTION(?:\s*ID)?|TXN(?:\s*ID)?)\s*[:#-]?\s*([A-Z0-9]{6,30})/i
  );

  if (labelled) {
    return normalizeUtr(labelled[1]);
  }

  // If the entire payment note is just the UTR/reference.
  if (/^[A-Z0-9]{6,30}$/i.test(text)) {
    return normalizeUtr(text);
  }

  return '';
}

// ---------------------------------------------------------------------------
// GET automation settings
// ---------------------------------------------------------------------------

router.get('/settings', automationSecret, async (req, res) => {
  try {
    let settings = await PaymentAutomationSettings.findOne({
      key: 'default'
    });

    if (!settings) {
      settings = await PaymentAutomationSettings.create({
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
    console.error('Payment automation settings error:', err);
    res.status(500).json({
      message: 'Server error'
    });
  }
});

// ---------------------------------------------------------------------------
// SAVE automation settings
//
// This endpoint is intended to be called by your authenticated AdminPanel.
// It is deliberately separate from the bank-SMS endpoint.
// ---------------------------------------------------------------------------

router.put('/settings', automationSecret, async (req, res) => {
  try {
    const autoVerify =
      req.body.autoVerify === true ||
      req.body.autoVerify === 'true';

    const maxAutoAmount = Number(req.body.maxAutoAmount);

    if (!Number.isFinite(maxAutoAmount) || maxAutoAmount < 0) {
      return res.status(400).json({
        message: 'maxAutoAmount must be a valid number >= 0'
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
      message: 'Payment automation settings saved',
      autoVerify: settings.autoVerify,
      maxAutoAmount: settings.maxAutoAmount
    });
  } catch (err) {
    console.error('Save payment automation settings error:', err);
    res.status(500).json({
      message: 'Server error'
    });
  }
});

// ---------------------------------------------------------------------------
// RECEIVE BANK SMS
//
// Called by n8n.
//
// Expected body:
// {
//   amount: 500,
//   utr: "392186998096",
//   bankAccount: "XX794",
//   direction: "credit",
//   smsText: "...",
//   smsAt: "2026-08-21T..."
//
// IMPORTANT:
// DEBIT ALWAYS WINS.
// Even if the SMS contains the word "credited" somewhere else,
// direction=debit will never be treated as received money.
// ---------------------------------------------------------------------------

router.post('/bank-sms', automationSecret, async (req, res) => {
  try {
    const {
      amount,
      utr,
      bankAccount,
      direction,
      smsText,
      smsAt
    } = req.body;

    const normalizedUtr = normalizeUtr(utr);
    const parsedAmount = Number(amount);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
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

    // Debit must always win.
    if (normalizedDirection === 'debit') {
      const existing = await BankPayment.findOne({
        utr: normalizedUtr
      });

      if (existing) {
        return res.json({
          accepted: false,
          reason: 'duplicate_utr'
        });
      }

      await BankPayment.create({
        amount: parsedAmount,
        utr: normalizedUtr,
        bankAccount: bankAccount || '',
        direction: 'debit',
        smsText: smsText || '',
        smsAt: smsAt ? new Date(smsAt) : new Date(),
        status: 'ignored'
      });

      return res.json({
        accepted: false,
        reason: 'debit_sms_ignored'
      });
    }

    if (normalizedDirection !== 'credit') {
      return res.status(400).json({
        message: 'direction must be credit or debit'
      });
    }

    // Unique UTR in BankPayment gives us first-arrival protection.
    let bankPayment;

    try {
      bankPayment = await BankPayment.create({
        amount: parsedAmount,
        utr: normalizedUtr,
        bankAccount: bankAccount || '',
        direction: 'credit',
        smsText: smsText || '',
        smsAt: smsAt ? new Date(smsAt) : new Date(),
        status: 'pending'
      });
    } catch (err) {
      if (err && err.code === 11000) {
        const existing = await BankPayment.findOne({
          utr: normalizedUtr
        });

        return res.json({
          accepted: true,
          duplicate: true,
          reason: 'utr_already_received',
          bankPaymentId: existing?._id || null
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
    console.error('Bank SMS processing error:', err);

    res.status(500).json({
      message: 'Server error'
    });
  }
});

// ---------------------------------------------------------------------------
// MATCH BANK PAYMENT AGAINST EXISTING RECHARGE
//
// This endpoint does NOT credit money.
//
// It searches the EXISTING Transaction collection for a pending recharge.
//
// Your current recharge system stores the submitted UTR/reference in
// Transaction.rechargeNote, so we compare against that existing value.
//
// ---------------------------------------------------------------------------

router.post('/match', automationSecret, async (req, res) => {
  try {
    const {
      amount,
      utr,
      bankPaymentId
    } = req.body;

    const parsedAmount = Number(amount);
    const normalizedUtr = normalizeUtr(utr);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        message: 'Invalid amount'
      });
    }

    if (!normalizedUtr) {
      return res.status(400).json({
        message: 'UTR is required'
      });
    }

    // -----------------------------------------------------------------------
    // Load automation settings
    // -----------------------------------------------------------------------

    let settings = await PaymentAutomationSettings.findOne({
      key: 'default'
    });

    if (!settings) {
      settings = await PaymentAutomationSettings.create({
        key: 'default',
        autoVerify: false,
        maxAutoAmount: 5000
      });
    }

    // -----------------------------------------------------------------------
    // Find pending recharge by amount first.
    //
    // We deliberately use the existing Transaction collection.
    // -----------------------------------------------------------------------

    const candidates = await Transaction.find({
      type: 'recharge',
      status: 'pending',
      amount: parsedAmount
    })
      .sort({ createdAt: 1 })
      .limit(50);

    let matchedTransaction = null;

    for (const tx of candidates) {
      const transactionUtr =
        extractUtrFromRechargeNote(tx.rechargeNote);

      if (
        transactionUtr &&
        transactionUtr === normalizedUtr
      ) {
        matchedTransaction = tx;
        break;
      }
    }

    // -----------------------------------------------------------------------
    // No matching player recharge.
    // -----------------------------------------------------------------------

    if (!matchedTransaction) {
      return res.json({
        matched: false,
        decision: 'NO_MATCH',
        autoVerify: settings.autoVerify,
        maxAutoAmount: settings.maxAutoAmount
      });
    }

    // -----------------------------------------------------------------------
    // Three-minute rule.
    //
    // Bank SMS and player recharge can arrive in either order.
    //
    // We compare the two timestamps and allow a maximum 3-minute difference.
    // -----------------------------------------------------------------------

    let bankTime = new Date();

    if (bankPaymentId) {
      const bankPayment = await BankPayment.findById(bankPaymentId);

      if (bankPayment && bankPayment.direction === 'credit') {
        bankTime = bankPayment.smsAt || bankPayment.createdAt;
      }
    }

    const transactionTime = matchedTransaction.createdAt;

    const differenceMs = Math.abs(
      bankTime.getTime() - transactionTime.getTime()
    );

    const withinThreeMinutes =
      differenceMs <= 3 * 60 * 1000;

    if (!withinThreeMinutes) {
      return res.json({
        matched: true,
        decision: 'MANUAL',
        reason: 'timestamp_outside_three_minute_window',
        transactionId: matchedTransaction._id,
        userId: matchedTransaction.user,
        amount: matchedTransaction.amount,
        utr: normalizedUtr
      });
    }

    // -----------------------------------------------------------------------
    // Auto Verify OFF → leave it for existing admin system.
    // -----------------------------------------------------------------------

    if (!settings.autoVerify) {
      return res.json({
        matched: true,
        decision: 'MANUAL',
        reason: 'auto_verify_disabled',
        transactionId: matchedTransaction._id,
        userId: matchedTransaction.user,
        amount: matchedTransaction.amount,
        utr: normalizedUtr
      });
    }

    // -----------------------------------------------------------------------
    // Amount exceeds admin's configured automatic limit.
    // -----------------------------------------------------------------------

    if (parsedAmount > settings.maxAutoAmount) {
      return res.json({
        matched: true,
        decision: 'MANUAL',
        reason: 'amount_exceeds_auto_limit',
        transactionId: matchedTransaction._id,
        userId: matchedTransaction.user,
        amount: matchedTransaction.amount,
        utr: normalizedUtr,
        maxAutoAmount: settings.maxAutoAmount
      });
    }

    // -----------------------------------------------------------------------
    // Everything matched.
    //
    // IMPORTANT:
    // We STILL DO NOT TOUCH THE USER BALANCE HERE.
    //
    // The response gives n8n the existing transactionId and userId.
    // The final approval must go through your existing admin approval
    // mechanism.
    // -----------------------------------------------------------------------

    return res.json({
      matched: true,
      decision: 'APPROVE',
      transactionId: matchedTransaction._id,
      userId: matchedTransaction.user,
      amount: matchedTransaction.amount,
      utr: normalizedUtr
    });
  } catch (err) {
    console.error('Payment match error:', err);

    res.status(500).json({
      message: 'Server error'
    });
  }
});

// ---------------------------------------------------------------------------
// EXPIRE OLD BANK PAYMENT RECORDS
//
// This does NOT reject the player's recharge.
// It only marks an unmatched bank event as expired.
// ---------------------------------------------------------------------------

router.post('/expire-bank-payments', automationSecret, async (req, res) => {
  try {
    const cutoff = new Date(
      Date.now() - 3 * 60 * 1000
    );

    const result = await BankPayment.updateMany(
      {
        direction: 'credit',
        status: 'pending',
        createdAt: { $lt: cutoff }
      },
      {
        $set: {
          status: 'expired'
        }
      }
    );

    res.json({
      expired: result.modifiedCount || 0
    });
  } catch (err) {
    console.error('Expire bank payments error:', err);

    res.status(500).json({
      message: 'Server error'
    });
  }
});

module.exports = router;
