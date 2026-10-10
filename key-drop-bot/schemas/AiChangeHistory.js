'use strict';

const { Schema, model } = require('mongoose');

const AiChangeHistorySchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    actorId: { type: String, required: true },
    conversationId: { type: Schema.Types.ObjectId, required: true },
    before: { type: Schema.Types.Mixed, required: true },
    after: { type: Schema.Types.Mixed, required: true },
    beforeButtons: { type: Schema.Types.Mixed, default: [] },
    afterButtons: { type: Schema.Types.Mixed, default: [] },
    summary: { type: String, default: '', maxlength: 2000 },
    status: { type: String, enum: ['pending', 'applied', 'undone', 'failed'], default: 'pending' },
    undoneAt: { type: Date, default: null },
    undoneBy: { type: String, default: null },
    undoStartedAt: { type: Date, default: null },
    undoStartedBy: { type: String, default: null },
  },
  { timestamps: true }
);

AiChangeHistorySchema.index({ guildId:  1, createdAt: -1 });

module.exports = model('AiChangeHistory', AiChangeHistorySchema);
