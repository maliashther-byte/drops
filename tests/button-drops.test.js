'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildButtonDropPayload } = require('../key-drop-bot/utils/buttonDrops');
const dropconfigCommand = require('../key-drop-bot/commands/dropconfig');
const dropbuttonCommand = require('../key-drop-bot/commands/dropbutton');
const dropbuttonlimitsCommand = require('../key-drop-bot/commands/dropbuttonlimits');
const { resolveProductDropRules } = require('../key-drop-bot/handlers/dropEngine');

test('button drop slash commands preserve the original /dropconfig panel command', () => {
  assert.equal(dropconfigCommand.data.toJSON().options.length, 0);
  assert.equal(dropbuttonCommand.data.name, 'dropbutton');
  assert.equal(dropbuttonlimitsCommand.data.name, 'dropbuttonlimits');
});

test('button-drop embed includes custom content, image, and a generator-bound claim button', () => {
  const payload = buildButtonDropPayload({
    name: 'Discord',
    commandName: 'discord',
    embedColor: '#5865F2',
    buttonTitle: 'Get a Discord key',
    buttonDescription: 'Press below to receive your reward.',
    buttonLabel: 'Claim key',
    buttonImageUrl: 'https://example.com/key.png',
  });

  assert.equal(payload.embeds[0].data.title, 'Get a Discord key');
  assert.equal(payload.embeds[0].data.description, 'Press below to receive your reward.');
  assert.equal(payload.embeds[0].data.image.url, 'https://example.com/key.png');
  assert.equal(payload.components[0].components[0].data.custom_id, 'drop-button:claim:discord');
  assert.equal(payload.components[0].components[0].data.label, 'Claim key');
});

test('button-drop embed uses safe generator defaults when optional copy is blank', () => {
  const payload = buildButtonDropPayload({
    name: 'Discord',
    commandName: 'discord',
  });

  assert.equal(payload.embeds[0].data.title, 'Discord');
  assert.match(payload.embeds[0].data.description, /claim \*\*Discord\*\*/);
  assert.equal(payload.components[0].components[0].data.label, 'Claim');
});

test('button claims get their own cooldown counter and generator-specific limits', () => {
  const base = {
    product: { name: 'Discord', commandName: 'discord', dailyLimit: null, cooldownMinutes: null },
    mode: 'button',
    settings: { buttonDailyLimit: 8, buttonCooldownMinutes: 30, challengeEveryClaims: 7 },
    tierConfig: { dailyLimit: 4, cooldownMinutes: 60 },
    tierName: 'free',
    channelId: 'channel-a',
  };

  assert.deepEqual(resolveProductDropRules(base), {
    dailyLimit: 8,
    cooldownMinutes: 30,
    challengeEveryClaims: 7,
    usageChannelId: 'button-discord',
  });
  assert.equal(resolveProductDropRules({
    ...base,
    product: { ...base.product, dailyLimit: 0, cooldownMinutes: 12 },
  }).dailyLimit, null);
  assert.equal(resolveProductDropRules({
    ...base,
    product: { ...base.product, dailyLimit: 15 },
  }).dailyLimit, 15);
});
