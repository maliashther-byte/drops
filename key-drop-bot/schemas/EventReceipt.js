'use strict';

const { Schema, model } = require('mongoose');

const EventReceiptSchema = new Schema(
  {
    _id: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

module.exports = model('EventReceipt', EventReceiptSchema);
