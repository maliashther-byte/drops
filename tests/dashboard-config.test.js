const test = require('node:test');
const assert = require('node:assert/strict');

const { applyConfiguration, prioritizeConfiguredGuilds, getUserGuilds } = require('../key-drop-bot/dashboard/server');

function createConfig() {
  return {
    categories: [{ name: 'discord' }],
    dropChannels: [],
    dropChannelIds: [],
    dropProducts: [],
    tiers: new Map(),
    embedStyle: { color: '#5865F2', title: 'Drops', footer: '' },
    getTier() { return null; },
  };
}

function createDiscordGuild() {
  return {
    channels: {
      cache: new Map([
        ['channel-a', { type: 0 }],
        ['channel-b', { type: 0 }],
      ]),
    },
    roles: { cache: new Map() },
  };
}

function product(commandName = 'discord') {
  return {
    name: 'Discord',
    commandName,
    category: 'discord',
    embedColor: '#5865F2',
    dailyLimit: null,
    cooldownMinutes: null,
    quantities: {},
    cooldowns: {},
  };
}

test('dashboard settings bind each generator to exactly one channel', () => {
  const doc = createConfig();
  applyConfiguration(doc, {
    channels: [{ channelId: 'channel-a', prefix: '!discord' }],
    products: [{ ...product(), description: 'May include service availability information.' }],
  }, createDiscordGuild());

  assert.equal(doc.dropChannelIds[0], 'channel-a');
  assert.equal(doc.dropChannels[0].prefix, '!discord');
  assert.equal(doc.dropChannels[0].tierSettings.get('free').challengeEveryClaims, 3);
  assert.equal(doc.dropProducts[0].commandName, 'discord');
  assert.equal(doc.dropProducts[0].description, 'May include service availability information.');
});

test('dashboard rejects generator descriptions longer than the Discord embed limit', () => {
  assert.throws(() => applyConfiguration(createConfig(), {
    channels: [{ channelId: 'channel-a', prefix: '!discord' }],
    products: [{ ...product(), description: 'x'.repeat(851) }],
  }, createDiscordGuild()), /Generator descriptions can be up to 850 characters/);
});

test('dashboard rejects generators without a unique assigned channel', () => {
  const doc = createConfig();
  doc.dropProducts = [product()];

  assert.throws(() => applyConfiguration(doc, {
    channels: [{ channelId: 'channel-a', prefix: '!drop' }],
  }, createDiscordGuild()), /Assign !discord to exactly one drop channel/);

  assert.throws(() => applyConfiguration(createConfig(), {
    channels: [
      { channelId: 'channel-a', prefix: '!discord' },
      { channelId: 'channel-b', prefix: '!discord' },
    ],
    products: [product()],
  }, createDiscordGuild()), /Assign !discord to exactly one drop channel/);
});

test('dashboard accepts per-tier CAPTCHA intervals up to 20 and rejects values outside the range', () => {
  const configured = createConfig();
  applyConfiguration(configured, {
    channels: [{
      channelId: 'channel-a',
      prefix: '!drop',
      tierSettings: { free: { challengeEveryClaims: 20 } },
    }],
  }, createDiscordGuild());
  assert.equal(configured.dropChannels[0].tierSettings.get('free').challengeEveryClaims, 20);

  assert.throws(() => applyConfiguration(createConfig(), {
    channels: [{
      channelId: 'channel-a',
      prefix: '!drop',
      tierSettings: { free: { challengeEveryClaims: 0 } },
    }],
  }, createDiscordGuild()), /free CAPTCHA interval must be between 1 and 20/);

  assert.throws(() => applyConfiguration(createConfig(), {
    channels: [{
      channelId: 'channel-a',
      prefix: '!drop',
      tierSettings: { free: { challengeEveryClaims: 21 } },
    }],
  }, createDiscordGuild()), /free CAPTCHA interval must be between 1 and 20/);
});

test('dashboard saves custom button embed settings and per-tier button limits', () => {
  const doc = createConfig();
  applyConfiguration(doc, {
    channels: [{
      channelId: 'channel-a',
      prefix: '!discord',
      tierSettings: {
        free: {
          challengeEveryClaims: 7,
          buttonDailyLimit: 12,
          buttonCooldownMinutes: 45,
        },
      },
    }],
    products: [{
      ...product(),
      buttonTitle: 'Claim a Discord key',
      buttonDescription: 'Press to receive a key in DMs.',
      buttonLabel: 'Claim key',
      buttonImageUrl: 'https://example.com/key.png',
    }],
  }, createDiscordGuild());

  assert.deepEqual(
    (({ buttonDailyLimit, buttonCooldownMinutes }) => ({ buttonDailyLimit, buttonCooldownMinutes }))(doc.dropChannels[0].tierSettings.get('free')),
    { buttonDailyLimit: 12, buttonCooldownMinutes: 45 }
  );
  assert.equal(doc.dropProducts[0].buttonTitle, 'Claim a Discord key');
  assert.equal(doc.dropProducts[0].buttonDescription, 'Press to receive a key in DMs.');
  assert.equal(doc.dropProducts[0].buttonLabel, 'Claim key');
  assert.equal(doc.dropProducts[0].buttonImageUrl, 'https://example.com/key.png');
});

test('dashboard rejects invalid button limits and non-HTTPS embed images', () => {
  assert.throws(() => applyConfiguration(createConfig(), {
    channels: [{
      channelId: 'channel-a',
      prefix: '!discord',
      tierSettings: { free: { buttonDailyLimit: 0 } },
    }],
  }, createDiscordGuild()), /free button daily limit must be between 1 and 1000/);

  assert.throws(() => applyConfiguration(createConfig(), {
    channels: [{ channelId: 'channel-a', prefix: '!discord' }],
    products: [{ ...product(), buttonImageUrl: 'http://example.com/key.png' }],
  }, createDiscordGuild()), /Button embed image URL must be a valid HTTPS URL/);
});

test('dashboard stores server credit rules and generator claim costs', () => {
  const doc = createConfig();
  applyConfiguration(doc, {
    channels: [{ channelId: 'channel-a', prefix: '!discord' }],
    products: [{ ...product(), creditCost: 125 }],
    creditSettings: {
      startingBalance: 10,
      dailyEnabled: true,
      dailyAmounts: Object.fromEntries(['free', 'bronze', 'silver', 'gold', 'diamond'].map((tier) => [tier, 50])),
      dailyCooldownHours: 24,
      messageEnabled: true,
      messageCredits: 2,
      messageCooldownMinutes: 60,
      messageDailyCap: 10,
      messageChannelIds: ['channel-b'],
      messageEligibleTiers: ['free', 'bronze'],
      aiSafetyEnabled: false,
      invitesEnabled: false,
      inviteCredits: 300,
      inviteMemberAgeHours: 1,
    },
  }, createDiscordGuild());

  assert.equal(doc.dropProducts[0].creditCost, 125);
  assert.equal(doc.creditSettings.startingBalance, 10);
  assert.equal(doc.creditSettings.dailyAmounts.get('free'), 50);
  assert.deepEqual(doc.creditSettings.messageChannelIds, ['channel-b']);
  assert.deepEqual(doc.creditSettings.messageEligibleTiers, ['free', 'bronze']);
});

test('dashboard rejects message rewards larger than their daily cap', () => {
  assert.throws(() => applyConfiguration(createConfig(), {
    creditSettings: {
      startingBalance: 0,
      dailyEnabled: false,
      dailyAmounts: Object.fromEntries(['free', 'bronze', 'silver', 'gold', 'diamond'].map((tier) => [tier, 50])),
      dailyCooldownHours: 24,
      messageEnabled: true,
      messageCredits: 11,
      messageCooldownMinutes: 60,
      messageDailyCap: 10,
      messageChannelIds: ['channel-b'],
      messageEligibleTiers: ['free'],
      aiSafetyEnabled: false,
      invitesEnabled: false,
      inviteCredits: 300,
      inviteMemberAgeHours: 1,
    },
  }, createDiscordGuild()), /message reward cannot exceed its daily cap/);
});

test('dashboard lists existing configured servers before empty servers', () => {
  const result = prioritizeConfiguredGuilds([
    { id: 'empty', name: 'Empty server' },
    { id: 'configured', name: 'Configured server' },
  ], [{
    guildId: 'configured',
    setupCompletedAt: new Date('2026-01-01'),
    dropChannels: [{ channelId: 'channel-a' }, { channelId: 'channel-b' }],
    dropProducts: [{ name: 'Discord' }],
  }]);

  assert.equal(result[0].id, 'configured');
  assert.equal(result[0].configured, true);
  assert.equal(result[0].channels, 2);
  assert.equal(result[0].generators, 1);
  assert.equal(result[1].configured, false);
});

test('dashboard fetches Discord server permissions once per session and coalesces concurrent requests', async (t) => {
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, json: async () => [{ id: 'guild-1' }] };
  };
  t.after(() => { global.fetch = originalFetch; });
  const session = { accessToken: 'test-token', accessTokenExpiresAt: Date.now() + 600_000 };

  const [first, concurrent] = await Promise.all([getUserGuilds(session), getUserGuilds(session)]);
  const cached = await getUserGuilds(session);

  assert.equal(requestCount, 1);
  assert.deepEqual(first, [{ id: 'guild-1' }]);
  assert.deepEqual(concurrent, first);
  assert.deepEqual(cached, first);
});

test('dashboard reports Discord rate limits with a retry delay', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ retry_after: 4, message: 'You are being rate limited.' }),
  });
  t.after(() => { global.fetch = originalFetch; });
  const session = { accessToken: 'test-token', accessTokenExpiresAt: Date.now() + 600_000 };

  await assert.rejects(getUserGuilds(session), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.retryAfter, 4);
    assert.match(error.message, /Wait 4 seconds/);
    assert.equal(error.expose, true);
    return true;
  });
});
