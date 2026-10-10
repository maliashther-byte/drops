'use strict';

const { Schema, model } = require('mongoose');

const TierGrantSchema = new Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    tier: { type: String, required: true },
    roleId: { type: String, required: true },
    roleIds: { type: [String], default: [] },
    expiresAt: { type: Date, required: true },
    processingExpiry: { type: Boolean, default: false },
  },
  { timestamps: true }
);

TierGrantSchema.index({ guildId: 1, userId: 1, tier: 1 }, { unique: true });
TierGrantSchema.index({ expiresAt: 1, processingExpiry: 1 });

module.exports = model('TierGrant', TierGrantSchema);
