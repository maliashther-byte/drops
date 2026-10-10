const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const dashboardSource = fs.readFileSync(
  path.join(__dirname, '../key-drop-bot/dashboard/public/dashboard.js'),
  'utf8'
);

test('dashboard bootstraps and renders every settings tab', async () => {
  const elements = new Map();
  const tabs = ['overview', 'channels', 'products', 'tiers', 'categories', 'inventory', 'events', 'shop', 'credits', 'ai-builder', 'member-tools', 'appearance', 'options', 'copy']
    .map((tab) => ({ dataset: { tab }, classList: { toggle() {} } }));
  const listeners = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        hidden: ['#signin', '#dashboard', '#account'].includes(selector),
        value: 'guild-1',
        textContent: '',
        innerHTML: '',
        disabled: false,
        classList: { toggle() {} },
        addEventListener() {},
      });
    }
    return elements.get(selector);
  };
  const config = {
    channels: [],
    products: [],
    tiers: Object.fromEntries(['free', 'bronze', 'silver', 'gold', 'diamond'].map((tier) => [tier, {
      label: tier,
      dailyLimit: 1,
      cooldownMinutes: 0,
      price: 0,
      secureItemsPerClick: 1,
      roleId: '',
      description: '',
    }])),
    categories: [{ name: 'discord', dropType: 'key', description: '', available: 1, claimed: 0 }],
    availableChannels: [{ id: 'channel-1', name: 'drops' }],
    availableRoles: [],
    embedStyle: {},
    quizEnabledByDefault: false,
    aiCategorizationEnabled: false,
    logChannelId: '',
    creditSettings: {
      dailyAmounts: { free: 50, bronze: 50, silver: 50, gold: 50, diamond: 50 },
      messageChannelIds: [],
      messageEligibleTiers: ['free', 'bronze', 'silver', 'gold', 'diamond'],
      aiSafetyEnabled: false,
    },
  };
  let resolveConfig;
  const pendingConfig = new Promise((resolve) => { resolveConfig = resolve; });
  const response = (body) => ({ status: 200, ok: true, json: async () => body });
  const context = {
    document: {
      querySelector: element,
      querySelectorAll: (selector) => selector === '.tab' ? tabs : [],
      addEventListener: (type, callback) => listeners.set(type, callback),
    },
    window: { addEventListener() {} },
    URLSearchParams,
    console: { error() {}, warn() {}, log() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async (url) => {
      if (url === '/api/session') return response({ csrfToken: 'test-token', user: { username: 'admin' } });
      if (url === '/api/guilds') return response([
        { id: 'guild-1', name: 'Test server', configured: true, channels: 2, generators: 1 },
      ]);
      if (url === '/api/guilds/guild-1') {
        return pendingConfig;
      }
      if (url.endsWith('/operations')) return response({ categories: [{ name: 'discord', available: 1, claimed: 0 }], archivedCategories: [], events: [] });
      if (url.includes('/credit-stats')) return response({ summary: { walletCount: 0, totalCredits: 0, transactionCount: 0 }, wallet: null, transactions: [] });
      if (url.includes('/ai/conversations')) return response([]);
      if (url.includes('/ai/history')) return response([]);
      if (url.includes('/ai/safety-alerts')) return response({ enabled: false, alerts: [] });
      if (url.includes('/inventory?')) return response({ items: [], offset: 0, limit: 50, total: 0 });
      return response(config);
    },
  };

  vm.runInNewContext(dashboardSource, context, { filename: 'dashboard.js' });
  const click = listeners.get('click');
  for (const tab of tabs.map((entry) => entry.dataset.tab)) {
    click({ target: { closest: () => ({ dataset: { tab } }) } });
    assert.match(element('#panel').innerHTML, /Loading server settings/);
    assert.doesNotMatch(element('#panel').innerHTML, /This section could not load/);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolveConfig(response(config));
  await new Promise((resolve) => setTimeout(resolve, 0));
  click({ target: { closest: () => ({ dataset: { tab: 'overview' } }) } });
  assert.match(element('#panel').innerHTML, /Server overview/);
  assert.equal(element('#signin').hidden, true);
  assert.match(element('#guild-select').innerHTML, /saved setup \(2 channels, 1 generators\)/);

  for (const tab of tabs.map((entry) => entry.dataset.tab)) {
    click({ target: { closest: () => ({ dataset: { tab } }) } });
    assert.ok(element('#panel').innerHTML.length > 0, `${tab} tab should render`);
    assert.doesNotMatch(element('#panel').innerHTML, /This section could not load/);
    assert.equal(element('#save').hidden, !['channels', 'products', 'tiers', 'appearance', 'options', 'credits'].includes(tab));
    if (!element('#save').hidden) assert.match(element('#save').textContent, /^Save /);
  }

});
