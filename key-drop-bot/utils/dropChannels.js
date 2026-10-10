'use strict';

function isConfiguredDropChannel(guildConfig, channelId) {
  return Boolean(guildConfig?.dropChannels?.some((entry) => entry.channelId === channelId));
}

module.exports = { isConfiguredDropChannel };