'use strict';

const { Schema, model } = require('mongoose');
const { DEFAULT_TIERS, DEFAULT_EMBED_STYLE, DROP_TYPES } = require('../config/constants');
const GlobalCategory = require('./GlobalCategory');

const CategorySchema = new Schema(
  {
    name: { type: String, required: true },
    dropType: { type: String, enum: DROP_TYPES, default: 'key' },
    description: { type: String, default: '' },
  },
  { _id: false }
);

const TierConfigSchema = new Schema(
  {
    label: { type: String, required: true },
    roleId: { type: String, default: null },
    dailyLimit: { type: Number, required: true, min: 0 },
    cooldownMinutes: { type: Number, required: true, min: 0 },
    price: { type: Number, required: true, min: 0 },
    description: { type: String, default: '', maxlength: 850 },
    secureItemsPerClick: { type: Number, min: 0, max: 25 },
    trialEnabled: { type: Boolean, default: false },
    trialDurationHours: { type: Number, min: 1, max: 8760, default: 24 },
    categories: { type: [String], default: [] },
  },
  { _id: false }
);

const DropProductSchema = new Schema(
  {
    name: { type: String, required: true },
    commandName: { type: String, trim: true, lowercase: true, match: /^[a-z0-9][a-z0-9_-]{1,31}$/ },
    category: { type: String, required: true },
    description: { type: String, default: '', maxlength: 850 },
    embedColor: { type: String, match: /^#[0-9A-Fa-f]{6}$/ },
    dailyLimit: { type: Number, min: 0, max: 1000, default: null },
    creditCost: { type: Number, min: 0, max: 1_000_000, default: 0 },
    buttonChannelId: { type: String, default: null },
    buttonMessageId: { type: String, default: null },
    buttonTitle: { type: String, default: '', maxlength: 256 },
    buttonDescription: { type: String, default: '', maxlength: 4000 },
    buttonLabel: { type: String, default: 'Claim', maxlength: 80 },
    buttonImageUrl: { type: String, default: null },
    cooldowns: {
      type: Map,
      of: { type: Number, min: 0, max: 10080 },
      default: () => new Map(),
    },
    cooldownMinutes: { type: Number, min: 0, max: 10080, default: null },
    quantities: {
      type: Map,
      of: { type: Number, min: 0, max: 500 },
      default: () => new Map(),
    },
  },
  { _id: false }
);

const TierDropSettingsSchema = new Schema(
  {
    buttonDailyLimit: { type: Number, min: 1, max: 1000, default: 4 },
    buttonCooldownMinutes: { type: Number, min: 0, max: 10080, default: 0 },
    prefixCooldownMinutes: { type: Number, min: 0, max: 10080, default: 0 },
    challengeEveryClaims: { type: Number, min: 1, max: 20, default: 3 },
  },
  { _id: false }
);

const DropChannelSchema = new Schema(
  {
    channelId: { type: String, required: true },
    prefix: { type: String, default: '!drop' },
    menuMessageId: { type: String, default: null },
    tierSettings: {
      type: Map,
      of: TierDropSettingsSchema,
      default: () => new Map(['free', 'bronze', 'silver', 'gold', 'diamond'].map((name) => [
        name,
        { buttonDailyLimit: 4, buttonCooldownMinutes: 0, prefixCooldownMinutes: 0, challengeEveryClaims: 3 },
      ])),
    },
  },
  { _id: false }
);

const PublishedShopSchema = new Schema(
  {
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
  },
  { _id: false }
);

const CreditSettingsSchema = new Schema(
  {
    startingBalance: { type: Number, min: 0, max: 1_000_000, default: 0 },
    dailyEnabled: { type: Boolean, default: false },
    dailyAmounts: {
      type: Map,
      of: { type: Number, min: 0, max: 1_000_000 },
      default: () => new Map(['free', 'bronze', 'silver', 'gold', 'diamond'].map((tier) => [tier, 50])),
    },
    dailyCooldownHours: { type: Number, min: 1, max: 720, default: 24 },
    messageEnabled: { type: Boolean, default: false },
    messageCredits: { type: Number, min: 1, max: 100_000, default: 1 },
    messageCooldownMinutes: { type: Number, min: 1, max: 10080, default: 60 },
    messageDailyCap: { type: Number, min: 1, max: 1_000_000, default: 10 },
    messageChannelIds: { type: [String], default: [] },
    messageEligibleTiers: {
      type: [String],
      enum: ['free', 'bronze', 'silver', 'gold', 'diamond'],
      default: () => ['free', 'bronze', 'silver', 'gold', 'diamond'],
    },
    aiSafetyEnabled: { type: Boolean, default: false },
    invitesEnabled: { type: Boolean, default: false },
    inviteCredits: { type: Number, min: 1, max: 1_000_000, default: 300 },
    inviteMemberAgeHours: { type: Number, min: 1, max: 720, default: 1 },
  },
  { _id: false }
);

const EmbedStyleSchema = new Schema(
  {
    color: { type: String, default: DEFAULT_EMBED_STYLE.color },
    title: { type: String, default: DEFAULT_EMBED_STYLE.title },
    footer: { type: String, default: DEFAULT_EMBED_STYLE.footer },
    thumbnailUrl: { type: String, default: null },
    imageUrl: { type: String, default: null },
  },
  { _id: false }
);

const GuildSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },

    dropChannelIds: { type: [String], default: [] },
    logChannelId: { type: String, default: null },
    lootBoxCount: { type: Number, default: 0 },

    categories: { type: [CategorySchema], default: [] },
    dropProducts: { type: [DropProductSchema], default: [] },
    dropChannels: { type: [DropChannelSchema], default: [] },
    creditSettings: { type: CreditSettingsSchema, default: () => ({}) },
    publishedShops: { type: [PublishedShopSchema], default: [] },

    tiers: {
      type: Map,
      of: TierConfigSchema,
      default: () => new Map(Object.entries(DEFAULT_TIERS)),
    },

    embedStyle: { type: EmbedStyleSchema, default: () => ({}) },

    quizEnabledByDefault: { type: Boolean, default: false },
    aiCategorizationEnabled: { type: Boolean, default: true },

    setupCompletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

GuildSchema.post('save', function onGuildConfigSaved(doc) {
  require('../utils/liveDeploy').queueGuildSync(doc.guildId);
});

GuildSchema.statics.getOrCreate = async function getOrCreate(guildId, retryCount = 0) {
  let doc = await this.findOne({ guildId });
  if (!doc) {
    doc = await this.create({ guildId });
  }

  const globalCategories = await GlobalCategory.find({}).sort({ name: 1 }).lean();
  const activeCategoryNames = globalCategories.map((category) => category.name);
  const activeCategorySet = new Set(activeCategoryNames);
  const categoriesChanged = JSON.stringify(doc.categories.map((category) => ({
    name: category.name,
    dropType: category.dropType,
    description: category.description,
  }))) !== JSON.stringify(globalCategories.map((category) => ({
    name: category.name,
    dropType: category.dropType,
    description: category.description || '',
  })));
  if (categoriesChanged) {
    doc.categories = globalCategories.map(({ name, dropType, description }) => ({ name, dropType, description: description || '' }));
  }

  let configChanged = categoriesChanged;
  const productNames = new Set();
  const uniqueProducts = doc.dropProducts.filter((product) => {
    const productName = product.commandName || product.name;
    if (productNames.has(productName)) return false;
    productNames.add(productName);
    return true;
  });
  if (uniqueProducts.length !== doc.dropProducts.length) {
    doc.dropProducts = uniqueProducts;
    configChanged = true;
  }

  if (doc.dropChannels.length && !doc.dropChannelIds.length) {
    doc.dropChannelIds = [...new Set(doc.dropChannels.map((channel) => channel.channelId))];
    configChanged = true;
  }

  for (const [tierName, tier] of doc.tiers) {
    const currentCategories = tier.categories || [];
    const nextCategories = [...activeCategorySet];
    if (currentCategories.length !== nextCategories.length || currentCategories.some((name, index) => name !== nextCategories[index])) {
      tier.categories = nextCategories;
      doc.tiers.set(tierName, tier);
      configChanged = true;
    }
  }

  if (configChanged) {
    try {
      await doc.save();
    } catch (err) {
      if (err.name === 'VersionError' && retryCount < 2) {
        return this.getOrCreate(guildId, retryCount + 1);
      }
      throw err;
    }
  }

  return doc;
};

GuildSchema.methods.getCategory = function getCategory(name) {
  return this.categories.find((c) => c.name === name) || null;
};

GuildSchema.methods.getTier = function getTier(tierName) {
  return this.tiers.get(tierName) || null;
};

module.exports = model('Guild', GuildSchema);
