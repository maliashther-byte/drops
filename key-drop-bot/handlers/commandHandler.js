'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Collection } = require('discord.js');
const logger = require('../utils/logger');

function loadCommands(client) {
  client.commands = new Collection();
  const commandsDir = path.join(__dirname, '..', 'commands');
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

  for (const file of files) {
    const filePath = path.join(commandsDir, file);
    try {
      const command = require(filePath);
      if (!command?.data?.name || typeof command.execute !== 'function') {
        logger.warn('command_file_invalid', { file });
        continue;
      }
      client.commands.set(command.data.name, command);
      logger.debug('command_loaded', { name: command.data.name });
    } catch (err) {
      logger.error('command_load_failed', { file, error: err.message });
    }
  }
  logger.info('commands_loaded', { count: client.commands.size });
}

module.exports = { loadCommands };
