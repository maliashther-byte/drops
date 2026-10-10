'use strict';

const Guild = require('../schemas/Guild');
const InviteCredit = require('../schemas/InviteCredit');
const logger = require('./logger');

const inviteSnapshots = new Map();

function toSnapshot(invites) {
  return new Map(invites.map((invite) => [invite.code, {
    uses: invite.uses || 0,
    inviterId: invite.inviterId || invite.inviter?.id || null,
  }]));
}

async function loadGuildInviteSnapshots(client) {
  const configuredGuilds = await Guild.find({ 'creditSettings.invitesEnabled': true }).select({ guildId: 1 }).lean();
  for (const { guildId } of configuredGuilds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    try {
      inviteSnapshots.set(guildId, toSnapshot(await guild.invites.fetch()));
    } catch (error) {
      logger.warn('invite_snapshot_load_failed', { guildId, error: error.message });
    }
  }
}

async function refreshInviteSnapshot(guild) {
  const invites = await guild.invites.fetch();
  inviteSnapshots.set(guild.id, toSnapshot(invites));
}

async function recordInvitedMember(member) {
  if (member.user.bot) return;
  const guildDoc = await Guild.getOrCreate(member.guild.id);
  if (!guildDoc.creditSettings.invitesEnabled) return;

  let invites;
  try {
    invites = toSnapshot(await member.guild.invites.fetch());
  } catch (error) {
    logger.warn('invite_attribution_fetch_failed', { guildId: member.guild.id, error: error.message });
    return;
  }
  const previous = inviteSnapshots.get(member.guild.id);
  inviteSnapshots.set(member.guild.id, invites);
  if (!previous) {
    logger.warn('invite_attribution_baseline_missing', { guildId: member.guild.id, userId: member.id });
    return;
  }

  const increased = [...invites.entries()].filter(([code, invite]) =>
    invite.uses > (previous.get(code)?.uses ?? 0) && invite.inviterId && invite.inviterId !== member.id
  );
  if (increased.length !== 1) {
    logger.info('invite_join_unattributed', { guildId: member.guild.id, userId: member.id, changedInviteCount: increased.length });
    return;
  }

  const [inviteCode, invite] = increased[0];
  try {
    await InviteCredit.create({
      guildId: member.guild.id,
      inviterId: invite.inviterId,
      inviteeId: member.id,
      inviteCode,
      joinedAt: member.joinedAt || new Date(),
      eligibleAt: new Date(Date.now() + guildDoc.creditSettings.inviteMemberAgeHours * 60 * 60 * 1000),
    });
  } catch (error) {
    if (error.code === 11000) {
      logger.info('invite_join_already_recorded', { guildId: member.guild.id, userId: member.id });
      return;
    }
    throw error;
  }
}

async function markInvitedMemberLeft(member) {
  await InviteCredit.updateOne(
    {
      guildId: member.guild.id,
      inviteeId: member.id,
      claimedAt: null,
      leftAt: null,
    },
    { $set: { leftAt: new Date() } }
  );
}

async function handleInviteCreate(invite) {
  let snapshot = inviteSnapshots.get(invite.guild.id);
  if (!snapshot) {
    snapshot = new Map();
    inviteSnapshots.set(invite.guild.id, snapshot);
  }
  snapshot.set(invite.code, {
    uses: invite.uses || 0,
    inviterId: invite.inviterId || invite.inviter?.id || null,
  });
}

module.exports = {
  loadGuildInviteSnapshots,
  refreshInviteSnapshot,
  recordInvitedMember,
  markInvitedMemberLeft,
  handleInviteCreate,
};
