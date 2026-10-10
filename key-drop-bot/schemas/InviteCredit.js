'use strict';

const { Schema, model } = require('mongoose');

const InviteCreditSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    inviterId: { type: String, required: true, index: true },
    inviteeId: { type: String, required: true },
    inviteCode: { type: String, required: true },
    joinedAt: { type: Date, required: true },
    eligibleAt: { type: Date, required: true },
    leftAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    claimedCredits: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true }
);

InviteCreditSchema.index({ guildId: 1, inviteeId: 1 }, { unique: true });
InviteCreditSchema.index({ guildId: 1, inviterId: 1, claimedAt: 1, eligibleAt: 1 });

module.exports = model('InviteCredit', InviteCreditSchema);
