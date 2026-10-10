'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const StockCounter = require('../schemas/StockCounter');
const { getStockSummary } = require('./stockSummary');
const logger = require('./logger');

const REFRESH_INTERVAL_MS = 10_000;
const MAX_VISIBLE_CATEGORIES = 24;
const activeCounters = new Map();
const refreshingCounters = new Set();
let pendingRefresh = null;

function buildStockCounterPayload(categories, updatedAt = new Date()) {
  const visible = categories.slice(0, MAX_VISIBLE_CATEGORIES);
  const availableTotal = categories.reduce((sum, category) => sum + category.available, 0);
  const claimedTotal = categories.reduce((sum, category) => sum + category.claimed, 0);
  const lines = visible.map((category) =>
    `**${category.name}** · ${category.available.toLocaleString()} available · ${category.claimed.toLocaleString()} claimed`
  );
  if (categories.length > visible.length) {
    lines.push(`…and ${categories.length - visible.length} more categories. View all counts at the public stock page.`);
  }

  const embed = new EmbedBuilder()
    .setColor('#27AE9B')
    .setTitle('Live shared stock')
    .setDescription(lines.join('\n') || 'No stock categories are configured yet.')
    .addFields(
      { name: 'Available', value: availableTotal.toLocaleString(), inline: true },
      { name: 'Claimed', value: claimedTotal.toLocaleString(), inline: true }
    )
    .setFooter({ text: 'Shared inventory · updates every 10 seconds' })
    .setTimestamp(updatedAt);
  const refresh = new ButtonBuilder()
    .setCustomId('stock-counter:refresh')
    .setLabel('Refresh now')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(refresh)],
  };
}

async function getCounterMessage(client, record) {
  const guild = await client.guilds.fetch(record.guildId);
  const channel = await guild.channels.fetch(record.channelId);
  if (!channel?.messages?.fetch) throw new Error('Counter channel cannot fetch messages.');
  return channel.messages.fetch(record.messageId);
}

async function refreshCounter(client, guildId, expectedMessageId = null) {
  const key = String(guildId);
  if (refreshingCounters.has(key)) return false;
  refreshingCounters.add(key);
  try {
    const record = await StockCounter.findOne({ guildId: key }).lean();
    if (!record || (expectedMessageId && record.messageId !== expectedMessageId)) return false;
    const [message, summary] = await Promise.all([
      getCounterMessage(client, record),
      getStockSummary(),
    ]);
    await message.edit(buildStockCounterPayload(summary.active));
    return true;
  } catch (error) {
    if ([10003, 10008].includes(Number(error.code))) {
      await StockCounter.deleteOne({ guildId: key }).catch(() => {});
      stopCounter(key);
    } else {
      logger.warn('stock_counter_refresh_failed', { guildId: key, error: error.message });
    }
    return false;
  } finally {
    refreshingCounters.delete(key);
  }
}

function stopCounter(guildId) {
  const key = String(guildId);
  const active = activeCounters.get(key);
  if (active) clearInterval(active.timer);
  activeCounters.delete(key);
}

function activateCounter(client, record) {
  const key = String(record.guildId);
  stopCounter(key);
  const timer = setInterval(() => {
    refreshCounter(client, key, record.messageId);
  }, REFRESH_INTERVAL_MS);
  timer.unref();
  activeCounters.set(key, { client, messageId: record.messageId, timer });
  refreshCounter(client, key, record.messageId);
}

async function publishStockCounter(client, channel) {
  const guildId = channel.guild.id;
  const existing = await StockCounter.findOne({ guildId }).lean();
  if (existing?.channelId === channel.id) {
    try {
      const message = await getCounterMessage(client, existing);
      const summary = await getStockSummary();
      await message.edit(buildStockCounterPayload(summary.active));
      activateCounter(client, existing);
      return message;
    } catch (error) {
      if (![10003, 10008].includes(Number(error.code))) throw error;
      stopCounter(guildId);
    }
  }

  const summary = await getStockSummary();
  const message = await channel.send(buildStockCounterPayload(summary.active));
  const record = { guildId, channelId: channel.id, messageId: message.id };
  try {
    await StockCounter.findOneAndUpdate(
      { guildId },
      { $set: record },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    await message.delete().catch(() => {});
    throw error;
  }
  if (existing) {
    try {
      const oldMessage = await getCounterMessage(client, existing);
      await oldMessage.edit({ content: 'This stock counter has moved.', embeds: [], components: [] });
    } catch (_) {
      // The old counter may already have been deleted.
    }
  }
  activateCounter(client, record);
  return message;
}

async function handleRefresh(interaction, client) {
  const record = await StockCounter.findOne({
    guildId: interaction.guildId,
    messageId: interaction.message.id,
  }).lean();
  if (!record) {
    return interaction.reply({ content: 'This stock counter is no longer active.', ephemeral: true });
  }
  await interaction.deferUpdate();
  return refreshCounter(client, record.guildId, record.messageId);
}

async function restoreStockCounters(client) {
  const records = await StockCounter.find({}).lean();
  for (const record of records) activateCounter(client, record);
  logger.info('stock_counters_restored', { count: records.length });
}

function notifyStockChanged() {
  if (!activeCounters.size) return;
  if (pendingRefresh) clearTimeout(pendingRefresh);
  pendingRefresh = setTimeout(() => {
    pendingRefresh = null;
    for (const [guildId, counter] of activeCounters) {
      refreshCounter(counter.client, guildId, counter.messageId);
    }
  }, 250);
  pendingRefresh.unref();
}

module.exports = {
  REFRESH_INTERVAL_MS,
  buildStockCounterPayload,
  publishStockCounter,
  handleRefresh,
  restoreStockCounters,
  notifyStockChanged,
};