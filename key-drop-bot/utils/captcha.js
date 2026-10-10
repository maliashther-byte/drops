'use strict';

const { randomInt } = require('node:crypto');
const { createCanvas } = require('@napi-rs/canvas');

const CAPTCHA_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createCaptcha() {
  const code = Array.from({ length: 6 }, () =>
    CAPTCHA_CHARACTERS[randomInt(CAPTCHA_CHARACTERS.length)]
  ).join('');
  const canvas = createCanvas(320, 120);
  const context = canvas.getContext('2d');

  context.fillStyle = '#f3f6fa';
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < 90; index += 1) {
    context.fillStyle = `rgba(35, 55, 80, ${randomInt(8, 30) / 100})`;
    context.beginPath();
    context.arc(randomInt(canvas.width), randomInt(canvas.height), randomInt(1, 3), 0, Math.PI * 2);
    context.fill();
  }

  for (let index = 0; index < 7; index += 1) {
    context.strokeStyle = `rgba(31, 78, 121, ${randomInt(15, 40) / 100})`;
    context.lineWidth = randomInt(1, 3);
    context.beginPath();
    context.moveTo(randomInt(canvas.width), randomInt(canvas.height));
    context.bezierCurveTo(
      randomInt(canvas.width), randomInt(canvas.height),
      randomInt(canvas.width), randomInt(canvas.height),
      randomInt(canvas.width), randomInt(canvas.height)
    );
    context.stroke();
  }

  code.split('').forEach((character, index) => {
    context.save();
    context.translate(34 + index * 50, randomInt(68, 88));
    context.rotate((randomInt(0, 100) - 50) / 220);
    context.font = `bold ${randomInt(37, 47)}px sans-serif`;
    context.lineWidth = 1;
    context.strokeStyle = '#18324d';
    context.fillStyle = ['#164e63', '#9a3412', '#166534', '#1e3a8a'][index % 4];
    context.strokeText(character, 0, 0);
    context.fillText(character, 0, 0);
    context.restore();
  });

  return { code, image: canvas.toBuffer('image/png') };
}

module.exports = { createCaptcha };