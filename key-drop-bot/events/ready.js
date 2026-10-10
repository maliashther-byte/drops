'use strict';

const { ActivityType } = require('discord.js');
const logger = require('../utils/logger');
const { processExpiredTierGrants } = require('../handlers/tierGrants');
const { cleanupLegacyProductMenus } = require('../commands/dropconfig');
const { startExpiryWorker } = require('../commands/event');
const { startCooldownRewardExpiryWorker } = require('../handlers/cooldownRewards');
const { restoreStockCounters } = require('../utils/stockCounter');
const { loadGuildInviteSnapshots } = require('../utils/inviteTracker');
const { startAiSafetyMonitor } = require('../utils/aiSafetyMonitor');

module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    logger.info('bot_ready', { tag: client.user.tag, guilds: client.guilds.cache.size });
    client.user.setPresence({
      activities: [{ name: `!drop | ${client.guilds.cache.size} servers`, type: ActivityType.Watching }],
      status: 'online',
    });
    const processExpirations = () => processExpiredTierGrants(client).catch((err) => {
      logger.error('timed_tier_expiry_sweep_failed', { error: err.message });
    });
    processExpirations();
    setInterval(processExpirations, 60_000).unref();
    startExpiryWorker(client);
    startCooldownRewardExpiryWorker();
    restoreStockCounters(client).catch((err) => {
      logger.error('stock_counters_restore_failed', { error: err.message });
    });
    loadGuildInviteSnapshots(client).catch((err) => {
      logger.error('invite_snapshots_restore_failed', { error: err.message });
    });
    startAiSafetyMonitor();
    cleanupLegacyProductMenus(client).catch((err) => {
      logger.error('legacy_drop_menu_sweep_failed', { error: err.message });
    });
  },
};
