'use strict';

const { TIER_NAMES } = require('../config/constants');

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

/**
 * Highest tier the member qualifies for, based on configured tier role
 * IDs. Falls back to 'free' if no tier role is assigned or configured.
 */
function resolveTier(guildDoc, member) {
  const memberRoleIds = new Set(member.roles.cache.map((r) => r.id));
  // Highest tier wins if a member somehow holds multiple tier roles.
  for (let i = TIER_NAMES.length - 1; i >= 0; i -= 1) {
    const tierName = TIER_NAMES[i];
    const tierConfig = guildDoc.getTier(tierName);
    if (tierConfig && tierConfig.roleId && memberRoleIds.has(tierConfig.roleId)) {
      return tierName;
    }
  }
  return 'free';
}

/**
 * Resets the user's daily counter if the stored dayKey is stale, then
 * checks remaining drops and cooldown. Returns { allowed, reason,
 * remainingToday, cooldownRemainingMs }. Does not persist — caller
 * saves the userDoc after a successful claim.
 */
function checkDropEligibility(userDoc, tierConfig) {
  const key = todayKey();
  if (userDoc.dayKey !== key) {
    userDoc.dayKey = key;
    userDoc.dropsToday = 0;
  }

  if (userDoc.dropsToday >= tierConfig.dailyLimit) {
    return {
      allowed: false,
      reason: 'daily_limit',
      remainingToday: 0,
      cooldownRemainingMs: 0,
    };
  }

  if (userDoc.lastDropAt) {
    const cooldownMs = tierConfig.cooldownMinutes * 60_000;
    const elapsed = Date.now() - userDoc.lastDropAt.getTime();
    if (elapsed < cooldownMs) {
      return {
        allowed: false,
        reason: 'cooldown',
        remainingToday: tierConfig.dailyLimit - userDoc.dropsToday,
        cooldownRemainingMs: cooldownMs - elapsed,
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    remainingToday: tierConfig.dailyLimit - userDoc.dropsToday,
    cooldownRemainingMs: 0,
  };
}

function recordDrop(userDoc) {
  userDoc.dropsToday += 1;
  userDoc.lastDropAt = new Date();
  userDoc.totalDropsClaimed += 1;
}

function isAdmin(interactionOrMessageMember) {
  return interactionOrMessageMember.permissions.has('Administrator');
}

module.exports = { todayKey, resolveTier, checkDropEligibility, recordDrop, isAdmin };
