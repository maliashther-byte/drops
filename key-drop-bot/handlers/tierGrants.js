'use strict';

const TierGrant = require('../schemas/TierGrant');
const logger = require('../utils/logger');

const RETRY_DELAY_MS = 250;
const MAX_GRANT_RETRIES = 40;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function addTimedTierRole({ guild, member, tierName, roleId, durationMs }) {
  const key = { guildId: guild.id, userId: member.id, tier: tierName };
  const role = await guild.roles.fetch(roleId);
  if (!role) throw new Error(`Configured ${tierName} tier role ${roleId} no longer exists`);
  const existing = await TierGrant.findOne(key).lean();
  if (member.roles.cache.has(roleId) && !existing) {
    throw new Error(`Member already has the ${tierName} role without a timed grant`);
  }

  let previousGrant = null;
  let grant = null;
  for (let attempt = 0; attempt < MAX_GRANT_RETRIES; attempt += 1) {
    previousGrant = await TierGrant.findOne(key).lean();
    if (previousGrant?.processingExpiry) {
      await delay(RETRY_DELAY_MS);
      continue;
    }
    const now = new Date();
    const base = previousGrant?.expiresAt && previousGrant.expiresAt > now ? previousGrant.expiresAt : now;
    const expiresAt = new Date(base.getTime() + durationMs);
    try {
      grant = await TierGrant.findOneAndUpdate(
        { ...key, ...(previousGrant ? { _id: previousGrant._id, processingExpiry: { $ne: true } } : {}) },
        {
          $set: {
            roleId,
            roleIds: [...new Set([...(previousGrant?.roleIds || []), previousGrant?.roleId, roleId].filter(Boolean))],
            expiresAt,
            processingExpiry: false,
          },
          $setOnInsert: key,
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
    if (grant) break;
  }
  if (!grant) throw new Error('Timed tier expiration is currently being processed; try again shortly');

  try {
    await member.roles.add(role, `Temporary ${tierName} tier reward`);
  } catch (err) {
    if (previousGrant) {
      await TierGrant.updateOne(
        { _id: grant._id, expiresAt: grant.expiresAt },
        {
          $set: {
            expiresAt: previousGrant.expiresAt,
            roleId: previousGrant.roleId,
            roleIds: previousGrant.roleIds || [previousGrant.roleId],
          },
        }
      );
    } else {
      await TierGrant.deleteOne({ _id: grant._id, expiresAt: grant.expiresAt });
    }
    throw err;
  }
  return grant;
}

async function processExpiredTierGrants(client) {
  const now = new Date();
  const expired = await TierGrant.find({ expiresAt: { $lte: now }, processingExpiry: { $ne: true } })
    .limit(100)
    .lean();

  for (const candidate of expired) {
    const grant = await TierGrant.findOneAndUpdate(
      { _id: candidate._id, expiresAt: { $lte: now }, processingExpiry: { $ne: true } },
      { $set: { processingExpiry: true } },
      { new: true }
    );
    if (!grant) continue;

    try {
      const guild = await client.guilds.fetch(grant.guildId);
      const member = await guild.members.fetch(grant.userId).catch(() => null);
      const roleIds = grant.roleIds?.length ? grant.roleIds : [grant.roleId];
      if (member) {
        for (const roleId of roleIds) {
          if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId, `Temporary ${grant.tier} tier expired`);
          }
        }
      }
      await TierGrant.deleteOne({ _id: grant._id, processingExpiry: true });
    } catch (err) {
      logger.error('timed_tier_expiry_failed', {
        guildId: grant.guildId,
        userId: grant.userId,
        tier: grant.tier,
        roleId: grant.roleId,
        error: err.message,
      });
      await TierGrant.updateOne({ _id: grant._id }, { $set: { processingExpiry: false } });
    }
  }
}

module.exports = { addTimedTierRole, processExpiredTierGrants };
