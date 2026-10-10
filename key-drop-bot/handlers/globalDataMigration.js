'use strict';

const Guild = require('../schemas/Guild');
const Stock = require('../schemas/Stock');
const GlobalCategory = require('../schemas/GlobalCategory');
const GlobalStock = require('../schemas/GlobalStock');
const DropUsage = require('../schemas/DropUsage');
const logger = require('../utils/logger');

const LEGACY_DEFAULT_CATEGORIES = new Set(['general', 'server-roles', 'website-links', 'gaming', 'premium']);
const MIGRATION_BATCH_SIZE = 500;

async function migrateGuildCategories() {
  const categoryByName = new Map();
  const guildCursor = Guild.find({}).cursor();

  for await (const guild of guildCursor) {
    const previousCategories = guild.categories.map((category) => ({
      name: category.name,
      dropType: category.dropType,
      description: category.description || '',
    }));
    let tiersChanged = false;
    const categories = [];
    const seen = new Set();
    for (const category of guild.categories) {
      if (LEGACY_DEFAULT_CATEGORIES.has(category.name) || category.dropType === 'role' || seen.has(category.name)) {
        continue;
      }
      seen.add(category.name);
      categories.push(category);
      if (!categoryByName.has(category.name)) {
        categoryByName.set(category.name, {
          name: category.name,
          dropType: category.dropType,
          description: category.description || '',
        });
      }
    }

    guild.categories = categories;
    const activeNames = new Set(categories.map((category) => category.name));
    for (const [tierName, tier] of guild.tiers) {
      const tierCategories = [...new Set([
        ...(tier.categories || []).filter((name) => activeNames.has(name)),
        ...activeNames,
      ])];
      if (tier.categories.length !== tierCategories.length || tier.categories.some((name, index) => name !== tierCategories[index])) {
        tier.categories = tierCategories;
        guild.tiers.set(tierName, tier);
        tiersChanged = true;
      }
    }
    const categoriesChanged = JSON.stringify(previousCategories) !== JSON.stringify(categories.map((category) => ({
      name: category.name,
      dropType: category.dropType,
      description: category.description || '',
    })));
    if (categoriesChanged || tiersChanged) {
      guild.categories = categories;
      await guild.save();
    } else {
      for (const category of categories) {
        if (!categoryByName.has(category.name)) {
          categoryByName.set(category.name, {
            name: category.name,
            dropType: category.dropType,
            description: category.description || '',
          });
        }
      }
    }
  }

  if (categoryByName.size) {
    await GlobalCategory.bulkWrite(
      [...categoryByName.values()].map((category) => ({
        updateOne: {
          filter: { name: category.name },
          update: { $setOnInsert: category },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  await GlobalCategory.deleteMany({ dropType: 'role' });
  logger.info('global_categories_migrated', { count: categoryByName.size });
}

async function migrateUnclaimedStock() {
  const globalCategories = await GlobalCategory.find({}, { name: 1, dropType: 1 }).lean();
  const categoryTypes = new Map(globalCategories.map((category) => [category.name, category.dropType]));
  const cursor = Stock.find({ claimed: false, archived: { $ne: true } }).cursor();
  let batch = [];
  let migrated = 0;

  async function migrateBatch(items) {
    if (!items.length) return;
    const accepted = items.filter((item) => item.dropType !== 'role' && categoryTypes.has(item.category));
    const uniqueItems = new Map();
    for (const item of accepted) {
      const key = `${item.category}\u0000${item.value}`;
      if (!uniqueItems.has(key)) uniqueItems.set(key, item);
    }

    if (uniqueItems.size) {
      await GlobalStock.bulkWrite(
        [...uniqueItems.values()].map((item) => ({
          updateOne: {
            filter: { category: item.category, value: item.value },
            update: {
              $setOnInsert: {
                category: item.category,
                dropType: categoryTypes.get(item.category),
                value: item.value,
                addedBy: item.addedBy,
                source: item.source,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false, timestamps: false }
      );
    }

    const acceptedIds = accepted.map((item) => item._id);
    const archivedIds = items.filter((item) => !categoryTypes.has(item.category) || item.dropType === 'role').map((item) => item._id);
    if (acceptedIds.length) await Stock.deleteMany({ _id: { $in: acceptedIds } });
    if (archivedIds.length) await Stock.updateMany({ _id: { $in: archivedIds } }, { $set: { archived: true } });
    migrated += accepted.length;
  }

  for await (const item of cursor) {
    batch.push(item);
    if (batch.length >= MIGRATION_BATCH_SIZE) {
      await migrateBatch(batch);
      batch = [];
    }
  }
  await migrateBatch(batch);

  logger.info('global_stock_migrated', { items: migrated });
}

async function migrateGlobalData() {
  await GlobalCategory.init();
  await GlobalStock.init();
  await DropUsage.init();
  await migrateGuildCategories();
  await migrateUnclaimedStock();
}

module.exports = { migrateGlobalData };
