const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const stockClientSource = fs.readFileSync(
  path.join(__dirname, '../key-drop-bot/dashboard/public/stock.js'),
  'utf8'
);
const stockHtml = fs.readFileSync(
  path.join(__dirname, '../key-drop-bot/dashboard/public/stock.html'),
  'utf8'
);

test('public stock page refreshes on load, manually, and every ten seconds', async () => {
  const elements = new Map();
  const intervals = [];
  let refreshClick;
  let requests = 0;
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        textContent: '',
        innerHTML: '',
        disabled: false,
        addEventListener(type, callback) {
          if (selector === '#refresh' && type === 'click') refreshClick = callback;
        },
      });
    }
    return elements.get(selector);
  };
  const context = {
    document: { querySelector: element },
    fetch: async () => {
      requests += 1;
      return {
        ok: true,
        json: async () => ({
          updatedAt: '2026-10-07T12:00:00.000Z',
          totals: { available: 3, claimed: 2 },
          categories: [{ name: '<discord>', dropType: 'key', available: 3, claimed: 2 }],
        }),
      };
    },
    setInterval(callback, delay) { intervals.push({ callback, delay }); },
  };

  vm.runInNewContext(stockClientSource, context, { filename: 'stock.js' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(intervals[0].delay, 10_000);
  assert.match(element('#stock-rows').innerHTML, /&lt;discord&gt;/);
  assert.equal(element('#available-total').textContent, '3');

  await refreshClick();
  assert.equal(requests, 2);
});

test('public stock page places manual refresh after its counts table', () => {
  assert.ok(stockHtml.indexOf('id="stock-rows"') < stockHtml.indexOf('id="refresh"'));
});