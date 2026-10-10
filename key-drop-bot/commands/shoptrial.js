'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const Guild = require('../schemas/Guild');
const { TIER_NAMES } = require('../config/constants');

async function execute(interaction) {
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Use this command in a server where you have Administrator permission.', ephemeral: true });
  }
  const tierName = interaction.options.getString('tier', true);
  const enabled = interaction.options.getBoolean('enabled', true);
  const durationHours = interaction.options.getInteger('duration_hours', true);
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const tier = guildDoc.getTier(tierName);
  if (!tier) return interaction.reply({ content: 'That tier is not configured.', ephemeral: true });
  if (enabled) {
    if (!tier.roleId) return interaction.reply({ content: `Configure the ${tierName} role before enabling its trial.`, ephemeral: true });
    const botMember = interaction.guild.members.me;
    const role = await interaction.guild.roles.fetch(tier.roleId);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ||
      !role || role.position >= botMember.roles.highest.position) {
      return interaction.reply({
        content: 'The bot needs Manage Roles permission and a role hierarchy above the configured trial role.',
        ephemeral: true,
      });
    }
  }
  tier.trialEnabled = enabled;
  tier.trialDurationHours = durationHours;
  await guildDoc.save();
  return interaction.reply({
    content: enabled
      ? `${tier.label} trials are enabled for **${durationHours} hour(s)**. Each member may claim one trial per server.`
      : `${tier.label} trials are disabled.`,
    ephemeral: true,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shoptrial')
    .setDescription('Configure a one-time shop trial for a tier.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option
      .setName('tier')
      .setDescription('Tier to offer as a trial')
      .setRequired(true)
      .addChoices(...TIER_NAMES.map((value) => ({ name: value[0].toUpperCase() + value.slice(1), value }))))
    .addBooleanOption((option) => option
      .setName('enabled')
      .setDescription('Whether this tier offers a trial')
      .setRequired(true))
    .addIntegerOption((option) => option
      .setName('duration_hours')
      .setDescription('Trial access duration in hours')
      .setMinValue(1)
      .setMaxValue(8760)
      .setRequired(true)),
  execute,
};
