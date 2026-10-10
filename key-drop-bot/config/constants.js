'use strict';

/**
 * Default values written into a Guild document the first time /setup runs
 * for a server. Admins override all of this through the wizard; nothing
 * here is hardcoded into drop logic — the handlers always read from the
 * guild's stored config, never from this file directly, except as the
 * seed for new guilds.
 */

const TIER_NAMES = ['free', 'bronze', 'silver', 'gold', 'diamond'];
const DEFAULT_SECURE_ITEMS_PER_CLICK = { free: 1, bronze: 2, silver: 3, gold: 5, diamond: 0 };

const DEFAULT_TIERS = {
  free: {
    label: 'Free',
    roleId: null,
    dailyLimit: 1,
    cooldownMinutes: 60,
    price: 0,
    description: 'Entry-level access.',
    secureItemsPerClick: 1,
    categories: [],
  },
  bronze: {
    label: 'Bronze',
    roleId: null,
    dailyLimit: 3,
    cooldownMinutes: 30,
    price: 2.99,
    description: 'A little more access and faster drops.',
    secureItemsPerClick: 2,
    categories: [],
  },
  silver: {
    label: 'Silver',
    roleId: null,
    dailyLimit: 7,
    cooldownMinutes: 15,
    price: 6.99,
    description: 'More daily drops and faster redemption.',
    secureItemsPerClick: 3,
    categories: [],
  },
  gold: {
    label: 'Gold',
    roleId: null,
    dailyLimit: 12,
    cooldownMinutes: 10,
    price: 12.99,
    description: 'High daily limits and bulk redemption.',
    secureItemsPerClick: 5,
    categories: [],
  },
  diamond: {
    label: 'Diamond',
    roleId: null,
    dailyLimit: 20,
    cooldownMinutes: 5,
    price: 24.99,
    description: 'Maximum access with automatic secure removal.',
    secureItemsPerClick: 0,
    categories: [],
  },
};

// Shared category types are portable across servers and delivered by DM.
const DROP_TYPES = ['key', 'link', 'cooldown-refresh'];

const DEFAULT_EMBED_STYLE = {
  color: '#5865F2',
  title: 'Key Drop',
  footer: 'Powered by Key Drop Bot',
  thumbnailUrl: null,
  imageUrl: null,
};

const QUIZ_TIME_LIMIT_MS = 20_000;

module.exports = {
  TIER_NAMES,
  DEFAULT_SECURE_ITEMS_PER_CLICK,
  DEFAULT_TIERS,
  DROP_TYPES,
  DEFAULT_EMBED_STYLE,
  QUIZ_TIME_LIMIT_MS,
};
