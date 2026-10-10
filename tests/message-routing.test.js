const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isConfiguredDropChannel,
  findProductCommandForChannel,
} = require('../key-drop-bot/events/messageCreate');
const { shouldSendPublicProductClaim } = require('../key-drop-bot/handlers/dropEngine');
const { createCaptcha } = require('../key-drop-bot/utils/captcha');

test('prefix claims are gated to configured drop channels', () => {
  const guildDoc = { dropChannels: [{ channelId: 'abc123' }] };
  assert.equal(isConfiguredDropChannel(guildDoc, 'abc123'), true);
  assert.equal(isConfiguredDropChannel(guildDoc, 'zzz999'), false);
});

test('product commands only work in their assigned channel', () => {
  const guildDoc = {
    dropChannels: [
      { channelId: 'unblocked-channel', prefix: '!unblocked' },
      { channelId: 'discord-channel', prefix: '!discord' },
    ],
    dropProducts: [
      { name: 'Unblocked', commandName: 'unblocked' },
      { name: 'Discord', commandName: 'discord' },
    ],
  };

  assert.equal(findProductCommandForChannel(guildDoc, 'discord-channel', 'discord')?.name, 'Discord');
  assert.equal(findProductCommandForChannel(guildDoc, 'unblocked-channel', 'discord'), null);
  assert.equal(findProductCommandForChannel(guildDoc, 'unconfigured-channel', 'discord'), null);
});

test('duplicate product channel assignments fail closed', () => {
  const guildDoc = {
    dropChannels: [
      { channelId: 'first-channel', prefix: '!discord' },
      { channelId: 'second-channel', prefix: '!discord' },
    ],
    dropProducts: [{ name: 'Discord', commandName: 'discord' }],
  };

  assert.equal(findProductCommandForChannel(guildDoc, 'first-channel', 'discord'), null);
  assert.equal(findProductCommandForChannel(guildDoc, 'second-channel', 'discord'), null);
});

test('CAPTCHA generator returns a six-character code and PNG image', () => {
  const { code, image } = createCaptcha();
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('prefix product claims do not post a second public claim message', () => {
  assert.equal(shouldSendPublicProductClaim({ mode: 'prefix', channel: { id: 'x' } }), false);
  assert.equal(shouldSendPublicProductClaim({ mode: 'button', channel: { id: 'x' } }), true);
});
