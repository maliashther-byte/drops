'use strict';

const { Schema, model } = require('mongoose');

const AiActivityMetricSchema = new Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    windowStart: { type: Date, required: true },
    messageCount: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true }
);

AiActivityMetricSchema.index({ guildId: 1, userId: 1, windowStart: 1 }, { unique: true });
AiActivityMetricSchema.index({ windowStart: 1 }, { expireAfterSeconds: 604800 });

module.exports = model('AiActivityMetric', AiActivityMetricSchema);
