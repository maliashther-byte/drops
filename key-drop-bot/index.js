'use strict';

require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const mongoose = require('mongoose');

const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');
const { migrateGlobalData } = require('./handlers/globalDataMigration');
const { startDashboard } = require('./dashboard/server');
const logger = require('./utils/logger');
const { setDiscordClient } = require('./utils/liveDeploy');

const REQUIRED_ENV = ['DISCORD_TOKEN', 'CLIENT_ID', 'MONGO_URI'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.MessageContent, // required to parse "!drop ..." text
    GatewayIntentBits.GuildMembers, // required to resolve tier roles accurately
  ],
  partials: [Partials.Channel], // allows DMing users who aren't cached
});

async function main() {
  mongoose.connection.on('error', (err) => logger.error('mongo_connection_error', { error: err.message }));
  mongoose.connection.on('disconnected', () => logger.warn('mongo_disconnected'));

  try {
    await mongoose.connect(process.env.MONGO_URI);
    logger.info('mongo_connected');
    await migrateGlobalData();
    logger.info('global_database_ready');
  } catch (err) {
    logger.error('mongo_startup_failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }

  loadCommands(client);
  loadEvents(client);
  setDiscordClient(client);
  startDashboard(client);

  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    logger.error('discord_login_failed', { error: err.message });
    process.exit(1);
  }
}

process.on('unhandledRejection', (err) => {
  logger.error('unhandled_rejection', { error: err?.message, stack: err?.stack });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { error: err.message, stack: err.stack });
});

main();
