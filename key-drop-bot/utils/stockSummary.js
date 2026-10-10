'use strict';

const GlobalCategory = require('../schemas/GlobalCategory');
const GlobalStock = require('../schemas/GlobalStock');

function summarizeStock(rows, categories) {
  const summarize = (category, name = category.name, archived = false) => {
    const counts = rows.filter((row) => row._id.category === name);
    return {
      name,
      dropType: category.dropType,
      description: category.description || '',
      archived,
      available: counts
        .filter((row) => row._id.claimed !== true && row._id.archived !== true)
        .reduce((sum, row) => sum + row.count, 0),
      claimed: counts
        .filter((row) => row._id.claimed === true)
        .reduce((sum, row) => sum + row.count, 0),
    };
  };
  const active = categories.map((category) => summarize(category));
  const archivedNames = [...new Set(rows
    .filter((row) => row._id.archived === true)
    .map((row) => row._id.category))];
  const archived = archivedNames.map((name) => summarize(
    { dropType: 'key', description: 'Archived inventory; cannot be claimed.' },
    name,
    true
  ));
  return { active, archived };
}

async function getStockSummary() {
  const [rows, categories] = await Promise.all([
    GlobalStock.aggregate([
      { $group: {
        _id: { category: '$category', archived: '$archived', claimed: '$claimed' },
        count: { $sum: 1 },
      } },
    ]),
    GlobalCategory.find({}).sort({ name: 1 }).lean(),
  ]);
  return summarizeStock(rows, categories);
}

function buildPublicStockPayload(categories, updatedAt = new Date()) {
  const visibleCategories = categories.map(({ name, dropType, available, claimed }) => ({
    name,
    dropType,
    available,
    claimed,
  }));
  return {
    updatedAt: updatedAt.toISOString(),
    totals: visibleCategories.reduce((totals, category) => ({
      available: totals.available + category.available,
      claimed: totals.claimed + category.claimed,
    }), { available: 0, claimed: 0 }),
    categories: visibleCategories,
  };
}

module.exports = { summarizeStock, getStockSummary, buildPublicStockPayload };