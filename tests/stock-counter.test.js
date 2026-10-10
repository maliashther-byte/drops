const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeStock, buildPublicStockPayload } = require('../key-drop-bot/utils/stockSummary');
const { buildStockCounterPayload, REFRESH_INTERVAL_MS } = require('../key-drop-bot/utils/stockCounter');

test('public stock summary counts only active unclaimed and claimed inventory', () => {
  const rows = [
    { _id: { category: 'discord', claimed: false, archived: false }, count: 4 },
    { _id: { category: 'discord', claimed: true, archived: false }, count: 2 },
    { _id: { category: 'discord-deleted', claimed: false, archived: true }, count: 5 },
  ];
  const categories = [{ name: 'discord', dropType: 'key', description: 'Accounts' }];

  const summary = summarizeStock(rows, categories);
  assert.deepEqual(summary.active, [{
    name: 'discord', dropType: 'key', description: 'Accounts', archived: false, available: 4, claimed: 2,
  }]);
  assert.deepEqual(summary.archived, [{
    name: 'discord-deleted', dropType: 'key', description: 'Archived inventory; cannot be claimed.',
    archived: true, available: 0, claimed: 0,
  }]);
});

test('public stock payload exposes counts and category labels but no item values', () => {
  const payload = buildPublicStockPayload([
    { name: 'discord', dropType: 'key', available: 4, claimed: 2, secret: 'never expose' },
  ], new Date('2026-10-07T12:00:00.000Z'));

  assert.deepEqual(payload, {
    updatedAt: '2026-10-07T12:00:00.000Z',
    totals: { available: 4, claimed: 2 },
    categories: [{ name: 'discord', dropType: 'key', available: 4, claimed: 2 }],
  });
  assert.doesNotMatch(JSON.stringify(payload), /never expose/);
});

test('Discord stock counter has a refresh button and ten-second update cadence', () => {
  const payload = buildStockCounterPayload([
    { name: 'discord', available: 8, claimed: 3 },
  ]);
  assert.equal(REFRESH_INTERVAL_MS, 10_000);
  assert.equal(payload.components[0].components[0].data.custom_id, 'stock-counter:refresh');
  assert.match(payload.embeds[0].data.description, /8 available · 3 claimed/);
});