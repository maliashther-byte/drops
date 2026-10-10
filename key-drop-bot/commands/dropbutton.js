'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const Guild = require('../schemas/Guild');
const { publishButtonDropCommand, autocompleteButtonProduct } = require('./dropconfig');

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to publish a drop button.', ephemeral: true });
  }
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  return publishButtonDropCommand(interaction, guildDoc);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dropbutton')
    .setDescription('Publish a custom embed with a working generator claim button.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option
      .setName('product')
      .setDescription('Generator command without the !')
      .setRequired(true)
      .setAutocomplete(true))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Configured drop channel to publish in')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true))
    .addStringOption((option) => option
      .setName('title')
      .setDescription('Embed title')
      .setMaxLength(256))
    .addStringOption((option) => option
      .setName('description')
      .setDescription('Embed description')
      .setMaxLength(4000))
    .addStringOption((option) => option
      .setName('button_label')
      .setDescription('Text shown on the claim button')
      .setMaxLength(80))
    .addStringOption((option) => option
      .setName('image_url')
      .setDescription('Optional HTTPS embed image URL')
      .setMaxLength(1000)),
  execute,
  autocomplete: autocompleteButtonProduct,
};
