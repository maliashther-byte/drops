'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const Guild = require('../schemas/Guild');

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to change drop costs.', ephemeral: true });
  }
  const commandName = interaction.options.getString('generator', true).toLowerCase();
  const creditCost = interaction.options.getInteger('credits', true);
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const product = guildDoc.dropProducts.find((entry) => entry.commandName === commandName);
  if (!product) return interaction.reply({ content: `No generator named \`${commandName}\` exists in this server.`, ephemeral: true });
  product.creditCost = creditCost;
  await guildDoc.save();
  return interaction.reply({
    content: creditCost
      ? `**${product.name}** now costs **${creditCost}** credits per claim.`
      : `**${product.name}** is now free to claim.`,
    ephemeral: true,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dropcost')
    .setDescription('Set the credit cost for a product drop generator.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option
      .setName('generator')
      .setDescription('Generator command name, without the prefix')
      .setRequired(true)
      .setMaxLength(32))
    .addIntegerOption((option) => option
      .setName('credits')
      .setDescription('Credits per claim; use 0 to make it free')
      .setMinValue(0)
      .setMaxValue(1_000_000)
      .setRequired(true)),
  execute,
};
