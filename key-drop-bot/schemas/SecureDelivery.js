'use strict';

const { Schema, model } = require('mongoose');

const SecureDeliverySchema = new Schema(
  {
    _id: { type: String, required: true },
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    itemIds: { type: [Schema.Types.ObjectId], required: true },
    itemValues: { type: [String], default: [] },
    securedItemIds: { type: [Schema.Types.ObjectId], default: [] },
    secureItemsPerClick: { type: Number, required: true, min: 0, max: 25 },
    securedCount: { type: Number, default: 0, min: 0 },
    processing: { type: Boolean, default: false },
    processingAt: { type: Date, default: null },
    completed: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

module.exports = model('SecureDelivery', SecureDeliverySchema);
