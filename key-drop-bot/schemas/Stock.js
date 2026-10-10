'use strict';

const { Schema, model } = require('mongoose');

const StockSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true },
    archived: { type: Boolean, default: false, index: true },

    // Denormalized from the guild's category config at insert time so a
    // claim can be delivered correctly even if the category is edited
    // or removed later. 'key'/'link' items are delivered by DMing
    // `value`; 'role' items are delivered by granting `roleId` to the
    // claimant (value holds a human-readable label for logs only).
    dropType: { type: String, enum: ['key', 'link', 'role'], default: 'key' },

    // The key/link text (for dropType 'key'/'link'), or a label (for
    // dropType 'role', e.g. "VIP role"). Never rendered in public
    // channels — only ever sent to or acted on for the claimant.
    value: { type: String, required: true },
    roleId: { type: String, default: null },

    claimed: { type: Boolean, default: false, index: true },
    claimedBy: { type: String, default: null },
    claimedAt: { type: Date, default: null },

    addedBy: { type: String, required: true },
    source: { type: String, enum: ['manual', 'bulk-ai', 'bulk-keyword'], default: 'manual' },
  },
  { timestamps: true }
);

StockSchema.index({ guildId: 1, category: 1, claimed: 1 });
// Prevent the exact same key being stocked twice in the same guild/category.
StockSchema.index({ guildId: 1, category: 1, value: 1 }, { unique: true });

StockSchema.statics.countAvailable = function countAvailable(guildId, category) {
  const query = { guildId, claimed: false, archived: { $ne: true } };
  if (category) query.category = category;
  return this.countDocuments(query);
};

StockSchema.statics.claimOne = async function claimOne(guildId, category, userId) {
  // findOneAndUpdate is atomic — prevents two users racing the same key
  // when both drop at the same instant under load.
  return this.findOneAndUpdate(
    { guildId, category, claimed: false, archived: { $ne: true } },
    { $set: { claimed: true, claimedBy: userId, claimedAt: new Date() } },
    { new: true, sort: { createdAt: 1 } }
  );
};

module.exports = model('Stock', StockSchema);
