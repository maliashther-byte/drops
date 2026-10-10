'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const Guild = require('../schemas/Guild');
const { grantCredits } = require('../utils/credits');

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to grant credits.', ephemeral: true });
  }
  const target = interaction.options.getUser('member', true);
  if (target.bot) return interaction.reply({ content: 'Credits cannot be granted to bot accounts.', ephemeral: true });
  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (!member) return interaction.reply({ content: 'Choose a member of this server.', ephemeral: true });

  const amount = interaction.options.getInteger('amount', true);
  const reason = interaction.options.getString('reason')?.trim() || 'Administrator credit grant';
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  try {
    const balance = await grantCredits({
      guildDoc,
      userId: target.id,
      amount,
      source: 'admin-grant',
      reason,
      actorId: interaction.user.id,
    });
    return interaction.reply({
      content: `Granted **${amount}** credits to ${target}. Their server wallet now has **${balance}** credits.`,
      ephemeral: true,
    });
  } catch (error) {
    return interaction.reply({ content: `The credit grant failed: ${error.message}`, ephemeral: true });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('creditgrant')
    .setDescription('Grant credits to a member in this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) => option
      .setName('member')
      .setDescription('Member receiving credits')
      .setRequired(true))
    .addIntegerOption((option) => option
      .setName('amount')
      .setDescription('Credits to add')
      .setMinValue(1)
      .setMaxValue(1_000_000)
      .setRequired(true))
    .addStringOption((option) => option
      .setName('reason')
      .setDescription('Why these credits are being granted')
      .setMaxLength(300)),
  execute,
};
