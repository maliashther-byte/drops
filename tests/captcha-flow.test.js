const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCaptchaCompletedPayload } = require('../key-drop-bot/handlers/dropEngine');

test('completed CAPTCHA payload keeps its image and becomes a green completion embed', () => {
  const payload = buildCaptchaCompletedPayload({
    messageRef: {
      attachments: new Map([['attachment-1', { id: 'attachment-1', name: 'captcha.png' }]]),
    },
  });

  assert.equal(payload.embeds[0].data.color, 0x57F287);
  assert.equal(payload.embeds[0].data.title, 'CAPTCHA completed');
  assert.equal(payload.embeds[0].data.image.url, 'attachment://captcha.png');
  assert.deepEqual(payload.attachments, [{ id: 'attachment-1' }]);
  assert.deepEqual(payload.components, []);
});