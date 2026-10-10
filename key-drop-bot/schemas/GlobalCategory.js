'use strict';

const { Schema, model } = require('mongoose');
const { DROP_TYPES } = require('../config/constants');

const GlobalCategorySchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    dropType: { type: String, enum: DROP_TYPES, required: true },
    description: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = model('GlobalCategory', GlobalCategorySchema);
