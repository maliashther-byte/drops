'use strict';

const { Schema, model } = require('mongoose');

const CooldownRewardSchema = new Schema(
  {
    _id: { type: String, required: true },
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    itemIds: { type: [Schema.Types.ObjectId], default: [] },
    source: { type: String, enum: ['drop', 'owner'], required: true },
    expiresAt: { type: Date, required: true, index: true },
    processing: { type: Boolean, default: false },
    processingAt: { type: Date, default: null },
    activatedAt: { type: Date, default: null, index: true },
    expiredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = model('CooldownReward', CooldownRewardSchema);
