const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAiChanges } = require('../key-drop-bot/dashboard/server');
const { redactCredentials } = require('../key-drop-bot/utils/gemini');

const current = {
  channels: [
    { channelId: 'channel-a', prefix: '!discord', tierSettings: {} },
    { channelId: 'channel-b', prefix: '!drop', tierSettings: {} },
  ],
  products: [{ commandName: 'discord' }],
  tiers: Object.fromEntries(['free', 'bronze', 'silver', 'gold', 'diamond'].map((tier) => [tier, { roleId: '' }])),
};

test('AI generator proposals bind only to existing channels and clear removed command bindings', () => {
  const result = normalizeAiChanges({
    products: [{
      name: 'New product',
      commandName: 'new-product',
      category: 'keys',
      channelId: 'channel-b',
    }],
  }, current);

  assert.equal(result.channels.find((channel) => channel.channelId === 'channel-a').prefix, '!drop');
  assert.equal(result.channels.find((channel) => channel.channelId === 'channel-b').prefix, '!new-product');
  assert.equal(result.products[0].channelId, undefined);
});

test('AI builder blocks unsupported settings, unknown channels, and role assignment changes', () => {
  assert.throws(() => normalizeAiChanges({ inventory: ['secret'] }, current), /unsupported settings/);
  assert.throws(() => normalizeAiChanges({
    products: [{ commandName: 'new-product', channelId: 'not-a-channel' }],
  }, current), /existing configured drop channels/);
  assert.throws(() => normalizeAiChanges({
    tiers: {
      ...current.tiers,
      bronze: { roleId: 'invented-role' },
    },
  }, current), /cannot change tier role assignments/);
});

test('Gemini request text redacts common credentials and Discord bot tokens', () => {
  const input = 'api_key=AIza' + '123456789012345678901234567890; discord token: abcdefghijklmnopqrst.abcdef.abcdefghijklmnopqrst';
  const result = redactCredentials(input);

  assert.doesNotMatch(result, /AIza123/);
  assert.doesNotMatch(result, /abcdefghijklmnopqrst\.abcdef/);
  assert.match(result, /\[credential redacted\]/);
});
