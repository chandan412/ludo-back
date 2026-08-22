const mongoose = require('mongoose');

const bankPaymentSchema = new mongoose.Schema(
  {
    // Amount received according to the bank SMS
    amount: {
      type: Number,
      required: true,
      min: 0
    },

    // UTR extracted from the bank SMS
    // Unique so the same bank payment cannot be processed twice.
    utr: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },

    // Masked bank account from SMS, e.g. XX794
    bankAccount: {
      type: String,
      default: '',
      trim: true
    },

    // Debit must never be treated as a payment received.
    direction: {
      type: String,
      enum: ['credit', 'debit'],
      required: true
    },

    // Original SMS for audit/debugging
    smsText: {
      type: String,
      default: '',
      maxlength: 3000
    },

    // Time extracted/received from the SMS workflow
    smsAt: {
      type: Date,
      default: Date.now
    },

    status: {
      type: String,
      enum: [
        'pending',
        'matched',
        'manual',
        'expired',
        'ignored'
      ],
      default: 'pending',
      index: true
    },

    // Existing recharge transaction that this bank payment matched.
    matchedTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      default: null
    },

    matchedAt: {
      type: Date,
      default: null
    },

    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

module.exports =
  mongoose.models.BankPayment ||
  mongoose.model('BankPayment', bankPaymentSchema);
