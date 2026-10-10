'use strict';

const DropUsage = require('../schemas/DropUsage');
const User = require('../schemas/User');

async function resetCooldowns(userId, guildId) {
  const [usage, legacy] = await Promise.all([
    DropUsage.deleteMany({ userId, guildId }),
    User.updateOne(
      { userId, guildId },
      { $set: { dayKey: null, dropsToday: 0, lastDropAt: null } }
    ),
  ]);
  return { productAndButtonRecords: usage.deletedCount, legacyRecords: legacy.matchedCount };
}

module.exports = { resetCooldowns };
