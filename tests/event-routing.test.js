const test = require('node:test');
const assert = require('node:assert/strict');

const { isConfiguredDropChannel } = require('../key-drop-bot/utils/dropChannels');
const { data } = require('../key-drop-bot/commands/event');

test('timed events only target channels where drop commands are accepted', () => {
  const guildConfig = {
    dropChannels: [{ channelId: 'drops-1' }, { channelId: 'drops-2' }],
  };

  assert.equal(isConfiguredDropChannel(guildConfig, 'drops-1'), true);
  assert.equal(isConfiguredDropChannel(guildConfig, 'general'), false);
});

test('/event allows selecting a configured drop channel', () => {
  const channelOption = data.toJSON().options.find((option) => option.name === 'channel');
  assert.equal(channelOption.type, 7);
  assert.equal(channelOption.required, false);
});