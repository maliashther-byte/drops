'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const logger = require('./logger');

function buildButtonDropPayload(product) {
  const embed = new EmbedBuilder()
    .setColor(product.embedColor || '#5865F2')
    .setTitle(product.buttonTitle || product.name)
    .setDescription(product.buttonDescription || product.description || `Press the button to claim **${product.name}**.`);
  if (product.buttonImageUrl) embed.setImage(product.buttonImageUrl);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`drop-button:claim:${product.commandName}`)
        .setLabel(product.buttonLabel || 'Claim')
        .setStyle(ButtonStyle.Success)
    )],
  };
}

async function publishButtonDrop({ guildDoc, product, channel, title, description, label, imageUrl }) {
  const nextProduct = {
    name: product.name,
    commandName: product.commandName,
    embedColor: product.embedColor,
    buttonTitle: title,
    buttonDescription: description,
    buttonLabel: label,
    buttonImageUrl: imageUrl || null,
  };
  const message = await channel.send(buildButtonDropPayload(nextProduct));
  const previousChannelId = product.buttonChannelId;
  const previousMessageId = product.buttonMessageId;

  product.buttonTitle = title;
  product.buttonDescription = description;
  product.buttonLabel = label;
  product.buttonImageUrl = imageUrl || null;
  product.buttonChannelId = channel.id;
  product.buttonMessageId = message.id;
  try {
    await guildDoc.save();
  } catch (error) {
    try {
      await message.delete();
    } catch (cleanupError) {
      logger.error('button_drop_publish_rollback_failed', {
        guildId: guildDoc.guildId,
        messageId: message.id,
        error: cleanupError.message,
      });
    }
    throw error;
  }

  if (previousChannelId && previousMessageId) {
    try {
      const previousChannel = await channel.guild.channels.fetch(previousChannelId);
      const previousMessage = await previousChannel.messages.fetch(previousMessageId);
      await previousMessage.delete();
    } catch (error) {
      if (![10003, 10008].includes(Number(error.code))) {
        logger.warn('button_drop_old_message_cleanup_failed', {
          guildId: guildDoc.guildId,
          channelId: previousChannelId,
          messageId: previousMessageId,
          error: error.message,
        });
      }
    }
  }
  return message;
}

module.exports = { buildButtonDropPayload, publishButtonDrop };
