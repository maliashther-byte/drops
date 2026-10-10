'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const GlobalCategory = require('../schemas/GlobalCategory');
const Guild = require('../schemas/Guild');
const TimedEvent = require('../schemas/TimedEvent');
const logger = require('../utils/logger');
const { isConfiguredDropChannel } = require('../utils/dropChannels');

const EVENT_INTERVAL_MS = 30_000;

const data = new SlashCommandBuilder()
  .setName('event')
  .setDescription('Announce a timed drop event for a shared category.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) => option
    .setName('category')
    .setDescription('The shared category for the event')
    .setRequired(true)
    .setAutocomplete(true))
  .addIntegerOption((option) => option
    .setName('duration_minutes')
    .setDescription('How long the event announcement stays active (1-10080 minutes)')
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(10080))
  .addBooleanOption((option) => option
    .setName('ping_here')
    .setDescription('Ping @here once when the event starts')
    .setRequired(false))
  .addChannelOption((option) => option
    .setName('channel')
    .setDescription('Configured drop channel where members can claim')
    .addChannelTypes(ChannelType.GuildText)
    .setRequired(false));

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to start an event.', ephemeral: true });
  }
  const guildConfig = await Guild.getOrCreate(interaction.guildId);
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Choose a server text channel for this event.', ephemeral: true });
  }
  if (!isConfiguredDropChannel(guildConfig, channel.id)) {
    return interaction.reply({ content: 'That channel is not configured for drops. Add it in `/dropconfig`, then retry the event.', ephemeral: true });
  }
  const categoryName = interaction.options.getString('category');
  const category = await GlobalCategory.findOne({ name: categoryName }).lean();
  if (!category) {
    return interaction.reply({ content: 'That shared category no longer exists. Choose another category.', ephemeral: true });
  }

  const durationMinutes = interaction.options.getInteger('duration_minutes');
  const expiresAt = new Date(Date.now() + durationMinutes * 60_000);
  const endTimestamp = Math.floor(expiresAt.getTime() / 1000);
  const embed = new EmbedBuilder()
    .setColor('#57F287')
    .setTitle(`${category.name} drop event`)
    .setDescription([
      `Claim from **${category.name}** with \`!drop ${category.name}\`.`,
      `This event ends <t:${endTimestamp}:R> (<t:${endTimestamp}:f>).`,
      'Claims still follow the server’s normal tier access, stock, and cooldown rules.',
    ].join('\n'));

  let message;
  try {
    message = await channel.send({
      content: interaction.options.getBoolean('ping_here') ? '@here' : undefined,
      allowedMentions: { parse: interaction.options.getBoolean('ping_here') ? ['everyone'] : [] },
      embeds: [embed],
    });
  } catch (err) {
    logger.error('timed_event_post_failed', { guildId: interaction.guildId, channelId: channel.id, error: err.message });
    return interaction.reply({ content: 'Could not post the event. Check the bot can send messages and embeds in this channel.', ephemeral: true });
  }

  try {
    await TimedEvent.create({
      guildId: interaction.guildId,
      channelId: channel.id,
      messageId: message.id,
      category: category.name,
      expiresAt,
    });
  } catch (err) {
    logger.error('timed_event_schedule_failed', { guildId: interaction.guildId, messageId: message.id, error: err.message });
    await message.delete().catch((deleteErr) => logger.warn('timed_event_rollback_failed', { messageId: message.id, error: deleteErr.message }));
    return interaction.reply({ content: 'The event announcement could not be scheduled and was removed. Please try again.', ephemeral: true });
  }

  return interaction.reply({
    content: `Started the **${category.name}** event for **${durationMinutes} minutes** in ${channel}.`,
    ephemeral: true,
  });
}

async function autocomplete(interaction) {
  const query = interaction.options.getFocused().toLowerCase();
  const categories = await GlobalCategory.find({ name: { $regex: `^${escapeRegex(query)}` } })
    .sort({ name: 1 })
    .limit(25)
    .select({ name: 1 })
    .lean();
  return interaction.respond(categories.map(({ name }) => ({ name, value: name })));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function expireEvents(client) {
  const events = await TimedEvent.find({ expired: false, expiresAt: { $lte: new Date() } }).limit(100);
  for (const event of events) {
    try {
      const channel = await client.channels.fetch(event.channelId);
      const message = await channel.messages.fetch(event.messageId);
      const endedEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle(`${event.category} drop event ended`)
        .setDescription('This timed drop event has ended. Start a new event with `/event`.');
      await message.edit({ content: null, embeds: [endedEmbed], components: [] });
      event.expired = true;
      await event.save();
    } catch (err) {
      if ([10003, 10008].includes(Number(err.code))) {
        event.expired = true;
        await event.save();
        continue;
      }
      logger.error('timed_event_expiry_failed', {
        guildId: event.guildId,
        messageId: event.messageId,
        error: err.message,
      });
    }
  }
}

function startExpiryWorker(client) {
  const sweep = () => expireEvents(client).catch((err) => {
    logger.error('timed_event_sweep_failed', { error: err.message });
  });
  sweep();
  setInterval(sweep, EVENT_INTERVAL_MS).unref();
}

module.exports = { data, execute, autocomplete, startExpiryWorker };
