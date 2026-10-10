const test = require('node:test');
const assert = require('node:assert/strict');

const Stock = require('../key-drop-bot/schemas/GlobalStock');

test('stock claims use Mongo sample selection and preserve randomized item order', async (t) => {
  const originals = {
    aggregate: Stock.aggregate,
    updateMany: Stock.updateMany,
    find: Stock.find,
  };
  t.after(() => Object.assign(Stock, originals));

  let pipeline;
  Stock.aggregate = async (value) => {
    pipeline = value;
    return [{ _id: 'random-b' }, { _id: 'random-a' }];
  };
  Stock.updateMany = async () => ({ modifiedCount: 2 });
  Stock.find = async () => [
    { _id: 'random-a', value: 'older-created-item' },
    { _id: 'random-b', value: 'newer-created-item' },
  ];

  const result = await Stock.claimMany('discord', 2, 'user-1', 'guild-1', 'batch-1');

  assert.deepEqual(pipeline, [
    { $match: { category: 'discord', claimed: false, archived: { $ne: true } } },
    { $sample: { size: 2 } },
    { $project: { _id: 1 } },
  ]);
  assert.deepEqual(result.map((item) => item._id), ['random-b', 'random-a']);
});

test('single-item claims randomly select an eligible stock record', async (t) => {
  const originals = {
    aggregate: Stock.aggregate,
    findOneAndUpdate: Stock.findOneAndUpdate,
  };
  t.after(() => Object.assign(Stock, originals));

  let pipeline;
  let updateFilter;
  const selected = { _id: 'random-item', value: 'key' };
  Stock.aggregate = async (value) => {
    pipeline = value;
    return [{ _id: selected._id }];
  };
  Stock.findOneAndUpdate = async (filter) => {
    updateFilter = filter;
    return selected;
  };

  const result = await Stock.claimOne('discord', 'user-1', 'guild-1');

  assert.equal(pipeline[1].$sample.size, 1);
  assert.equal(updateFilter._id, selected._id);
  assert.equal(result, selected);
});