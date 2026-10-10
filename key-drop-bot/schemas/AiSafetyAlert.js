'use strict';

const { Schema, model } = require('mongoose');

const AiSafetyAlertSchema = new Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    windowKey: { type: String, required: true },
    severity: { type: String, enum: ['medium', 'high'], required: true },
    confidence: { type: Number, min: 0, max: 1, required: true },
    summary: { type: String, required: true, maxlength: 500 },
    evidence: {
      peakMessagesIn15Minutes: { type: Number, min: 0, required: true },
      activeWindows: { type: Number, min: 0, required: true },
      messageRewards: { type: Number, min: 0, required: true },
      productClaims: { type: Number, min: 0, required: true },
    },
    model: { type: String, required: true },
    status: { type: String, enum: ['open', 'dismissed'], default: 'open' },
    dismissedAt: { type: Date, default: null },
    dismissedBy: { type: String, default: null },
  },
  { timestamps: true }
);

AiSafetyAlertSchema.index({ guildId: 1, userId: 1, windowKey: 1 }, { unique: true });
AiSafetyAlertSchema.index({ guildId: 1, status: 1, createdAt: -1 });

module.exports = model('AiSafetyAlert', AiSafetyAlertSchema);
