'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const CooldownReward = require('../schemas/CooldownReward');
const Stock = require('../schemas/GlobalStock');
const { resetCooldowns } = require('../utils/resetCooldowns');
const logger = require('../utils/logger');

const REWARD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function cooldownRewardPayload(reward, footer = 'Key Drop Bot') {
  const expiresAt = Math.floor(reward.expiresAt.getTime() / 1000);
  return {
    embeds: [new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('Cooldown refresh reward')
      .setDescription(`Press **Activate** to refresh all your cooldowns in this server. This reward expires <t:${expiresAt}:R>.`)
      .setFooter({ text: footer })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`cooldown-reward:activate:${reward.id || reward._id}`)
        .setLabel('Activate')
        .setStyle(ButtonStyle.Success)
    )],
  };
}

async function issueCooldownReward({ guildId, userId, source, itemIds = [] }) {
  return CooldownReward.create({
    _id: require('node:crypto').randomUUID(),
    guildId,
    userId,
    itemIds,
    source,
    expiresAt: new Date(Date.now() + REWARD_LIFETIME_MS),
  });
}

async function activateCooldownReward(interaction, rewardId) {
  const now = new Date();
  const reward = await CooldownReward.findOneAndUpdate(
    {
      _id: rewardId,
      userId: interaction.user.id,
      activatedAt: null,
      expiredAt: null,
      expiresAt: { $gt: now },
      $or: [
        { processing: false },
        { processingAt: null },
        { processingAt: { $lte: new Date(now.getTime() - 30_000) } },
      ],
    },
    { $set: { processing: true, processingAt: now } },
    { new: true }
  );
  if (!reward) {
    const knownReward = await CooldownReward.findOne({ _id: rewardId, userId: interaction.user.id }).lean();
    const message = !knownReward
      ? 'This cooldown reward is unavailable.'
      : knownReward.activatedAt
        ? 'This cooldown reward has already been activated.'
        : knownReward.expiredAt || knownReward.expiresAt <= now
          ? 'This cooldown reward has expired.'
          : 'This reward is already being activated. Wait a moment and try again.';
    return interaction.reply({ content: message, ephemeral: true });
  }

  try {
    if (reward.itemIds.length) {
      await Stock.deleteMany({
        _id: { $in: reward.itemIds },
        claimed: true,
        claimedBy: interaction.user.id,
      });
    }
    await resetCooldowns(reward.userId, reward.guildId);
    reward.activatedAt = new Date();
    reward.processing = false;
    reward.processingAt = null;
    await reward.save();
  } catch (err) {
    await CooldownReward.updateOne(
      { _id: rewardId, processing: true, activatedAt: null },
      { $set: { processing: false, processingAt: null } }
    );
    logger.error('cooldown_reward_activation_failed', {
      rewardId,
      guildId: reward.guildId,
      userId: reward.userId,
      error: err.message,
    });
    return interaction.reply({ content: 'Could not activate the reward. It remains available; please try again.', ephemeral: true });
  }
  return interaction.update({
    content: '✅ All your cooldowns in this server have been refreshed.',
    embeds: [],
    components: [],
  });
}

async function expireCooldownRewards() {
  const now = new Date();
  const rewards = await CooldownReward.find({
    activatedAt: null,
    expiredAt: null,
    processing: false,
    expiresAt: { $lte: now },
    itemIds: { $ne: [] },
  }).limit(100);
  for (const reward of rewards) {
    if (reward.itemIds.length) {
      await Stock.updateMany(
        {
          _id: { $in: reward.itemIds },
          claimed: true,
          claimedBy: reward.userId,
          archived: { $ne: true },
        },
        { $set: { claimed: false, claimedBy: null, claimedInGuildId: null, claimedAt: null, claimBatchId: null } }
      );
    }
    reward.expiredAt = now;
    await reward.save();
  }
}

function startCooldownRewardExpiryWorker() {
  const sweep = () => expireCooldownRewards().catch((err) => {
    logger.error('cooldown_reward_expiry_sweep_failed', { error: err.message });
  });
  sweep();
  setInterval(sweep, 60_000).unref();
}

module.exports = {
  REWARD_LIFETIME_MS,
  cooldownRewardPayload,
  issueCooldownReward,
  activateCooldownReward,
  startCooldownRewardExpiryWorker,
};
