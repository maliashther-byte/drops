'use strict';

const Guild = require('../schemas/Guild');
const logger = require('./logger');
const { buildButtonDropPayload } = require('./buttonDrops');

let discordClient = null;
const scheduledSyncs = new Map();

function setDiscordClient(client) {
  discordClient = client;
}

function queueGuildSync(guildId) {
  if (!discordClient) return;
  clearTimeout(scheduledSyncs.get(guildId));
  const timer = setTimeout(() => {
    scheduledSyncs.delete(guildId);
    syncGuildPanels(guildId).catch((error) => {
      logger.error('live_panel_sync_failed', { guildId, error: error.message });
    });
  }, 250);
  timer.unref();
  scheduledSyncs.set(guildId, timer);
}

async function syncGuildPanels(guildId) {
  const guildDoc = await Guild.findOne({ guildId });
  if (!guildDoc) return;
  const guild = discordClient.guilds.cache.get(guildId);
  if (!guild) {
    logger.warn('live_panel_sync_guild_missing', { guildId });
    return;
  }

  for (const product of guildDoc.dropProducts) {
    if (!product.buttonChannelId || !product.buttonMessageId) continue;
    try {
      const channel = await guild.channels.fetch(product.buttonChannelId);
      const message = await channel.messages.fetch(product.buttonMessageId);
      await message.edit(buildButtonDropPayload(product));
    } catch (error) {
      logger.error('live_button_drop_sync_failed', {
        guildId,
        product: product.commandName || product.name,
        channelId: product.buttonChannelId,
        messageId: product.buttonMessageId,
        error: error.message,
      });
    }
  }

  if (!guildDoc.publishedShops.length) return;
  const { buildShopPayload } = require('../commands/shop');
  for (const panel of guildDoc.publishedShops) {
    try {
      const channel = await guild.channels.fetch(panel.channelId);
      const message = await channel.messages.fetch(panel.messageId);
      await message.edit(buildShopPayload(guildDoc, guild));
    } catch (error) {
      logger.error('live_shop_sync_failed', {
        guildId,
        channelId: panel.channelId,
        messageId: panel.messageId,
        error: error.message,
      });
    }
  }
}

module.exports = { setDiscordClient, queueGuildSync, syncGuildPanels };
