'use strict';

const Guild = require('../schemas/Guild');
const {
  handleQuizAnswer,
  showCaptchaModal,
  handleLootBoxClaim,
  showSecureDeliveryModal,
  handleSecureDeliveryModal,
  attemptProductDrop,
} = require('../handlers/dropEngine');
const { handleComponent: handleDropComponent } = require('./messageCreate');
const logger = require('../utils/logger');
const { claimEventReceipt } = require('../utils/eventReceipts');
const { activateCooldownReward } = require('../handlers/cooldownRewards');
const { handleRefresh: handleStockRefresh } = require('../utils/stockCounter');
const { resolveTier } = require('../utils/permissions');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client) {
    const receipt = await claimEventReceipt('interaction', interaction.id);
    if (receipt === 'duplicate') return;
    if (receipt === 'failed') {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'I could not safely process that action right now. Please try again shortly.', ephemeral: true })
          .catch((err) => logger.error('interaction_receipt_error_reply_failed', { interactionId: interaction.id, error: err.message }));
      }
      return;
    }
    try {
      if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;
        return await command.execute(interaction);
      }

      if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (!command?.autocomplete) return;
        return await command.autocomplete(interaction);
      }

      // Buttons, string/channel/role select menus.
      if (interaction.isButton() || interaction.isAnySelectMenu()) {
        const [namespace] = interaction.customId.split(':');

        if (namespace === 'quiz') {
          const [, action, quizId] = interaction.customId.split(':');
          if (action === 'prompt') return await showCaptchaModal(interaction, quizId);
        }

        if (namespace === 'lootbox') {
          return await handleLootBoxClaim(interaction);
        }

        if (namespace === 'stock-counter') {
          return await handleStockRefresh(interaction, client);
        }

        if (namespace === 'secure') {
          const [, deliveryId] = interaction.customId.split(':');
          return await showSecureDeliveryModal(interaction, deliveryId);
        }

        if (namespace === 'cooldown-reward') {
          const [, , rewardId] = interaction.customId.split(':');
          return await activateCooldownReward(interaction, rewardId);
        }

        if (namespace === 'drop') {
          return await handleDropComponent(interaction);
        }

        if (namespace === 'drop-button') {
          const [, action, commandName] = interaction.customId.split(':');
          if (action !== 'claim' || !interaction.guildId) {
            return interaction.reply({ content: 'This drop button is unavailable.', ephemeral: true });
          }
          const guildDoc = await Guild.getOrCreate(interaction.guildId);
          const product = guildDoc.dropProducts.find((entry) => entry.commandName === commandName);
          if (!product?.buttonMessageId || product.buttonMessageId !== interaction.message.id ||
            product.buttonChannelId !== interaction.channelId) {
            return interaction.reply({ content: 'This drop button is no longer active.', ephemeral: true });
          }
          const channelConfig = guildDoc.dropChannels.find((entry) => entry.channelId === interaction.channelId);
          const tierName = resolveTier(guildDoc, interaction.member);
          return attemptProductDrop({
            guildDoc,
            member: interaction.member,
            channel: interaction.channel,
            product,
            mode: 'button',
            tierSettings: channelConfig?.tierSettings.get(tierName),
            reply: (payload) => interaction.reply({ ...payload, ephemeral: true }),
          });
        }

        const command = client.commands.get(namespace);
        if (command?.handleComponent) return await command.handleComponent(interaction);

        logger.warn('unhandled_component', { customId: interaction.customId });
        return;
      }

      if (interaction.isModalSubmit()) {
        const [namespace] = interaction.customId.split(':');
        if (namespace === 'quiz') {
          const [, action, quizId] = interaction.customId.split(':');
          if (action === 'answer') return await handleQuizAnswer(interaction, quizId, Guild);
        }
        if (namespace === 'secure') {
          const [, , deliveryId] = interaction.customId.split(':');
          return await handleSecureDeliveryModal(interaction, deliveryId);
        }
        const command = client.commands.get(namespace);
        if (command?.handleModal) return await command.handleModal(interaction);

        logger.warn('unhandled_modal', { customId: interaction.customId });
        return;
      }
    } catch (err) {
      logger.error('interaction_handler_failed', { customId: interaction.customId, commandName: interaction.commandName, error: err.message, stack: err.stack });
      const payload = { content: 'Something went wrong handling that. Nothing was lost — try again.', ephemeral: true };
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(payload);
        } else {
          await interaction.reply(payload);
        }
      } catch (_) {
        // Interaction token likely expired — nothing more we can do.
      }
    }
  },
};
