'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

async function main() {
  const { DISCORD_TOKEN, CLIENT_ID, DEV_GUILD_ID } = process.env;
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
    process.exit(1);
  }

  const commandsDir = path.join(__dirname, '..', 'commands');
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));
  const body = [];

  for (const file of files) {
    const command = require(path.join(commandsDir, file));
    if (command?.data) body.push(command.data.toJSON());
  }

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    if (DEV_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID), { body });
      console.log(`Deployed ${body.length} commands to guild ${DEV_GUILD_ID} (instant).`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
      console.log(`Deployed ${body.length} commands globally (may take up to 1 hour to appear).`);
    }
  } catch (err) {
    console.error('Command deployment failed:', err);
    process.exit(1);
  }
}

main();
