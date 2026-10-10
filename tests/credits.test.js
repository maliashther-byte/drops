const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../key-drop-bot/schemas/User');
const CreditTransaction = require('../key-drop-bot/schemas/CreditTransaction');
const { spendCredits, rewardMessageCredits } = require('../key-drop-bot/utils/credits');

function stub(t, target, key, implementation) {
  const original = target[key];
  target[key] = implementation;
  t.after(() => { target[key] = original; });
}

function guildDoc() {
  return {
    guildId: '12345678901234567',
    creditSettings: {
      startingBalance: 0,
      messageCredits: 2,
      messageCooldownMinutes: 60,
      messageDailyCap: 10,
    },
  };
}

test('credit spending is an atomic sufficient-balance update with an audit transaction', async (t) => {
  const guild = guildDoc();
  let updateFilter;
  let transaction;
  stub(t, User, 'getOrCreate', async () => ({ credits: 8 }));
  stub(t, User, 'findOneAndUpdate', async (filter) => {
    updateFilter = filter;
    return { credits: 3 };
  });
  stub(t, CreditTransaction, 'create', async (entry) => { transaction = entry; });

  const balance = await spendCredits({
    guildDoc: guild,
    userId: '22345678901234567',
    amount: 5,
    reason: 'Generator claim',
  });

  assert.equal(balance, 3);
  assert.equal(updateFilter.credits.$gte, 5);
  assert.equal(transaction.amount, -5);
  assert.equal(transaction.source, 'drop');
});

test('message rewards apply configured cooldown and daily-cap guards atomically', async (t) => {
  const guild = guildDoc();
  let filter;
  let update;
  let transaction;
  const now = new Date();
  stub(t, User, 'getOrCreate', async () => ({
    credits: 4,
    messageCreditDay: now.toISOString().slice(0, 10),
    messageCreditsEarned: 2,
    lastMessageCreditAt: null,
  }));
  stub(t, User, 'findOneAndUpdate', async (query, pipeline) => {
    filter = query;
    update = pipeline;
    return { credits: 6 };
  });
  stub(t, CreditTransaction, 'create', async (entry) => { transaction = entry; });

  const reward = await rewardMessageCredits({ guildDoc: guild, userId: '22345678901234567' });

  assert.equal(reward.amount, 2);
  assert.equal(reward.balance, 6);
  assert.ok(filter.$and);
  assert.equal(update[0].$set.messageCreditsEarned.$cond[1].$add[1], 2);
  assert.equal(transaction.source, 'message');
});
