'use strict';

const { Schema, model } = require('mongoose');
const { DROP_TYPES } = require('../config/constants');

const GlobalStockSchema = new Schema(
  {
    category: { type: String, required: true, index: true },
    dropType: { type: String, enum: DROP_TYPES, required: true },
    value: { type: String, required: true },
    claimed: { type: Boolean, default: false, index: true },
    claimedBy: { type: String, default: null },
    claimedInGuildId: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    claimBatchId: { type: String, default: null },
    archived: { type: Boolean, default: false, index: true },
    addedBy: { type: String, required: true },
    source: { type: String, enum: ['manual', 'bulk-ai', 'bulk-keyword'], default: 'manual' },
  },
  { timestamps: true }
);

GlobalStockSchema.index({ category: 1, claimed: 1, archived: 1 });
GlobalStockSchema.index({ category: 1, value: 1 }, { unique: true });

GlobalStockSchema.statics.countAvailable = function countAvailable(category) {
  const query = { claimed: false, archived: { $ne: true } };
  if (category) query.category = category;
  return this.countDocuments(query);
};

GlobalStockSchema.statics.claimOne = async function claimOne(category, userId, guildId, claimBatchId = null) {
  const eligibleStock = { category, claimed: false, archived: { $ne: true } };
  const [candidate] = await this.aggregate([
    { $match: eligibleStock },
    { $sample: { size: 1 } },
    { $project: { _id: 1 } },
  ]);
  if (!candidate) return null;

  return this.findOneAndUpdate(
    { _id: candidate._id, ...eligibleStock },
    { $set: { claimed: true, claimedBy: userId, claimedInGuildId: guildId, claimedAt: new Date(), claimBatchId } },
    { new: true }
  );
};

GlobalStockSchema.statics.claimMany = async function claimMany(category, quantity, userId, guildId, claimBatchId) {
  const eligibleStock = { category, claimed: false, archived: { $ne: true } };
  const candidates = await this.aggregate([
    { $match: eligibleStock },
    { $sample: { size: quantity } },
    { $project: { _id: 1 } },
  ]);
  if (candidates.length !== quantity) return [];

  const ids = candidates.map(({ _id }) => _id);
  const result = await this.updateMany(
    { _id: { $in: ids }, ...eligibleStock },
    { $set: { claimed: true, claimedBy: userId, claimedInGuildId: guildId, claimedAt: new Date(), claimBatchId } }
  );
  if (result.modifiedCount !== quantity) {
    await this.updateMany(
      { _id: { $in: ids }, claimBatchId },
      { $set: { claimed: false, claimedBy: null, claimedInGuildId: null, claimedAt: null, claimBatchId: null } }
    );
    return [];
  }
  const claimedItems = await this.find({ claimBatchId, claimed: true });
  const itemsById = new Map(claimedItems.map((item) => [String(item._id), item]));
  return ids.map((id) => itemsById.get(String(id))).filter(Boolean);
};

module.exports = model('GlobalStock', GlobalStockSchema);
