'use strict';

const { Schema, model } = require('mongoose');

const CreditTransactionSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    source: { type: String, required: true, enum: ['starting', 'admin-grant', 'daily', 'message', 'invite', 'drop', 'drop-refund'] },
    reason: { type: String, default: '', maxlength: 300 },
    actorId: { type: String, default: null },
  },
  { timestamps: true }
);

CreditTransactionSchema.index({ guildId: 1, createdAt: -1 });
CreditTransactionSchema.index({ guildId: 1, userId: 1, createdAt: -1 });

module.exports = model('CreditTransaction', CreditTransactionSchema);
