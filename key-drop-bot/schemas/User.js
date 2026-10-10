'use strict';

const { Schema, model } = require('mongoose');

const UserSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    guildId: { type: String, required: true, index: true },

    tier: { type: String, default: 'free' },

    // Rolling daily counter. dropsToday resets when dayKey no longer
    // matches today's UTC date string (see utils/permissions.js).
    dayKey: { type: String, default: null },
    dropsToday: { type: Number, default: 0 },

    lastDropAt: { type: Date, default: null },

    totalDropsClaimed: { type: Number, default: 0 },

    credits: { type: Number, min: 0, default: 0 },
    creditsInitialized: { type: Boolean, default: false },
    lastDailyCreditAt: { type: Date, default: null },
    lastMessageCreditAt: { type: Date, default: null },
    messageCreditDay: { type: String, default: null },
    messageCreditsEarned: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true }
);

UserSchema.index({ userId: 1, guildId: 1 }, { unique: true });

UserSchema.statics.getOrCreate = async function getOrCreate(userId, guildId, startingBalance = null) {
  let doc = await this.findOne({ userId, guildId });
  if (!doc) {
    try {
      doc = await this.create({
        userId,
        guildId,
        credits: startingBalance ?? 0,
        creditsInitialized: startingBalance !== null,
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      doc = await this.findOne({ userId, guildId });
    }
  }
  if (!doc.creditsInitialized && startingBalance !== null) {
    doc = await this.findOneAndUpdate(
      { userId, guildId, creditsInitialized: { $ne: true } },
      { $set: { credits: startingBalance, creditsInitialized: true } },
      { new: true }
    ) || await this.findOne({ userId, guildId });
  }
  return doc;
};

module.exports = model('User', UserSchema);
