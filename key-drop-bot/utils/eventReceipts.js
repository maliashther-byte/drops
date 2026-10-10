'use strict';

const EventReceipt = require('../schemas/EventReceipt');
const logger = require('./logger');

const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

async function claimEventReceipt(kind, id) {
  try {
    await EventReceipt.create({
      _id: `${kind}:${id}`,
      expiresAt: new Date(Date.now() + RECEIPT_TTL_MS),
    });
    return 'claimed';
  } catch (err) {
    if (err.code === 11000) return 'duplicate';
    logger.error('event_receipt_claim_failed', { kind, eventId: id, error: err.message });
    return 'failed';
  }
}

module.exports = { claimEventReceipt };
