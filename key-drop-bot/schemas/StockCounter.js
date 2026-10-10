'use strict';

const { Schema, model } = require('mongoose');

const StockCounterSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = model('StockCounter', StockCounterSchema);