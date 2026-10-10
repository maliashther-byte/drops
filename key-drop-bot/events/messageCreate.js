'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');

const Guild = require('../schemas/Guild');
const Stock = require('../schemas/GlobalStock');
const { attemptProductDrop } = require('../handlers/dropEngine');
const { resolveTier } = require('../utils/permissions');
const { errorEmbed, lootBoxEmbed } = require('../utils/embeds');
const quizState = require('../utils/quizState');
const logger = require('../utils/logger');
const { claimEventReceipt } = require('../utils/eventReceipts');
const { rewardMessageCredits } = require('../utils/credits');
const { trackMessageActivity } = require('../utils/aiSafetyMonitor');

function isConfiguredDropChannel(guildDoc, channelId) {
  return Boolean(guildDoc?.dropChannels?.some((entry) => entry.channelId === channelId));
}

function findProductCommandForChannel(guildDoc, channelId, commandName) {
  const channel = guildDoc?.dropChannels?.find((entry) => entry.channelId === channelId);
  if (!channel) return null;

  const products = guildDoc.dropProducts || [];
  const product = products.find((entry) => (entry.commandName || entry.name).toLowerCase() === commandName.toLowerCase());
  if (!product) return null;

  const assignedChannels = guildDoc.dropChannels.filter((entry) => {
    const assignedCommand = entry.prefix?.match(/^!([a-z0-9][a-z0-9_-]{1,31})$/i)?.[1]?.toLowerCase();
    return assignedCommand && products.some((item) =>
      (item.commandName || item.name).toLowerCase() === assignedCommand);
  });
  if (assignedChannels.length) {
    const matchingAssignments = assignedChannels.filter((entry) =>
      entry.prefix?.toLowerCase() === `!${commandName.toLowerCase()}`);
    if (matchingAssignments.length !== 1 || matchingAssignments[0].channelId !== channelId) return null;
  }
  return product;
}

async function execute(message, client) {
  if (message.author.bot || !message.guild) return;
  const receipt = await claimEventReceipt('message', message.id);
  if (receipt === 'duplicate') return;
  if (receipt === 'failed') {
    if (message.content.startsWith('!')) {
      await message.reply('I could not safely process that command right now. Please try again shortly.')
        .catch((err) => logger.error('drop_command_error_reply_failed', { messageId: message.id, error: err.message }));
    }
    return;
  }
  let guildDoc;
  try {
    guildDoc = await Guild.getOrCreate(message.guild.id);
  } catch (err) {
    logger.error('drop_guild_lookup_failed', { error: err.message });
    return message.reply('Something went wrong reading server config — try again shortly.');
  }

  const dropChannel = guildDoc.dropChannels.find((entry) => entry.channelId === message.channel.id);
  const creditSettings = guildDoc.creditSettings;
  if ((creditSettings.messageEnabled || creditSettings.aiSafetyEnabled) &&
    creditSettings.messageChannelIds.includes(message.channel.id)) {
    if (creditSettings.aiSafetyEnabled) {
      try {
        await trackMessageActivity({ guildId: message.guild.id, userId: message.author.id });
      } catch (error) {
        logger.error('ai_activity_metric_failed', {
          guildId: message.guild.id,
          userId: message.author.id,
          channelId: message.channel.id,
          error: error.message,
        });
      }
    }
    if (creditSettings.messageEnabled &&
      creditSettings.messageEligibleTiers.includes(resolveTier(guildDoc, message.member)) &&
      message.content.trim() &&
      !message.content.startsWith(process.env.PREFIX || '!')) {
      try {
        await rewardMessageCredits({ guildDoc, userId: message.author.id });
      } catch (error) {
        logger.error('message_credit_reward_failed', {
          guildId: message.guild.id,
          userId: message.author.id,
          channelId: message.channel.id,
          error: error.message,
        });
      }
    }
  }

  if (!dropChannel) {
    if (message.content.startsWith('!')) {
      return;
    }
    return;
  }

  if (!message.content.startsWith('!')) return;

  const productCommand = message.content.match(/^!([a-z0-9][a-z0-9_-]{1,31})$/i);
  if (productCommand) {
    const product = findProductCommandForChannel(guildDoc, message.channel.id, productCommand[1]);
    if (product) {
      return attemptProductDrop({
        guildDoc,
        member: message.member,
        channel: message.channel,
        product,
        mode: 'prefix',
        tierSettings: dropChannel?.tierSettings.get(resolveTier(guildDoc, message.member)),
        reply: (payload) => message.reply(payload),
      });
    }
  }

  const dropPrefix = dropChannel?.prefix?.toLowerCase() || '';
  const rootDropPrefix = `${(process.env.PREFIX || '!').toLowerCase()}drop`;
  const lowerContent = message.content.toLowerCase();
  const dropCommandMatches = dropPrefix && lowerContent.startsWith(dropPrefix) &&
    (message.content.length === dropPrefix.length || /\s/.test(message.content[dropPrefix.length]));
  if (dropChannel && dropCommandMatches) {
    const productName = message.content.slice(dropPrefix.length).trim().split(/\s+/)[0]?.toLowerCase();
    if (!productName) {
      if (dropPrefix !== rootDropPrefix) {
        return message.reply(`Use \`!<product-name>\` to claim a product or \`${dropChannel.prefix} <category>\` for a category drop.`);
      }
    } else {
      const product = guildDoc.dropProducts.find((entry) => (entry.commandName || entry.name) === productName);
      if (product) {
        return attemptProductDrop({
          guildDoc,
          member: message.member,
          channel: message.channel,
          product,
          mode: 'prefix',
          tierSettings: dropChannel.tierSettings.get(resolveTier(guildDoc, message.member)),
          reply: (payload) => message.reply(payload),
        });
      }
      if (dropPrefix !== rootDropPrefix) {
        return message.reply(`Unknown product **${productName}**. Product claims use \`!<product-name>\`.`);
      }
    }
  }

  const prefix = process.env.PREFIX || '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (command !== 'drop') return;
  let forceQuiz = null;
  let quizOptionProvided = false;
  let quantity = 1;
  let quantityProvided = false;
  const categoryParts = [];
  for (const token of args) {
    const normalized = token.toLowerCase();
    if (normalized === 'yes' || normalized === 'quiz') {
      if (quizOptionProvided) return message.reply('Provide the CAPTCHA option only once: `yes` or `no`.');
      forceQuiz = true;
      quizOptionProvided = true;
    } else if (normalized === 'no') {
      if (quizOptionProvided) return message.reply('Provide the CAPTCHA option only once: `yes` or `no`.');
      forceQuiz = false;
      quizOptionProvided = true;
    } else if (/^\d+$/.test(token)) {
      if (quantityProvided) {
        return message.reply('Provide only one item amount. Use a whole number from 1 to 25.');
      }
      quantity = Number(token);
      quantityProvided = true;
    } else {
      categoryParts.push(normalized);
    }
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 25) {
    return message.reply('Drop amount must be a whole number from 1 to 25.');
  }
  const categoryArg = categoryParts.join(' ') || null;

  const postBox = (category) => postLootBox({ message, guildDoc, category, forceQuiz, quantity });

  if (!categoryArg) {
    return showCategoryPicker(message, guildDoc, forceQuiz, quantity);
  }

  if (categoryArg === 'random') {
    const tierName = resolveTier(guildDoc, message.member);
    const tierConfig = guildDoc.getTier(tierName);
    const candidates = guildDoc.categories.filter((c) => tierConfig?.categories.includes(c.name));
    if (!candidates.length) {
      return message.reply({ embeds: [errorEmbed(guildDoc, "You don't have access to any categories yet. Check `/help`.")] });
    }
    const stocked = [];
    for (const category of candidates) {
      if (await Stock.countAvailable(category.name) >= quantity) stocked.push(category);
    }
    if (!stocked.length) {
      return message.reply(`No accessible category has ${quantity} item(s) in stock for a random drop.`);
    }
    const chosen = stocked[Math.floor(Math.random() * stocked.length)];
    return postBox(chosen.name);
  }

  const category = guildDoc.categories.find((entry) => entry.name.toLowerCase() === categoryArg);
  if (!category) {
    return message.reply({ embeds: [errorEmbed(guildDoc, `No category named **${categoryArg}**. Run \`!drop\` with no arguments to see what's available.`)] });
  }

  return postBox(category.name);
}

async function postLootBox({ message, guildDoc, category, forceQuiz = null, quantity = 1, reply = null }) {
  const categoryConfig = guildDoc.getCategory(category);
  if (!categoryConfig) {
    const payload = { embeds: [errorEmbed(guildDoc, `Category **${category}** does not exist.`)] };
    return reply ? reply(payload) : message.reply(payload);
  }

  let destination = message.channel;
  const targetChannelId = guildDoc.dropChannelIds[0];
  if (targetChannelId) {
    destination = await message.guild.channels.fetch(targetChannelId).catch((err) => {
      logger.error('loot_box_channel_fetch_failed', { guildId: guildDoc.guildId, channelId: targetChannelId, error: err.message });
      return null;
    });
    if (!destination?.isTextBased() || !destination.send) {
      const payload = { content: 'The configured drop channel is unavailable. Ask an administrator to check `/setup`.' };
      return reply ? reply(payload) : message.reply(payload);
    }
  }

  guildDoc.lootBoxCount = (guildDoc.lootBoxCount || 0) + 1;
  try {
    await guildDoc.save();
  } catch (err) {
    logger.error('loot_box_counter_save_failed', { guildId: guildDoc.guildId, error: err.message });
    const payload = { content: 'I could not prepare a loot box right now. Please try again shortly.' };
    return reply ? reply(payload) : message.reply(payload);
  }
  const button = new ButtonBuilder()
    .setCustomId('lootbox:claim')
    .setLabel('Claim this box')
    .setEmoji('🎁')
    .setStyle(ButtonStyle.Success);
  let boxMessage;
  try {
    boxMessage = await destination.send({
      embeds: [lootBoxEmbed(guildDoc, {
        number: guildDoc.lootBoxCount,
        category,
        reward: `${quantity} × ${categoryConfig.description || category}`,
      })],
      components: [new ActionRowBuilder().addComponents(button)],
    });
  } catch (err) {
    logger.error('loot_box_post_failed', { guildId: guildDoc.guildId, channelId: destination.id, error: err.message });
    const payload = { content: 'I could not post the loot box. Check that I can send messages and embeds in the configured drop channel.' };
    return reply ? reply(payload) : message.reply(payload);
  }
  quizState.create(boxMessage.id, {
    kind: 'lootbox',
    guildId: guildDoc.guildId,
    category,
    number: guildDoc.lootBoxCount,
    reward: `${quantity} × ${categoryConfig.description || category}`,
    quantity,
    forceQuiz,
    claiming: false,
    claimedBy: null,
    messageRef: boxMessage,
  });

  if (reply) return reply({ content: `🎁 Loot Box #${guildDoc.lootBoxCount} posted in ${destination}.` });
  if (destination.id !== message.channel.id) return message.reply({ content: `🎁 Loot Box #${guildDoc.lootBoxCount} posted in ${destination}.` });
  return boxMessage;
}

async function showCategoryPicker(message, guildDoc, forceQuiz, quantity = 1) {
  const tierName = resolveTier(guildDoc, message.member);
  const tierConfig = guildDoc.getTier(tierName);
  const available = guildDoc.categories.filter((c) => tierConfig?.categories.includes(c.name));

  if (!available.length) {
    return message.reply({ embeds: [errorEmbed(guildDoc, "You don't have access to any categories yet. Check `/help` for upgrade info.")] });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`drop:category_select:${message.author.id}:${forceQuiz === null ? 'default' : forceQuiz ? 'yes' : 'no'}:${quantity}`)
    .setPlaceholder('Choose a category to drop from')
    .addOptions(available.slice(0, 25).map((c) => ({ label: c.name, value: c.name, description: c.description?.slice(0, 90) || `${c.dropType} drop` })));

  return message.reply({ content: 'Pick a category:', components: [new ActionRowBuilder().addComponents(menu)] });
}

async function handleComponent(interaction) {
  const [, , authorId, forceQuizFlag = 'default', quantityValue = '1'] = interaction.customId.split(':');
  if (interaction.user.id !== authorId) {
    return interaction.reply({ content: "This isn't your drop menu.", ephemeral: true });
  }

  const category = interaction.values[0];
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const forceQuiz = forceQuizFlag === 'default' ? null : forceQuizFlag === 'yes';
  const quantity = Number(quantityValue);

  const reply = (payload) => postLootBox({
    message: interaction.message,
    guildDoc,
    category,
    forceQuiz,
    quantity,
    reply: (result) => interaction.editReply({ content: result.content ?? null, embeds: result.embeds ?? [], components: result.components ?? [] }),
  });
  await interaction.deferUpdate();
  return reply({});
}

module.exports = {
  name: 'messageCreate',
  execute,
  handleComponent,
  isConfiguredDropChannel,
  findProductCommandForChannel,
};
