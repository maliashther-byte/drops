'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Guild = require('../schemas/Guild');
const InviteCredit = require('../schemas/InviteCredit');
const { ensureCreditUser } = require('../utils/credits');

async function execute(interaction) {
  if (!interaction.guildId) {
    return interaction.reply({ content: 'Use `/wallet` in a server to view that server’s credits.', ephemeral: true });
  }
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const user = await ensureCreditUser(guildDoc, interaction.user.id);
  const now = new Date();
  let eligibleInvites = 0;
  let pendingInvites = 0;
  if (guildDoc.creditSettings.invitesEnabled) {
    [eligibleInvites, pendingInvites] = await Promise.all([
      InviteCredit.countDocuments({
        guildId: interaction.guildId,
        inviterId: interaction.user.id,
        eligibleAt: { $lte: now },
        leftAt: null,
        claimedAt: null,
      }),
      InviteCredit.countDocuments({
        guildId: interaction.guildId,
        inviterId: interaction.user.id,
        eligibleAt: { $gt: now },
        leftAt: null,
        claimedAt: null,
      }),
    ]);
  }
  const fields = [{
    name: 'Available credits',
    value: `**${user.credits}**`,
    inline: true,
  }];
  if (eligibleInvites || pendingInvites) {
    fields.push({
      name: 'Invite rewards',
      value: `${eligibleInvites} ready to claim · ${pendingInvites} waiting`,
      inline: true,
    });
  }
  if (guildDoc.creditSettings.dailyEnabled && user.lastDailyCreditAt) {
    const nextClaim = Math.floor((user.lastDailyCreditAt.getTime() + guildDoc.creditSettings.dailyCooldownHours * 3_600_000) / 1000);
    fields.push({ name: 'Next daily reward', value: `<t:${nextClaim}:R>`, inline: true });
  }
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(guildDoc.embedStyle?.color || '#5865F2')
        .setTitle(`${interaction.user.username}’s wallet`)
        .setDescription('Credit balances and rewards are separate for each server.')
        .addFields(fields),
    ],
    ephemeral: true,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('View your credits and available rewards in this server.'),
  execute,
};
