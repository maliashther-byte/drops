'use strict';

const { Schema, model } = require('mongoose');

const AiMessageSchema = new Schema(
  {
    role: { type: String, enum: ['user', 'model'], required: true },
    text: { type: String, required: true, maxlength: 4000 },
  },
  { timestamps: true }
);

const AiConversationSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    title: { type: String, required: true, maxlength: 100 },
    status: { type: String, enum: ['active', 'deployed', 'discarded'], default: 'active' },
    messages: { type: [AiMessageSchema], default: [] },
    pendingChanges: { type: Schema.Types.Mixed, default: null },
    pendingBase: { type: Schema.Types.Mixed, default: null },
    pendingSummary: { type: String, default: '', maxlength: 2000 },
    deployStartedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

AiConversationSchema.index({ guildId: 1, userId: 1, updatedAt: -1 });

module.exports = model('AiConversation', AiConversationSchema);
