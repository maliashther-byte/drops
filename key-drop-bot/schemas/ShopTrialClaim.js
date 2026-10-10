'use strict';

const { Schema, model } = require('mongoose');

const ShopTrialClaimSchema = new Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    tier: { type: String, required: true },
    claimedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

ShopTrialClaimSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = model('ShopTrialClaim', ShopTrialClaimSchema);
