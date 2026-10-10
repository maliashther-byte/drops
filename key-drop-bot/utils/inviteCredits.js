'use strict';

const InviteCredit = require('../schemas/InviteCredit');
const { grantCredits } = require('./credits');
const logger = require('./logger');

async function claimInviteCredits({ guildDoc, guild, userId }) {
  const settings = guildDoc.creditSettings;
  if (!settings.invitesEnabled) return { reason: 'disabled' };

  const now = new Date();
  const candidates = await InviteCredit.find({
    guildId: guild.id,
    inviterId: userId,
    eligibleAt: { $lte: now },
    leftAt: null,
    claimedAt: null,
  }).sort({ joinedAt: 1 }).limit(1000).lean();
  const claimedIds = [];

  for (const invite of candidates) {
    let member;
    try {
      member = await guild.members.fetch(invite.inviteeId);
    } catch (error) {
      if (Number(error.code) === 10007) {
        await InviteCredit.updateOne(
          { _id: invite._id, leftAt: null, claimedAt: null },
          { $set: { leftAt: now } }
        );
        continue;
      }
      throw error;
    }
    if (member.user.bot) {
      await InviteCredit.updateOne(
        { _id: invite._id, leftAt: null, claimedAt: null },
        { $set: { leftAt: now } }
      );
      continue;
    }
    const updated = await InviteCredit.updateOne(
      { _id: invite._id, leftAt: null, claimedAt: null, eligibleAt: { $lte: now } },
      { $set: { claimedAt: now, claimedCredits: settings.inviteCredits } }
    );
    if (updated.modifiedCount === 1) claimedIds.push(invite._id);
  }

  if (!claimedIds.length) {
    const pendingCount = await InviteCredit.countDocuments({
      guildId: guild.id,
      inviterId: userId,
      eligibleAt: { $gt: now },
      leftAt: null,
      claimedAt: null,
    });
    return { reason: 'none', pendingCount };
  }

  const total = claimedIds.length * settings.inviteCredits;
  try {
    const balance = await grantCredits({
      guildDoc,
      userId,
      amount: total,
      source: 'invite',
      reason: `Claimed ${claimedIds.length} verified invite reward(s)`,
    });
    return { count: claimedIds.length, amount: total, balance };
  } catch (error) {
    try {
      await InviteCredit.updateMany(
        { _id: { $in: claimedIds }, claimedAt: now },
        { $set: { claimedAt: null, claimedCredits: 0 } }
      );
    } catch (rollbackError) {
      logger.error('invite_credit_claim_rollback_failed', {
        guildId: guild.id,
        userId,
        inviteCount: claimedIds.length,
        error: rollbackError.message,
      });
    }
    throw error;
  }
}

module.exports = { claimInviteCredits };
