'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');

function loadEvents(client) {
  const eventsDir = path.join(__dirname, '..', 'events');
  const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.js'));

  for (const file of files) {
    const filePath = path.join(eventsDir, file);
    try {
      const event = require(filePath);
      if (!event?.name || typeof event.execute !== 'function') {
        logger.warn('event_file_invalid', { file });
        continue;
      }
      if (event.once) {
        client.once(event.name, (...args) => event.execute(...args, client));
      } else {
        client.on(event.name, (...args) => event.execute(...args, client));
      }
      logger.debug('event_loaded', { name: event.name });
    } catch (err) {
      logger.error('event_load_failed', { file, error: err.message });
    }
  }
  logger.info('events_loaded', { count: files.length });
}

module.exports = { loadEvents };
