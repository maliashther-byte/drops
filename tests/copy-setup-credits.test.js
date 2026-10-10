const test = require('node:test');
const assert = require('node:assert/strict');

const Guild = require('../key-drop-bot/schemas/Guild');
const { copySetupToGuild } = require('../key-drop-bot/commands/copysetup');

test('copying credit rules also copies matching product costs but leaves target publications alone', async (t) => {
  const sourceDoc = {
    creditSettings: {
      startingBalance: 25,
      dailyEnabled: true,
      dailyAmounts: new Map([['free', 50]]),
      dailyCooldownHours: 24,
      messageEnabled: false,
      messageCredits: 1,
      messageCooldownMinutes: 60,
      messageDailyCap: 10,
      messageChannelIds: [],
      messageEligibleTiers: ['free'],
      invitesEnabled: false,
      inviteCredits: 300,
      inviteMemberAgeHours: 1,
    },
    dropProducts: [{ commandName: 'discord', creditCost: 75 }],
  };
  const targetDoc = {
    dropProducts: [{ commandName: 'discord', creditCost: 0 }],
    publishedShops: [{ channelId: 'target-channel', messageId: 'target-message' }],
    save: async () => {},
  };
  const originalGetOrCreate = Guild.getOrCreate;
  Guild.getOrCreate = async (guildId) => guildId === '12345678901234567' ? sourceDoc : targetDoc;
  t.after(() => { Guild.getOrCreate = originalGetOrCreate; });

  const targetGuild = {
    id: '22345678901234567',
    members: { me: { permissions: { has: () => true } } },
  };
  const sourceGuild = { channels: { fetch: async () => null } };
  await copySetupToGuild({
    client: {},
    targetGuild,
    sourceGuildId: '12345678901234567',
    sourceGuild,
    sections: ['credits'],
  });

  assert.equal(targetDoc.creditSettings.startingBalance, 25);
  assert.equal(targetDoc.dropProducts[0].creditCost, 75);
  assert.deepEqual(targetDoc.publishedShops, [{ channelId: 'target-channel', messageId: 'target-message' }]);
});
