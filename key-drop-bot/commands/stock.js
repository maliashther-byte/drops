'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { publishStockCounter } = require('../utils/stockCounter');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Post or update the public live stock counter.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction, client) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Administrator permission is required to post the public stock counter.', ephemeral: true });
    }
    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      return interaction.reply({ content: 'Run `/stock` in a server text channel.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      await publishStockCounter(interaction.client, interaction.channel);
      return interaction.editReply('The public live stock counter is posted and refreshes every 10 seconds.');
    } catch (error) {
      logger.error('stock_counter_publish_failed', {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        error: error.message,
      });
      return interaction.editReply('Could not post the stock counter. Check bot permissions for embeds, components, and attachments.');
    }
  },
};