'use strict';

const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const Stock = require('../schemas/GlobalStock');
const SecureDelivery = require('../schemas/SecureDelivery');
const CooldownReward = require('../schemas/CooldownReward');
const User = require('../schemas/User');
const DropUsage = require('../schemas/DropUsage');
const Guild = require('../schemas/Guild');
const { addTimedTierRole } = require('./tierGrants');
const { resolveTier, checkDropEligibility, recordDrop } = require('../utils/permissions');
const { createCaptcha } = require('../utils/captcha');
const quizState = require('../utils/quizState');
const { publicClaimEmbed, dmItemsEmbeds, embedCharacterCount, outOfStockEmbed, cooldownEmbed, dailyLimitEmbed, errorEmbed, lootBoxEmbed } = require('../utils/embeds');
const { QUIZ_TIME_LIMIT_MS, DEFAULT_SECURE_ITEMS_PER_CLICK } = require('../config/constants');
const logger = require('../utils/logger');
const { issueCooldownReward } = require('./cooldownRewards');
const { notifyStockChanged } = require('../utils/stockCounter');
const { ensureCreditUser, spendCredits, grantCredits } = require('../utils/credits');

/**
 * Entry point for a loot-box claim. `reply` sends the initial
 * response in the right place (channel.send for prefix commands,
 * interaction.reply/update for components) — callers adapt their own
 * reply mechanism; this function only decides WHAT to send.
 */
async function attemptDrop({ guildDoc, member, channel, category, forceQuiz = null, quantity = 1, reply, lootBox = null }) {
  const tierName = resolveTier(guildDoc, member);
  const tierConfig = guildDoc.getTier(tierName);
  if (!tierConfig) {
    return reply({ embeds: [errorEmbed(guildDoc, 'Tiers are not configured yet. Ask an admin to run `/setup`.')] });
  }

  const categoryConfig = guildDoc.getCategory(category);
  if (!categoryConfig) {
    return reply({ embeds: [errorEmbed(guildDoc, `Category **${category}** does not exist.`)] });
  }
  if (!tierConfig.categories.includes(category)) {
    return reply({ embeds: [errorEmbed(guildDoc, `Your tier (**${tierConfig.label}**) doesn't have access to **${category}**. Check \`/help\` for upgrade options.`)] });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 25) {
    return reply({ content: 'Drop amount must be a whole number from 1 to 25.' });
  }

  const userDoc = await User.getOrCreate(member.id, guildDoc.guildId);
  const elig = checkDropEligibility(userDoc, tierConfig);
  await userDoc.save(); // persists the daily-counter reset even if this attempt is denied

  if (!elig.allowed) {
    if (elig.reason === 'daily_limit') return reply({ embeds: [dailyLimitEmbed(guildDoc, tierConfig.label)] });
    return reply({ embeds: [cooldownEmbed(guildDoc, elig.cooldownRemainingMs)] });
  }

  const available = await Stock.countAvailable(category);
  if (available < quantity) {
    if (lootBox) await markLootBoxUnavailable(guildDoc, lootBox);
    return quantity > 1
      ? reply({ content: `**${category}** has only **${available}** item(s) available; this drop needs **${quantity}**.` })
      : reply({ embeds: [outOfStockEmbed(guildDoc, category)] });
  }

  const requireQuiz = forceQuiz === null ? guildDoc.quizEnabledByDefault : forceQuiz;
  if (!requireQuiz) {
    return finalizeClaim({ guildDoc, member, channel, category, quantity, userDoc, reply, lootBox });
  }

  return startQuiz({ guildDoc, member, channel, category, quantity, userDoc, reply, lootBox });
}

async function finalizeClaim({ guildDoc, member, channel, category, quantity = 1, userDoc, reply, lootBox = null }) {
  if (lootBox) {
    if (lootBox.state.claiming || lootBox.state.claimedBy) {
      return reply({ content: '⌛ Time’s up — someone else has claimed this loot box.', embeds: [], components: [] });
    }
    lootBox.state.claiming = true;
  }
  const deliveryId = crypto.randomUUID();
  const items = await Stock.claimMany(category, quantity, member.id, guildDoc.guildId, deliveryId);
  if (items.length !== quantity) {
    if (lootBox) {
      lootBox.state.claiming = false;
      await markLootBoxUnavailable(guildDoc, lootBox);
    }
    return reply({ embeds: [outOfStockEmbed(guildDoc, category)] });
  }

  const delivery = await deliverItems({
    guildDoc,
    member,
    channel,
    category,
    items,
    deliveryId,
    announce: !lootBox,
  });
  if (!delivery.delivered) {
    await Stock.updateMany(
      { claimBatchId: deliveryId, claimed: true, claimedBy: member.id },
      { $set: { claimed: false, claimedBy: null, claimedInGuildId: null, claimedAt: null, claimBatchId: null } }
    );
    if (lootBox) lootBox.state.claiming = false;
    return reply({ content: 'I could not DM your drop. Enable direct messages and try again.', embeds: [] });
  }

  notifyStockChanged();
  recordDrop(userDoc);
  await userDoc.save();
  if (lootBox) {
    lootBox.state.claimedBy = member.id;
    lootBox.state.claiming = false;
    await updateLootBox(guildDoc, lootBox, member);
    await expirePendingBoxQuizzes(lootBox.message.id, member.id);
  }
  const deliveredCount = delivery.deliveredCount ?? items.length;
  const cleanupMessage = delivery.cleanupPending ? ' The item is still reserved while database cleanup is retried; contact an administrator if it remains.' : '';
  const partialMessage = delivery.partial ? ` Discord only accepted ${deliveredCount} of ${items.length} items in DMs; the rest were returned to inventory.` : '';
  return reply({ content: `✅ You claimed **${deliveredCount}** item(s) from **${category}** — check your DMs.${partialMessage}${cleanupMessage}`, embeds: [] });
}

async function deliverItems({ guildDoc, member, channel, category, items, deliveryId, announce = true, productName = '', description = '' }) {
  const tierName = resolveTier(guildDoc, member);
  const tier = guildDoc.getTier(tierName);
  const fallbackSecureItems = DEFAULT_SECURE_ITEMS_PER_CLICK[tierName] ?? 1;
  const configuredSecureItems = Number(tier?.secureItemsPerClick ?? fallbackSecureItems);
  const secureItemsPerClick = Number.isInteger(configuredSecureItems) && configuredSecureItems >= 0 && configuredSecureItems <= 25
    ? configuredSecureItems
    : fallbackSecureItems;
  let embeds;
  try {
    embeds = dmItemsEmbeds(guildDoc, {
      category,
      items,
      autoSecure: secureItemsPerClick === 0,
      productName,
      description,
    });
  } catch (err) {
    logger.warn('secure_delivery_embed_failed', { guildId: guildDoc.guildId, userId: member.id, error: err.message });
    return { delivered: false, cleanupPending: false };
  }
  const isCooldownReward = items[0]?.dropType === 'cooldown-refresh';
  let cooldownReward = null;
  try {
    if (isCooldownReward) {
      cooldownReward = await issueCooldownReward({
        guildId: guildDoc.guildId,
        userId: member.id,
        source: 'drop',
        itemIds: items.map((item) => item._id),
      });
    } else {
      await SecureDelivery.create({
        _id: deliveryId,
        guildId: guildDoc.guildId,
        userId: member.id,
        itemIds: items.map((item) => item._id),
        itemValues: items.map((item) => item.value),
        secureItemsPerClick,
      });
    }
  } catch (err) {
    logger.error(isCooldownReward ? 'cooldown_reward_create_failed' : 'secure_delivery_create_failed', {
      guildId: guildDoc.guildId,
      userId: member.id,
      error: err.message,
    });
    return { delivered: false, cleanupPending: false };
  }

  let sentCount = 0;
  let sendError = null;
  let messageEmbeds = [];
  let messageItemCount = 0;
  let messageCharacterCount = 0;
  const sendMessage = async () => {
    if (!messageEmbeds.length) return;
    const dmPayload = { embeds: messageEmbeds };
    if (isCooldownReward) {
      dmPayload.components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cooldown-reward:activate:${cooldownReward.id}`)
          .setLabel('Activate (expires in 1 week)')
          .setStyle(ButtonStyle.Success)
      )];
    } else if (secureItemsPerClick > 0) {
      const secureButton = new ButtonBuilder()
        .setCustomId(`secure:${deliveryId}`)
        .setLabel('Secure key or link')
        .setStyle(ButtonStyle.Success);
      dmPayload.components = [new ActionRowBuilder().addComponents(secureButton)];
    }
    try {
      await member.send(dmPayload);
      sentCount += messageItemCount;
    } catch (err) {
      sendError = err;
    } finally {
      messageEmbeds = [];
      messageItemCount = 0;
      messageCharacterCount = 0;
    }
  };
  for (const embed of embeds) {
    const embedCharacters = embedCharacterCount(embed);
    if (messageEmbeds.length &&
      (messageEmbeds.length >= 10 || messageCharacterCount + embedCharacters > 6000)) {
      await sendMessage();
      if (sendError) break;
    }
    messageEmbeds.push(embed);
    messageItemCount += embed.data.fields.length;
    messageCharacterCount += embedCharacters;
  }
  if (!sendError) await sendMessage();

  if (sendError && sentCount === 0) {
    logger.warn('dm_failed', { userId: member.id, error: sendError.message });
    if (isCooldownReward) await cooldownReward.deleteOne();
    else await SecureDelivery.deleteOne({ _id: deliveryId });
    if (channel && announce) {
      await channel.send({ content: `${member}, I could not DM your drop. Please enable direct messages and try again.` }).catch(() => {});
    }
    return { delivered: false, cleanupPending: false };
  }

  let cleanupPending = false;
  if (sendError) {
    logger.error('dm_partial_delivery_failed', {
      deliveryId,
      guildId: guildDoc.guildId,
      userId: member.id,
      sentItems: sentCount,
      totalItems: items.length,
      error: sendError.message,
    });
    const deliveredItems = items.slice(0, sentCount);
    const undeliveredItems = items.slice(sentCount);
    if (isCooldownReward) {
      await CooldownReward.updateOne(
        { _id: cooldownReward.id },
        { $set: { itemIds: deliveredItems.map((item) => item._id) } }
      );
    } else {
      await SecureDelivery.updateOne(
        { _id: deliveryId },
        { $set: {
          itemIds: deliveredItems.map((item) => item._id),
          itemValues: deliveredItems.map((item) => item.value),
        } }
      );
    }
    if (undeliveredItems.length) {
      await Stock.updateMany(
        { _id: { $in: undeliveredItems.map((item) => item._id) }, claimed: true, claimedBy: member.id, claimBatchId: deliveryId },
        { $set: { claimed: false, claimedBy: null, claimedInGuildId: null, claimedAt: null, claimBatchId: null } }
      );
    }
    if (!isCooldownReward && secureItemsPerClick === 0) {
      try {
        const result = await Stock.deleteMany({
          _id: { $in: deliveredItems.map((item) => item._id) },
          claimed: true,
          claimedBy: member.id,
        });
        if (result.deletedCount !== deliveredItems.length) {
          throw new Error(`Expected to remove ${deliveredItems.length} delivered items but removed ${result.deletedCount}`);
        }
        await SecureDelivery.updateOne(
          { _id: deliveryId },
          { $set: { securedCount: deliveredItems.length, completed: true } }
        );
      } catch (err) {
        cleanupPending = true;
        logger.error('secure_delivery_partial_auto_cleanup_failed', {
          deliveryId,
          guildId: guildDoc.guildId,
          userId: member.id,
          error: err.message,
        });
      }
    }
    if (channel && announce) {
      await channel.send({ embeds: [publicClaimEmbed(guildDoc, { user: `${member}`, category, dropType: items[0].dropType })] }).catch(() => {});
    }
    return { delivered: true, cleanupPending, partial: true, deliveredCount: sentCount };
  }

  if (!isCooldownReward && secureItemsPerClick === 0) {
    try {
      const result = await Stock.deleteMany({
        _id: { $in: items.map((item) => item._id) },
        claimed: true,
        claimedBy: member.id,
      });
      if (result.deletedCount !== items.length) {
        throw new Error(`Expected to remove ${items.length} items but removed ${result.deletedCount}`);
      }
      await SecureDelivery.updateOne(
        { _id: deliveryId },
        { $set: { securedCount: items.length, completed: true } }
      );
    } catch (err) {
      cleanupPending = true;
      logger.error('secure_delivery_auto_cleanup_failed', {
        deliveryId,
        guildId: guildDoc.guildId,
        userId: member.id,
        error: err.message,
      });
    }
  }

  if (channel && announce) {
    await channel.send({ embeds: [publicClaimEmbed(guildDoc, { user: `${member}`, category, dropType: items[0].dropType })] }).catch(() => {});
  }
  return { delivered: true, cleanupPending };
}

async function handleLootBoxClaim(interaction) {
  const state = quizState.get(interaction.message.id);
  if (!state || !['lootbox', 'tier'].includes(state.kind)) {
    return interaction.reply({ content: 'This loot box is no longer available. Run `!drop` to create another.', ephemeral: true });
  }
  if (state.unavailable) {
    return interaction.reply({ content: '⌛ Time’s up — this loot box is no longer available.', ephemeral: true });
  }
  if (state.claimedBy || state.claiming) {
    return interaction.reply({ content: '⌛ Time’s up — someone else has claimed this loot box.', ephemeral: true });
  }
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  if (state.kind === 'tier') {
    if (guildDoc.quizEnabledByDefault) {
      return startTierBoxQuiz(interaction, guildDoc, state);
    }
    return finalizeTierBoxClaim(interaction, guildDoc, state, (payload) =>
      interaction.reply({ ...payload, ephemeral: true }));
  }
  return attemptDrop({
    guildDoc,
    member: interaction.member,
    channel: interaction.channel,
    category: state.category,
    forceQuiz: state.forceQuiz ?? null,
    quantity: state.quantity || 1,
    lootBox: { state, message: interaction.message },
    reply: async (payload) => {
      await interaction.reply({ ...payload, ephemeral: true });
      return interaction.fetchReply();
    },
  });
}

function captchaPrompt(guildDoc, quizId, title, description) {
  const captcha = createCaptcha();
  const embed = new EmbedBuilder()
    .setColor(guildDoc.embedStyle?.color || '#5865F2')
    .setTitle(title)
    .setDescription(description)
    .setImage('attachment://captcha.png');
  const button = new ButtonBuilder()
    .setCustomId(`quiz:prompt:${quizId}`)
    .setLabel('Enter CAPTCHA')
    .setStyle(ButtonStyle.Primary);
  return {
    answer: captcha.code,
    payload: {
      embeds: [embed],
      files: [new AttachmentBuilder(captcha.image, { name: 'captcha.png' })],
      components: [new ActionRowBuilder().addComponents(button)],
    },
  };
}

async function startTierBoxQuiz(interaction, guildDoc, state) {
  const quizId = crypto.randomUUID();
  const prompt = captchaPrompt(
    guildDoc,
    quizId,
    'CAPTCHA verification',
    `Enter the 6 characters shown below within ${QUIZ_TIME_LIMIT_MS / 1000}s to claim ${state.reward}.`
  );
  await interaction.reply({ ...prompt.payload, ephemeral: true });
  const messageRef = await interaction.fetchReply();
  quizState.create(quizId, {
    kind: 'tier-lootbox',
    userId: interaction.user.id,
    guildId: guildDoc.guildId,
    boxMessageId: interaction.message.id,
    tierName: state.tierName,
    durationMs: state.durationMs,
    answer: prompt.answer,
    attempts: 0,
    messageRef,
  });
  setTimeout(() => expireQuiz(quizId), QUIZ_TIME_LIMIT_MS).unref();
}

async function finalizeTierBoxClaim(interaction, guildDoc, state, reply) {
  if (state.claiming || state.claimedBy || state.unavailable) {
    return reply({
      content: `⌛ Time’s up — ${state.claimedBy ? 'someone else has claimed this loot box.' : 'this loot box is no longer available.'}`,
      embeds: [],
      components: [],
    });
  }
  state.claiming = true;
  try {
    const tier = guildDoc.getTier(state.tierName);
    if (!tier?.roleId) throw new Error(`No Discord role is configured for the ${state.tierName} tier`);
    const grant = await addTimedTierRole({
      guild: interaction.guild,
      member: interaction.member,
      tierName: state.tierName,
      roleId: tier.roleId,
      durationMs: state.durationMs,
    });
    state.claimedBy = interaction.user.id;
    state.claiming = false;
    await updateLootBox(guildDoc, { state, message: state.messageRef }, interaction.member, grant.expiresAt);
    await expirePendingBoxQuizzes(interaction.message.id, interaction.user.id);
    return reply({
      content: `✅ You received the **${tier.label}** tier until <t:${Math.floor(grant.expiresAt.getTime() / 1000)}:F>.`,
      embeds: [],
      components: [],
    });
  } catch (err) {
    state.claiming = false;
    logger.error('tier_drop_claim_failed', {
      guildId: guildDoc.guildId,
      tier: state.tierName,
      userId: interaction.user.id,
      error: err.message,
    });
    const alreadyHasRole = err.message.includes('already has the');
    return reply({
      content: alreadyHasRole
        ? `You already have the **${state.tierName}** role outside a timed tier reward, so I left it unchanged.`
        : 'I could not grant this tier. The loot box is still available; please try again or contact an administrator.',
      embeds: [],
      components: [],
    });
  }
}

async function updateLootBox(guildDoc, lootBox, member, expiresAt = null) {
  try {
    await lootBox.message.edit({
      embeds: [lootBoxEmbed(guildDoc, {
        number: lootBox.state.number,
        category: lootBox.state.category,
        reward: lootBox.state.reward,
        owner: `${member}${expiresAt ? ` (expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>)` : ''}`,
      })],
      components: [],
    });
  } catch (err) {
    logger.error('loot_box_claim_announcement_failed', {
      guildId: guildDoc.guildId,
      messageId: lootBox.message.id,
      userId: member.id,
      error: err.message,
    });
  }
}

async function markLootBoxUnavailable(guildDoc, lootBox) {
  lootBox.state.unavailable = true;
  const embed = lootBoxEmbed(guildDoc, {
    number: lootBox.state.number,
    category: lootBox.state.category,
    reward: lootBox.state.reward,
  })
    .setColor('#ED4245')
    .setDescription(`**Reward:** ${lootBox.state.reward || lootBox.state.category}\n\n⌛ This loot box is no longer available.`);
  try {
    await lootBox.message.edit({ embeds: [embed], components: [] });
  } catch (err) {
    logger.error('loot_box_expire_announcement_failed', {
      guildId: guildDoc.guildId,
      messageId: lootBox.message.id,
      error: err.message,
    });
  }
}

async function expirePendingBoxQuizzes(boxMessageId, winnerId) {
  for (const [quizId, quiz] of quizState.findByBoxMessageId(boxMessageId)) {
    quizState.remove(quizId);
    if (quiz.messageRef?.edit) {
      await quiz.messageRef.edit({
        content: `⌛ Time’s up — <@${winnerId}> has claimed this loot box.`,
        embeds: [],
        components: [],
      }).catch((err) => logger.warn('loot_box_quiz_close_failed', { quizId, error: err.message }));
    }
  }
}

function shouldSendPublicProductClaim({ mode, channel }) {
  return Boolean(channel && mode !== 'prefix');
}

function resolveProductDropRules({ product, mode, settings, tierConfig, tierName, channelId }) {
  const configuredDailyLimit = product.dailyLimit;
  const productDailyLimit = configuredDailyLimit === 0
    ? null
    : configuredDailyLimit ?? tierConfig.dailyLimit;
  const dailyLimit = mode === 'button'
    ? (configuredDailyLimit === null || configuredDailyLimit === undefined
      ? (settings.buttonDailyLimit ?? 4)
      : configuredDailyLimit === 0 ? null : configuredDailyLimit)
    : productDailyLimit;
  return {
    dailyLimit,
    cooldownMinutes: product.cooldowns?.get(tierName) ?? product.cooldownMinutes ?? (mode === 'button'
      ? (settings.buttonCooldownMinutes ?? 0)
      : tierConfig.cooldownMinutes),
    challengeEveryClaims: settings.challengeEveryClaims ?? 3,
    usageChannelId: mode === 'prefix'
      ? `product-${product.commandName || product.name}`
      : mode === 'button' ? `button-${product.commandName || product.name}` : channelId,
  };
}

async function attemptProductDrop({ guildDoc, member, channel, product, mode, tierSettings = null, reply, skipQuiz = false }) {
  const tierName = resolveTier(guildDoc, member);
  const tierConfig = guildDoc.getTier(tierName);
  if (!tierConfig) {
    return reply({ content: 'Tiers are not configured yet. Ask an admin to run `/setup`.' });
  }

  const category = guildDoc.getCategory(product.category);
  if (!category) {
    return reply({ content: `Product **${product.name}** is temporarily unavailable.` });
  }
  if (!tierConfig.categories.includes(category.name)) {
    return reply({ content: `Your tier (**${tierConfig.label}**) does not have access to **${category.name}**.` });
  }

  const quantity = product.quantities.get(tierName) ?? 1;
  if (quantity < 1) {
    return reply({ content: `Product **${product.name}** is not available to your tier.` });
  }
  const creditCost = Number(product.creditCost || 0);
  const creditUser = await ensureCreditUser(guildDoc, member.id);
  if (creditCost > 0 && creditUser.credits < creditCost) {
    return reply({ content: `This drop costs **${creditCost}** credits; your wallet has **${creditUser.credits}**. Earn credits or ask an administrator for help.` });
  }
  const settings = tierSettings || {
    buttonDailyLimit: 4,
    buttonCooldownMinutes: 0,
    prefixCooldownMinutes: 0,
    challengeEveryClaims: 3,
  };
  const {
    dailyLimit,
    cooldownMinutes,
    challengeEveryClaims,
    usageChannelId,
  } = resolveProductDropRules({
    product,
    mode,
    settings,
    tierConfig,
    tierName,
    channelId: channel.id,
  });
  const usageKey = {
    userId: member.id,
    guildId: guildDoc.guildId,
    channelId: usageChannelId,
    mode,
  };

  const previousUsage = await DropUsage.findOne(usageKey).lean();
  const today = new Date().toISOString().slice(0, 10);
  if (dailyLimit !== null && previousUsage?.dayKey === today && previousUsage.dailyClaims >= dailyLimit) {
    return reply({ content: `You've used all **${dailyLimit}** product claims for today.` });
  }
  if (cooldownMinutes > 0 && previousUsage?.lastClaimAt) {
    const remainingMs = cooldownMinutes * 60_000 - (Date.now() - previousUsage.lastClaimAt.getTime());
    if (remainingMs > 0) {
      const remainingMinutes = Math.ceil(remainingMs / 60_000);
      return reply({ content: `Please wait **${remainingMinutes} minute(s)** before claiming another product.` });
    }
  }

  const available = await Stock.countAvailable(category.name);
  if (available < quantity) {
    return reply({ content: `**${category.name}** has only **${available}** item(s) available; this product needs **${quantity}** for your tier.` });
  }

  if (!skipQuiz && (previousUsage?.successfulClaims || 0) + 1 >= challengeEveryClaims &&
    ((previousUsage?.successfulClaims || 0) + 1) % challengeEveryClaims === 0) {
    return startProductQuiz({ guildDoc, member, channel, product, mode, reply, categoryName: category.name });
  }

  let spentBalance = null;
  if (creditCost > 0) {
    try {
      spentBalance = await spendCredits({
        guildDoc,
        userId: member.id,
        amount: creditCost,
        reason: `${product.name} drop claim`,
      });
    } catch (error) {
      logger.error('drop_credit_spend_failed', {
        guildId: guildDoc.guildId,
        userId: member.id,
        product: product.name,
        error: error.message,
      });
      return reply({ content: 'Your credits could not be safely charged. No items were claimed; please try again.' });
    }
    if (spentBalance === null) {
      return reply({ content: `This drop costs **${creditCost}** credits, but your wallet no longer has enough. No items were claimed.` });
    }
  }

  const refundCredits = async () => {
    if (spentBalance === null) return true;
    try {
      await grantCredits({
        guildDoc,
        userId: member.id,
        amount: creditCost,
        source: 'drop-refund',
        reason: `Refund for failed ${product.name} claim`,
      });
      return true;
    } catch (error) {
      logger.error('drop_credit_refund_failed', {
        guildId: guildDoc.guildId,
        userId: member.id,
        product: product.name,
        error: error.message,
      });
      return false;
    }
  };

  const claimBatchId = crypto.randomUUID();
  let items;
  try {
    items = await Stock.claimMany(category.name, quantity, member.id, guildDoc.guildId, claimBatchId);
  } catch (error) {
    const refunded = await refundCredits();
    logger.error('product_stock_claim_failed', {
      guildId: guildDoc.guildId,
      userId: member.id,
      product: product.name,
      error: error.message,
    });
    return reply({
      content: `The drop could not reserve inventory.${creditCost && !refunded ? ' Your credit refund also failed; contact an administrator.' : ' No items were delivered.'}`,
    });
  }
  if (items.length !== quantity) {
    let released = true;
    try {
      await Stock.updateMany(
        { claimBatchId },
        { $set: { claimed: false, claimedBy: null, claimedInGuildId: null, claimedAt: null, claimBatchId: null } }
      );
    } catch (error) {
      released = false;
      logger.error('partial_product_stock_release_failed', {
        guildId: guildDoc.guildId,
        userId: member.id,
        product: product.name,
        error: error.message,
      });
    }
    const refunded = await refundCredits();
    return reply({
      content: `Not enough **${category.name}** stock remains for your tier's quantity. Try again later.${!released ? ' Inventory cleanup is pending; contact an administrator.' : ''}${creditCost && !refunded ? ' Your credit refund also failed; contact an administrator.' : ''}`,
    });
  }

  let usage;
  try {
    usage = await DropUsage.recordClaim({
      ...usageKey,
      dailyLimit,
      cooldownMinutes,
    });
  } catch (err) {
    let stockReleased = true;
    try {
      await Stock.updateMany(
        { claimBatchId },
        { $set: { claimed: false, claimedBy: null, claimedInGuildId: null, claimedAt: null, claimBatchId: null } }
      );
    } catch (cleanupError) {
      stockReleased = false;
      logger.error('product_stock_release_failed', {
        guildId: guildDoc.guildId,
        userId: member.id,
        product: product.name,
        error: cleanupError.message,
      });
    }
    const refunded = await refundCredits();
    logger.error('drop_usage_record_failed', { userId: member.id, guildId: guildDoc.guildId, error: err.message });
    return reply({
      content: `The claim could not be recorded. No items were delivered.${!stockReleased ? ' Inventory cleanup is pending; contact an administrator.' : ''}${creditCost && !refunded ? ' Your credit refund also failed; contact an administrator.' : ''}`,
    });
  }
  if (!usage) {
    let stockReleased = true;
    try {
      await Stock.updateMany(
        { claimBatchId },
        { $set: { claimed: false, claimedBy: null, claimedInGuildId: null, claimedAt: null, claimBatchId: null } }
      );
    } catch (cleanupError) {
      stockReleased = false;
      logger.error('product_stock_release_failed', {
        guildId: guildDoc.guildId,
        userId: member.id,
        product: product.name,
        error: cleanupError.message,
      });
    }
    const refunded = await refundCredits();
    return reply({
      content: `Your claim limit or cooldown was reached in another request. Please try again later.${!stockReleased ? ' Inventory cleanup is pending; contact an administrator.' : ''}${creditCost && !refunded ? ' Your credit refund also failed; contact an administrator.' : ''}`,
    });
  }

  const delivery = await deliverItems({
    guildDoc,
    member,
    channel: null,
    category: category.name,
    items,
    deliveryId: claimBatchId,
    announce: false,
    productName: product.name,
    description: product.description || '',
  });
  if (!delivery.delivered) {
    const cleanupFailures = [];
    for (const [label, operation] of [
      ['delivery', () => SecureDelivery.deleteOne({ _id: claimBatchId })],
      ['stock', () => Stock.updateMany(
        { claimBatchId },
        { $set: { claimed: false, claimedBy: null, claimedInGuildId: null, claimedAt: null, claimBatchId: null } }
      )],
      ['usage', () => DropUsage.releaseClaim({
        ...usageKey,
        usage,
        previousLastClaimAt: previousUsage?.lastClaimAt,
        dailyLimit,
      })],
    ]) {
      try {
        await operation();
      } catch (error) {
        cleanupFailures.push(label);
        logger.error(`product_${label}_cleanup_failed`, {
          guildId: guildDoc.guildId,
          userId: member.id,
          product: product.name,
          error: error.message,
        });
      }
    }
    const refunded = await refundCredits();
    const creditRefundMessage = creditCost && !refunded ? ' Please contact an administrator to restore your credits.' : '';
    const cleanupMessage = cleanupFailures.length
      ? ` Claim cleanup is pending for ${cleanupFailures.join(', ')}; contact an administrator.`
      : '';
    return reply({ content: `I could not DM you. Enable direct messages and try again; no items were delivered.${creditRefundMessage}${cleanupMessage}` });
  }

  notifyStockChanged();
  await Stock.updateMany({ claimBatchId }, { $set: { claimBatchId: null } });
  if (shouldSendPublicProductClaim({ mode, channel })) {
    await channel.send({ embeds: [publicClaimEmbed(guildDoc, { user: `${member}`, category: category.name, dropType: category.dropType })] }).catch(() => {});
  }
  try {
    await DropUsage.recordSuccessfulClaim(usageKey);
  } catch (err) {
    logger.error('drop_success_count_failed', { userId: member.id, guildId: guildDoc.guildId, error: err.message });
    const deliveredCount = delivery.deliveredCount ?? items.length;
    return reply({ content: `✅ DMed **${deliveredCount}** item(s) from **${product.name}**, but I could not update the verification counter. Please contact an administrator.` });
  }
  const deliveredCount = delivery.deliveredCount ?? items.length;
  const cleanupMessage = delivery.cleanupPending ? ' Automatic inventory cleanup is pending; please contact an administrator.' : '';
  const partialMessage = delivery.partial ? ` Discord only accepted ${deliveredCount} of ${items.length} items in DMs; the rest were returned to inventory.` : '';
  const balanceMessage = creditCost ? ` **${spentBalance}** credits remain in your wallet.` : '';
  return reply({ content: `✅ DMed **${deliveredCount}** item(s) from **${product.name}**.${balanceMessage}${partialMessage}${cleanupMessage}` });
}

async function startProductQuiz({ guildDoc, member, channel, product, mode, reply, categoryName }) {
  const quizId = crypto.randomUUID();
  const prompt = captchaPrompt(
    guildDoc,
    quizId,
    'CAPTCHA verification',
    `Enter the 6 characters shown below within ${QUIZ_TIME_LIMIT_MS / 1000}s to claim **${product.name}**.`
  );
  const sent = await reply({ content: `${member}`, ...prompt.payload });
  quizState.create(quizId, {
    kind: mode === 'button' ? 'button-product' : 'product',
    userId: member.id,
    guildId: guildDoc.guildId,
    productName: product.name,
    mode,
    category: categoryName,
    channelId: channel.id,
    answer: prompt.answer,
    attempts: 0,
    messageRef: sent,
  });
  setTimeout(() => expireQuiz(quizId), QUIZ_TIME_LIMIT_MS).unref();
  return sent;
}

// ---------- Quiz gate ----------

async function startQuiz({ guildDoc, member, channel, category, quantity = 1, userDoc, reply, lootBox = null }) {
  const quizId = crypto.randomUUID();
  const prompt = captchaPrompt(
    guildDoc,
    quizId,
    'CAPTCHA verification',
    `Enter the 6 characters shown below within ${QUIZ_TIME_LIMIT_MS / 1000}s. You will receive ${quantity} item(s).`
  );
  const sent = await reply({ content: lootBox ? undefined : `${member}`, ...prompt.payload });

  quizState.create(quizId, {
    kind: lootBox ? 'lootbox' : 'category',
    userId: member.id,
    guildId: guildDoc.guildId,
    category,
    quantity,
    answer: prompt.answer,
    attempts: 0,
    channelId: channel?.id || null,
    boxMessageId: lootBox?.message.id || null,
    messageRef: sent, // Message object when available, for editing on timeout
  });

  setTimeout(() => expireQuiz(quizId), QUIZ_TIME_LIMIT_MS).unref();
}

async function expireQuiz(quizId) {
  const quiz = quizState.get(quizId);
  if (!quiz) return; // already answered
  quizState.remove(quizId);
  if (quiz.messageRef?.edit) {
    const box = quiz.boxMessageId ? quizState.get(quiz.boxMessageId) : null;
    const content = box?.claimedBy
      ? '⌛ Time’s up — someone else has claimed this loot box.'
      : quiz.boxMessageId
        ? '⌛ Verification timed out. This loot box is still available — click 🎁 to try again.'
        : '⌛ Time is up — that drop expired.';
    await quiz.messageRef.edit({ content, embeds: [], components: [] }).catch(() => {});
  }
}

async function showCaptchaModal(interaction, quizId) {
  const captcha = quizState.get(quizId);
  if (!captcha) {
    return interaction.reply({ content: 'This CAPTCHA has expired.', ephemeral: true });
  }
  if (interaction.user.id !== captcha.userId) {
    return interaction.reply({ content: "This isn't your CAPTCHA to answer.", ephemeral: true });
  }

  const answer = new TextInputBuilder()
    .setCustomId('captcha_answer')
    .setLabel('Enter the 6 characters shown in the image')
    .setStyle(TextInputStyle.Short)
    .setMinLength(6)
    .setMaxLength(6)
    .setRequired(true);
  const modal = new ModalBuilder()
    .setCustomId(`quiz:answer:${quizId}`)
    .setTitle('CAPTCHA verification')
    .addComponents(new ActionRowBuilder().addComponents(answer));
  return interaction.showModal(modal);
}

function buildCaptchaCompletedPayload(quiz) {
  const image = [...(quiz.messageRef?.attachments?.values?.() || [])]
    .find((attachment) => attachment.name === 'captcha.png');
  const embed = new EmbedBuilder()
    .setColor('#57F287')
    .setTitle('CAPTCHA completed')
    .setDescription('Verification complete. Processing your claim…');
  if (image) embed.setImage(`attachment://${image.name}`);

  return {
    content: null,
    embeds: [embed],
    components: [],
    attachments: image ? [{ id: image.id }] : [],
  };
}

async function handleQuizAnswer(interaction, quizId, Guild) {
  const quiz = quizState.get(quizId);
  if (!quiz) {
    return interaction.reply({ content: 'This CAPTCHA has expired.', ephemeral: true });
  }
  if (interaction.user.id !== quiz.userId) {
    return interaction.reply({ content: "This isn't your CAPTCHA to answer.", ephemeral: true });
  }

  const box = quiz.boxMessageId ? quizState.get(quiz.boxMessageId) : null;
  if (quiz.boxMessageId && (!box || box.claimedBy || box.claiming || box.unavailable)) {
    quizState.remove(quizId);
    return interaction.update({
      content: `⌛ Time’s up — ${box?.claimedBy ? 'someone else has claimed this loot box.' : 'this loot box is no longer available.'}`,
      embeds: [],
      components: [],
    });
  }

  const answer = interaction.fields.getTextInputValue('captcha_answer').trim().toUpperCase();
  if (answer !== quiz.answer) {
    quiz.attempts = (quiz.attempts || 0) + 1;
    if (quiz.attempts >= 3) {
      quizState.remove(quizId);
      await quiz.messageRef?.edit({
        content: '❌ CAPTCHA failed. Start the claim again for a new challenge.',
        embeds: [],
        components: [],
      }).catch(() => {});
      return interaction.reply({ content: 'Too many incorrect CAPTCHA attempts.', ephemeral: true });
    }
    return interaction.reply({ content: `Incorrect CAPTCHA. Try again (${3 - quiz.attempts} attempt(s) left).`, ephemeral: true });
  }

  quizState.remove(quizId);
  const guildDoc = await Guild.getOrCreate(quiz.guildId);
  await interaction.update(buildCaptchaCompletedPayload(quiz));
  const replyAfterCaptcha = (payload) => interaction.followUp({
    ...payload,
    ephemeral: quiz.kind === 'lootbox' || quiz.kind === 'tier-lootbox' || quiz.kind === 'button-product',
  });

  if (quiz.kind === 'tier-lootbox') {
    return finalizeTierBoxClaim(interaction, guildDoc, box, replyAfterCaptcha);
  }

  if (quiz.kind === 'product' || quiz.kind === 'button-product') {
    const product = guildDoc.dropProducts.find((entry) => entry.name === quiz.productName);
    const channelConfig = guildDoc.dropChannels.find((entry) => entry.channelId === quiz.channelId);
    if (!product) {
      return replyAfterCaptcha({ content: 'That product is no longer available.', embeds: [], components: [] });
    }
    const currentTier = resolveTier(guildDoc, interaction.member);
    return attemptProductDrop({
      guildDoc,
      member: interaction.member,
      channel: interaction.channel,
      product,
      mode: quiz.mode,
      tierSettings: channelConfig?.tierSettings.get(currentTier),
      skipQuiz: true,
      reply: replyAfterCaptcha,
    });
  }

  const userDoc = await User.getOrCreate(quiz.userId, quiz.guildId);
  if (quiz.kind === 'lootbox') {
    return finalizeClaim({
      guildDoc,
      member: interaction.member,
      channel: interaction.channel,
      category: quiz.category,
      quantity: quiz.quantity || 1,
      userDoc,
      lootBox: { state: box, message: box.messageRef },
      reply: replyAfterCaptcha,
    });
  }

  const deliveryId = crypto.randomUUID();
  const quantity = quiz.quantity || 1;
  const items = await Stock.claimMany(quiz.category, quantity, quiz.userId, quiz.guildId, deliveryId);
  if (items.length !== quantity) {
    return replyAfterCaptcha({ embeds: [outOfStockEmbed(guildDoc, quiz.category)], components: [] });
  }

  const channel = interaction.channel;
  const delivery = await deliverItems({
    guildDoc,
    member: interaction.member,
    channel,
    category: quiz.category,
    items,
    deliveryId,
  });
  if (!delivery.delivered) {
    await Stock.updateMany(
      { claimBatchId: deliveryId, claimed: true, claimedBy: quiz.userId },
      { $set: { claimed: false, claimedBy: null, claimedInGuildId: null, claimedAt: null, claimBatchId: null } }
    );
    return replyAfterCaptcha({ content: 'I could not DM your drop. Enable direct messages and try again; the stock was returned.', embeds: [], components: [] });
  }

  notifyStockChanged();
  recordDrop(userDoc);
  await userDoc.save();

  const cleanupMessage = delivery.cleanupPending ? ' Automatic inventory cleanup is pending; please contact an administrator.' : '';
  const deliveredCount = delivery.deliveredCount ?? items.length;
  const partialMessage = delivery.partial ? ` Discord only accepted ${deliveredCount} of ${items.length} items in DMs; the rest were returned to inventory.` : '';
  return replyAfterCaptcha({ content: `✅ Correct! Check your DMs for **${deliveredCount}** item(s).${partialMessage}${cleanupMessage}`, embeds: [], components: [] });
}

async function showSecureDeliveryModal(interaction, deliveryId) {
  const delivery = await SecureDelivery.findOne({
    _id: deliveryId,
    userId: interaction.user.id,
    completed: false,
  }).lean();
  if (!delivery) {
    const knownDelivery = await SecureDelivery.findOne({ _id: deliveryId, userId: interaction.user.id }).lean();
    return interaction.reply({
      content: knownDelivery?.completed
        ? 'These items have already been secured.'
        : 'This secure action is unavailable. Request a fresh drop if the button is from an old message.',
    });
  }
  const quantity = Math.min(delivery.secureItemsPerClick, 25);
  const modal = new ModalBuilder()
    .setCustomId(`secure:submit:${deliveryId}`)
    .setTitle('Choose key or link to secure');
  const input = new TextInputBuilder()
    .setCustomId('item_values')
    .setLabel(`Paste up to ${quantity} exact item value(s)`)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setPlaceholder(quantity === 1
      ? 'Paste the exact key or link from your DM'
      : `Paste each exact key or link on its own line (up to ${quantity})`);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

async function handleSecureDeliveryModal(interaction, deliveryId) {
  const values = interaction.fields.getTextInputValue('item_values')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const uniqueValues = [...new Set(values)];
  if (!uniqueValues.length) {
    return interaction.reply({ content: 'Paste the exact key or link you want to secure.' });
  }

  const staleProcessingBefore = new Date(Date.now() - 30_000);
  const delivery = await SecureDelivery.findOneAndUpdate(
    {
      _id: deliveryId,
      userId: interaction.user.id,
      completed: false,
      $or: [
        { processing: false },
        { processingAt: null },
        { processingAt: { $lte: staleProcessingBefore } },
      ],
    },
    { $set: { processing: true, processingAt: new Date() } },
    { new: true }
  );
  if (!delivery) {
    const knownDelivery = await SecureDelivery.findOne({ _id: deliveryId, userId: interaction.user.id }).lean();
    return interaction.reply({
      content: knownDelivery?.completed
        ? 'These items have already been secured.'
        : knownDelivery?.processing
          ? 'This secure action is still running. Wait a few seconds and press the button again if it remains.'
          : 'This secure action is unavailable. Request a fresh drop if the button is from an old message.',
    });
  }

  const securedIds = new Set((delivery.securedItemIds || []).map(String));
  if (!securedIds.size && delivery.securedCount > 0) {
    const legacySecuredIds = delivery.itemIds.slice(0, delivery.securedCount);
    try {
      await SecureDelivery.updateOne(
        { _id: deliveryId, processing: true },
        { $addToSet: { securedItemIds: { $each: legacySecuredIds } } }
      );
    } catch (err) {
      await SecureDelivery.updateOne(
        { _id: deliveryId, processing: true },
        { $set: { processing: false, processingAt: null } }
      );
      logger.error('secure_delivery_legacy_progress_migration_failed', { deliveryId, error: err.message });
      return interaction.reply({ content: 'I could not load this secure action. Please try again.' });
    }
    for (const itemId of legacySecuredIds) securedIds.add(String(itemId));
  }
  const availableIds = delivery.itemIds.filter((itemId) => !securedIds.has(String(itemId)));
  if (uniqueValues.length > delivery.secureItemsPerClick) {
    await SecureDelivery.updateOne({ _id: deliveryId, processing: true }, { $set: { processing: false, processingAt: null } });
    return interaction.reply({ content: `Your tier can secure up to ${delivery.secureItemsPerClick} item(s) at a time. Submit fewer values.` });
  }

  const knownValues = new Map(delivery.itemIds.map((itemId, index) => [
    String(itemId),
    delivery.itemValues?.[index],
  ]));
  let legacyStockValues = [];
  if (!delivery.itemValues?.length) {
    try {
      legacyStockValues = await Stock.find({ _id: { $in: availableIds } })
        .select({ _id: 1, value: 1 })
        .lean();
    } catch (err) {
      await SecureDelivery.updateOne(
        { _id: deliveryId, processing: true },
        { $set: { processing: false, processingAt: null } }
      );
      logger.error('secure_delivery_item_lookup_failed', { deliveryId, error: err.message });
      return interaction.reply({ content: 'I could not look up your items. Please try again.' });
    }
  }
  for (const item of legacyStockValues) knownValues.set(String(item._id), item.value);
  const pendingValues = availableIds.map((itemId) => {
    return { itemId, value: knownValues.get(String(itemId)) };
  });
  const matched = [];
  const remainingPending = [...pendingValues];
  for (const value of uniqueValues) {
    const index = remainingPending.findIndex((entry) => entry.value === value);
    if (index >= 0) matched.push(remainingPending.splice(index, 1)[0]);
  }
  if (!matched.length) {
    await SecureDelivery.updateOne({ _id: deliveryId, processing: true }, { $set: { processing: false, processingAt: null } });
    return interaction.reply({ content: 'I could not find that exact key or link in this DM. Copy and paste the full value from your drop.' });
  }

  try {
    const matchedIds = matched.map((item) => item.itemId);
    const stockItems = await Stock.find({ _id: { $in: matchedIds } })
      .select({ _id: 1, claimed: 1, claimedBy: 1 })
      .lean();
    const stockById = new Map(stockItems.map((item) => [String(item._id), item]));
    const removableIds = matchedIds.filter((itemId) => {
      const stockItem = stockById.get(String(itemId));
      return stockItem?.claimed && stockItem.claimedBy === interaction.user.id;
    });
    const inaccessibleIds = matchedIds.filter((itemId) => {
      const stockItem = stockById.get(String(itemId));
      return stockItem && (!stockItem.claimed || stockItem.claimedBy !== interaction.user.id);
    });
    if (!removableIds.length && inaccessibleIds.length === matchedIds.length) {
      await SecureDelivery.updateOne({ _id: deliveryId, processing: true }, { $set: { processing: false, processingAt: null } });
      return interaction.reply({ content: 'That item is no longer reserved for you, so it was not removed.' });
    }
    const result = removableIds.length
      ? await Stock.deleteMany({
        _id: { $in: removableIds },
        claimed: true,
        claimedBy: interaction.user.id,
      })
      : { deletedCount: 0 };
    if (result.deletedCount !== removableIds.length) {
      throw new Error(`Expected to secure ${removableIds.length} claimed items but removed ${result.deletedCount}.`);
    }
    const securedNow = [...removableIds, ...matchedIds.filter((itemId) => !stockById.has(String(itemId)))];
    if (!securedNow.length) {
      await SecureDelivery.updateOne({ _id: deliveryId, processing: true }, { $set: { processing: false, processingAt: null } });
      return interaction.reply({ content: 'Those values no longer match items reserved in your delivery.' });
    }
    const totalSecured = Math.min(delivery.itemIds.length, (delivery.securedCount || 0) + securedNow.length);
    const completed = totalSecured >= delivery.itemIds.length;
    const update = await SecureDelivery.updateOne(
      { _id: deliveryId, processing: true },
      {
        $addToSet: { securedItemIds: { $each: securedNow } },
        $set: { securedCount: totalSecured, processing: false, processingAt: null, completed },
      }
    );
    if (!update.matchedCount) throw new Error('Secure delivery lock was lost before its progress could be saved.');
    const remaining = delivery.itemIds.length - totalSecured;
    const button = new ButtonBuilder()
      .setCustomId(`secure:${deliveryId}`)
      .setLabel('Secure key or link')
      .setStyle(ButtonStyle.Success);
    const components = remaining ? [new ActionRowBuilder().addComponents(button)] : [];
    const invalidCount = uniqueValues.length - matched.length;
    const detail = invalidCount ? ` ${invalidCount} pasted value(s) were not part of this delivery.` : '';
    return interaction.update({
      content: `🔐 Removed **${removableIds.length}** matching item(s) from shared inventory.${detail}${remaining ? ` ${remaining} item(s) remain; press the button to secure more.` : ' All items in this delivery are secured.'}`,
      components,
    });
  } catch (err) {
    await SecureDelivery.updateOne(
      { _id: deliveryId, processing: true },
      { $set: { processing: false, processingAt: null } }
    );
    logger.error('secure_delivery_remove_failed', {
      deliveryId,
      userId: interaction.user.id,
      error: err.message,
    });
    return interaction.reply({
      content: 'I could not finish recording this secure action. Please try again; already-removed items will not be removed twice.',
    });
  }
}

module.exports = {
  attemptDrop,
  attemptProductDrop,
  buildCaptchaCompletedPayload,
  showCaptchaModal,
  handleQuizAnswer,
  handleLootBoxClaim,
  showSecureDeliveryModal,
  handleSecureDeliveryModal,
  shouldSendPublicProductClaim,
  resolveProductDropRules,
};
