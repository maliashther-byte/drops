'use strict';

const { Schema, model } = require('mongoose');

const DropUsageSchema = new Schema(
  {
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    mode: { type: String, enum: ['button', 'prefix'], required: true },
    dayKey: { type: String, default: null },
    dailyClaims: { type: Number, default: 0 },
    successfulClaims: { type: Number, default: 0 },
    lastClaimAt: { type: Date, default: null },
  },
  { timestamps: true }
);

DropUsageSchema.index({ userId: 1, guildId: 1, channelId: 1, mode: 1 }, { unique: true });

DropUsageSchema.statics.recordClaim = async function recordClaim({
  userId,
  guildId,
  channelId,
  mode,
  dailyLimit,
  cooldownMinutes,
}) {
  const key = { userId, guildId, channelId, mode };
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);

  try {
    await this.updateOne(key, { $setOnInsert: { dailyClaims: 0, dayKey: null, lastClaimAt: null } }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }

  const conditions = [];
  if (dailyLimit !== null) {
    conditions.push({
      $or: [
        { dayKey: { $ne: dayKey } },
        { dailyClaims: { $lt: dailyLimit } },
      ],
    });
  }
  if (cooldownMinutes > 0) {
    conditions.push({
      $or: [
        { lastClaimAt: null },
        { lastClaimAt: { $lte: new Date(now.getTime() - cooldownMinutes * 60_000) } },
      ],
    });
  }

  const update = [{
    $set: {
      lastClaimAt: now,
      dayKey,
      dailyClaims: dailyLimit === null
        ? { $ifNull: ['$dailyClaims', 0] }
        : {
            $cond: [
              { $eq: ['$dayKey', dayKey] },
              { $add: [{ $ifNull: ['$dailyClaims', 0] }, 1] },
              1,
            ],
          },
    },
  }];
  return this.findOneAndUpdate(conditions.length ? { ...key, $and: conditions } : key, update, { new: true });
};

DropUsageSchema.statics.recordSuccessfulClaim = function recordSuccessfulClaim({ userId, guildId, channelId, mode }) {
  return this.updateOne(
    { userId, guildId, channelId, mode },
    { $inc: { successfulClaims: 1 } }
  );
};

DropUsageSchema.statics.releaseClaim = function releaseClaim({ userId, guildId, channelId, mode, usage, previousLastClaimAt, dailyLimit }) {
  const update = { $set: { lastClaimAt: previousLastClaimAt || null } };
  if (dailyLimit !== null) update.$inc = { dailyClaims: -1 };
  return this.updateOne(
    { userId, guildId, channelId, mode, lastClaimAt: usage.lastClaimAt },
    update
  );
};

module.exports = model('DropUsage', DropUsageSchema);
