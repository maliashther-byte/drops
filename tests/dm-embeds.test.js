const test = require('node:test');
const assert = require('node:assert/strict');

const { dmItemsEmbeds } = require('../key-drop-bot/utils/embeds');

test('product description is included with delivered items in DMs', () => {
  const [embed] = dmItemsEmbeds({}, {
    category: 'streaming',
    productName: 'Premium Access',
    description: 'Shared access details and limitations.',
    items: [{ dropType: 'link', value: 'https://example.test' }],
  });

  assert.match(embed.data.description, /Shared access details and limitations\./);
});

test('Disney deliveries include the non-guarantee disclaimer', () => {
  const [embed] = dmItemsEmbeds({}, {
    category: 'media-links',
    productName: 'Disney access',
    items: [{ dropType: 'link', value: 'https://example.test' }],
  });

  assert.match(embed.data.description, /Disney items may not work/);
  assert.match(embed.data.description, /We do not guarantee that they will/);
});