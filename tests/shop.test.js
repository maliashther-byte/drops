const test = require('node:test');
const assert = require('node:assert/strict');

const shop = require('../key-drop-bot/commands/shop');
const shopTrialCommand = require('../key-drop-bot/commands/shoptrial');

function makeGuildDoc() {
  const tiers = new Map(['free', 'bronze', 'silver', 'gold', 'diamond'].map((name) => [name, {
    label: name,
    roleId: name === 'bronze' ? 'bronze-role' : null,
    dailyLimit: 5,
    cooldownMinutes: 30,
    price: name === 'free' ? 0 : 5,
    description: `${name} tier`,
    secureItemsPerClick: 1,
    trialEnabled: name === 'bronze',
    trialDurationHours: 48,
    categories: ['keys'],
  }]));
  return {
    embedStyle: { color: '#5865F2', footer: '' },
    dropChannels: [],
    creditSettings: {
      dailyEnabled: true,
      dailyAmounts: new Map([['free', 50]]),
      dailyCooldownHours: 24,
      messageEnabled: false,
      invitesEnabled: true,
      inviteCredits: 300,
      inviteMemberAgeHours: 1,
    },
    dropProducts: [{
      name: 'Discord keys',
      commandName: 'discord',
      category: 'keys',
      description: 'A Discord product',
      creditCost: 10,
      quantities: new Map([['bronze', 2]]),
      cooldowns: new Map(),
    }],
    getTier(name) { return tiers.get(name); },
  };
}

test('shop includes product details, free earning methods, and one-time trial actions', () => {
  const payload = shop.buildShopPayload(makeGuildDoc(), { name: 'Test server' });
  const customIds = payload.components.flatMap((row) => row.components.map((component) => component.toJSON().custom_id));
  const embed = payload.embeds[0].toJSON();

  assert.ok(customIds.includes('shop:products'));
  assert.ok(customIds.includes('shop:trial:bronze'));
  assert.ok(customIds.includes('shop:daily'));
  assert.ok(customIds.includes('shop:invites'));
  assert.ok(payload.components.every((row) => row.components.length <= 5));
  assert.ok(embed.fields.some((field) => field.name === 'Free ways to earn credits'));
});

test('shop trial slash command exposes a bounded duration and an enabled switch', () => {
  const command = shopTrialCommand.data.toJSON();
  assert.equal(command.name, 'shoptrial');
  assert.equal(command.options.find((option) => option.name === 'enabled').required, true);
  assert.equal(command.options.find((option) => option.name === 'duration_hours').max_value, 8760);
});
