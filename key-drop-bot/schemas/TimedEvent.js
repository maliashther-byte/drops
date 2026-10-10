'use strict';

const { Schema, model } = require('mongoose');

const TimedEventSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
    category: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    expired: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

module.exports = model('TimedEvent', TimedEventSchema);
