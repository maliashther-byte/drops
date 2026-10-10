'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const Guild = require('../schemas/Guild');
const { TIER_NAMES } = require('../config/constants');

const settings = [
  ['starting-balance', 'Set the starting wallet balance for new members'],
  ['daily-enable', 'Enable or disable daily credit rewards'],
  ['daily-amount', 'Set the daily reward for one tier'],
  ['daily-cooldown', 'Set the daily reward cooldown in hours'],
  ['message-enable', 'Enable or disable message rewards'],
  ['message-amount', 'Set credits awarded for an eligible message'],
  ['message-cooldown', 'Set the message reward cooldown in minutes'],
  ['message-cap', 'Set the maximum message credits per day'],
  ['message-channel-add', 'Allow message rewards in a channel'],
  ['message-channel-remove', 'Remove a message reward channel'],
  ['message-tier-add', 'Allow a tier to earn message rewards'],
  ['message-tier-remove', 'Remove a tier from message rewards'],
  ['ai-safety-enable', 'Enable or disable Gemini activity analysis'],
  ['invite-enable', 'Enable or disable verified invite rewards'],
  ['invite-amount', 'Set credits awarded per verified invite'],
  ['invite-stay', 'Set how many hours an invitee must stay'],
];

async function execute(interaction) {
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Use this command in a server where you have Administrator permission.', ephemeral: true });
  }
  const setting = interaction.options.getString('setting', true);
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const config = guildDoc.creditSettings;
  const amount = interaction.options.getInteger('amount');
  const hours = interaction.options.getInteger('hours');
  const channel = interaction.options.getChannel('channel');
  const tier = interaction.options.getString('tier');
  const enabled = interaction.options.getBoolean('enabled');

  try {
    if (setting.endsWith('-enable')) {
      if (enabled === null) throw new Error('Choose whether to enable or disable this feature.');
      const key = setting.startsWith('daily')
        ? 'dailyEnabled'
        : setting.startsWith('message')
          ? 'messageEnabled'
          : setting === 'ai-safety-enable' ? 'aiSafetyEnabled' : 'invitesEnabled';
      if (key === 'invitesEnabled' && enabled &&
        !interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error('The bot needs Manage Server permission before invite rewards can be enabled.');
      }
      config[key] = enabled;
    } else if (setting === 'starting-balance') {
      config.startingBalance = bounded(amount, 0, 1_000_000, 'Starting balance');
    } else if (setting === 'daily-amount') {
      requireTier(tier);
      config.dailyAmounts.set(tier, bounded(amount, 0, 1_000_000, 'Daily reward'));
    } else if (setting === 'daily-cooldown') {
      config.dailyCooldownHours = bounded(hours, 1, 720, 'Daily cooldown');
    } else if (setting === 'message-amount') {
      config.messageCredits = bounded(amount, 1, 100_000, 'Message reward');
    } else if (setting === 'message-cooldown') {
      config.messageCooldownMinutes = bounded(amount, 1, 10080, 'Message cooldown');
    } else if (setting === 'message-cap') {
      config.messageDailyCap = bounded(amount, 1, 1_000_000, 'Message daily cap');
    } else if (setting === 'message-channel-add' || setting === 'message-channel-remove') {
      if (!channel || channel.type !== 0 || channel.guildId !== interaction.guildId) {
        throw new Error('Choose a text channel from this server.');
      }
      const channelIds = config.messageChannelIds;
      if (setting === 'message-channel-add') {
        if (!channelIds.includes(channel.id) && channelIds.length >= 20) throw new Error('Up to 20 message reward channels are supported.');
        if (!channelIds.includes(channel.id)) channelIds.push(channel.id);
      } else {
        config.messageChannelIds = channelIds.filter((id) => id !== channel.id);
      }
    } else if (setting === 'message-tier-add' || setting === 'message-tier-remove') {
      requireTier(tier);
      const eligible = config.messageEligibleTiers;
      if (setting === 'message-tier-add' && !eligible.includes(tier)) eligible.push(tier);
      if (setting === 'message-tier-remove') config.messageEligibleTiers = eligible.filter((name) => name !== tier);
    } else if (setting === 'invite-amount') {
      config.inviteCredits = bounded(amount, 1, 1_000_000, 'Invite reward');
    } else if (setting === 'invite-stay') {
      config.inviteMemberAgeHours = bounded(hours, 1, 720, 'Invite stay duration');
    }
    if (config.messageCredits > config.messageDailyCap) {
      throw new Error('The message reward cannot exceed its daily cap.');
    }
    if ((config.messageEnabled || config.aiSafetyEnabled) && !config.messageChannelIds.length) {
      throw new Error('Add at least one activity channel before enabling message rewards or AI monitoring.');
    }
    await guildDoc.save();
    return interaction.reply({ content: `Updated credit setting **${setting}**.`, ephemeral: true });
  } catch (error) {
    return interaction.reply({ content: error.message || 'The credit setting could not be saved.', ephemeral: true });
  }
}

function bounded(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}

function requireTier(tier) {
  if (!TIER_NAMES.includes(tier)) throw new Error(`Choose one of these tiers: ${TIER_NAMES.join(', ')}.`);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('creditconfig')
    .setDescription('Configure this server’s credit earning rules.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option
      .setName('setting')
      .setDescription('Credit setting to change')
      .setRequired(true)
      .addChoices(...settings.map(([value, name]) => ({ name, value }))))
    .addIntegerOption((option) => option
      .setName('amount')
      .setDescription('Whole-number amount or cooldown minutes'))
    .addIntegerOption((option) => option
      .setName('hours')
      .setDescription('Cooldown or member-stay duration in hours'))
    .addBooleanOption((option) => option
      .setName('enabled')
      .setDescription('Enable or disable the selected reward method'))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Text channel for message rewards'))
    .addStringOption((option) => option
      .setName('tier')
      .setDescription('Member tier')
      .addChoices(...TIER_NAMES.map((value) => ({ name: value[0].toUpperCase() + value.slice(1), value })))),
  execute,
};
