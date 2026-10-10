'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { TIER_NAMES } = require('../config/constants');
const Guild = require('../schemas/Guild');
const { setButtonLimits } = require('./dropconfig');

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to set button drop limits.', ephemeral: true });
  }
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  return setButtonLimits(interaction, guildDoc);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dropbuttonlimits')
    .setDescription('Configure button drop limits for a tier in a drop channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Configured drop channel')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true))
    .addStringOption((option) => option
      .setName('tier')
      .setDescription('Member tier')
      .setRequired(true)
      .addChoices(...TIER_NAMES.map((tier) => ({ name: tier[0].toUpperCase() + tier.slice(1), value: tier }))))
    .addIntegerOption((option) => option
      .setName('daily_limit')
      .setDescription('Button claims allowed per day')
      .setMinValue(1)
      .setMaxValue(1000)
      .setRequired(true))
    .addIntegerOption((option) => option
      .setName('cooldown_minutes')
      .setDescription('Cooldown between button claims in minutes')
      .setMinValue(0)
      .setMaxValue(10080)
      .setRequired(true)),
  execute,
};
