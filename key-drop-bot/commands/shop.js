'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const Guild = require('../schemas/Guild');
const ShopTrialClaim = require('../schemas/ShopTrialClaim');
const { TIER_NAMES, DEFAULT_SECURE_ITEMS_PER_CLICK } = require('../config/constants');
const logger = require('../utils/logger');
const { resolveTier } = require('../utils/permissions');
const { claimDailyCredits } = require('../utils/credits');
const { claimInviteCredits } = require('../utils/inviteCredits');
const { addTimedTierRole } = require('../handlers/tierGrants');

function tierDescription(guildDoc, tier, tierName) {
  const price = tier.price > 0 ? `$${tier.price.toFixed(2)}` : 'Free';
  const secureItemsPerClick = tier.secureItemsPerClick ?? DEFAULT_SECURE_ITEMS_PER_CLICK[tierName];
  const products = guildDoc.dropProducts.filter((product) => tier.categories.includes(product.category));
  const productDetails = products.length
    ? products.slice(0, 5).map((product) =>
      `${product.name}: ${product.quantities.get(tierName) ?? 1}/claim`)
      .join(' · ') + (products.length > 5 ? ` · +${products.length - 5} more` : '')
    : 'No product generators currently enabled';
  const averageCooldown = products.length
    ? products.reduce((total, product) =>
      total + (product.cooldowns?.get(tierName) ?? product.cooldownMinutes ?? tier.cooldownMinutes), 0) / products.length
    : tier.cooldownMinutes;
  const averageItems = products.length
    ? products.reduce((total, product) => total + (product.quantities.get(tierName) ?? 1), 0) / products.length
    : 0;
  const captchaIntervals = [...new Set(guildDoc.dropChannels
    .map((channel) => channel.tierSettings.get(tierName)?.challengeEveryClaims ?? 3))].sort((a, b) => b - a);
  const captchaSummary = captchaIntervals.length === 1
    ? `every ${captchaIntervals[0]} product claims`
    : captchaIntervals.length
      ? `every ${captchaIntervals.join(' or ')} product claims, by channel`
      : 'every 3 product claims by default';
  const trial = tier.trialEnabled ? `\n**Trial:** ${tier.trialDurationHours} hour(s), one per member per server` : '';
  const details = [
    (tier.description || 'Tier access and drop benefits.').slice(0, 850),
    `**Price:** ${price}`,
    `**Daily drops:** ${tier.dailyLimit}`,
    `**Cooldown (average):** ${averageCooldown.toFixed(1)} minute(s) across product generators; tier drop cooldown ${tier.cooldownMinutes} minute(s)`,
    `**Product generators:** ${products.length} available; average ${averageItems.toFixed(1)} items per claim; ${productDetails}`,
    `**Captcha frequency:** ${captchaSummary} (higher means fewer checks)`,
    `**Secure action:** ${secureItemsPerClick === 0 ? 'Automatic removal' : `${secureItemsPerClick} item(s) per click`}`,
  ].concat(trial);
  return details.join('\n');
}

function buildShopEmbed(guildDoc, guild) {
  const embed = new EmbedBuilder()
    .setColor(guildDoc.embedStyle?.color || '#5865F2')
    .setTitle(`${guild.name} tier shop`)
    .setDescription('Choose a tier below to open a private purchase ticket with the server owner. Payments are arranged in the ticket; the bot does not process them.')
    .addFields(TIER_NAMES.map((tierName) => {
      const tier = guildDoc.getTier(tierName);
      const price = tier.price > 0 ? `$${tier.price.toFixed(2)}` : 'Free';
      const accessible = guildDoc.dropProducts
        .filter((product) => tier.categories.includes(product.category))
        .slice(0, 4)
        .map((product) => `${product.name}: ${product.quantities.get(tierName) ?? 1}/claim`);
      return {
        name: tier.label || tierName,
        value: [
          (tier.description || 'Tier access and drop benefits.').slice(0, 500),
          `**Price:** ${price} · **Daily limit:** ${tier.dailyLimit} · **Cooldown:** ${tier.cooldownMinutes}m`,
          `**Products:** ${accessible.join(' · ') || 'No product generators yet'}`,
          `**Secure action:** ${tier.secureItemsPerClick === 0 ? 'Automatic' : `${tier.secureItemsPerClick ?? DEFAULT_SECURE_ITEMS_PER_CLICK[tierName]} item(s) per click`}`,
          tier.trialEnabled ? `**Trial:** ${tier.trialDurationHours} hour(s), one per member` : '',
        ].join('\n'),
        inline: false,
      };
    }));

  const settings = guildDoc.creditSettings;
  const earningMethods = [];
  if (settings.dailyEnabled) {
    const rewards = TIER_NAMES.map((tierName) =>
      `${guildDoc.getTier(tierName)?.label || tierName}: ${settings.dailyAmounts.get(tierName) ?? 0}`
    ).join(' · ');
    earningMethods.push(`**Daily:** ${rewards} credits every ${settings.dailyCooldownHours} hour(s).`);
  }
  if (settings.messageEnabled) {
    earningMethods.push(`**Messages:** ${settings.messageCredits} credits after each ${settings.messageCooldownMinutes}-minute cooldown, up to ${settings.messageDailyCap} per day in configured channels.`);
  }
  if (settings.invitesEnabled) {
    earningMethods.push(`**Invites:** ${settings.inviteCredits} credits for each verified non-bot member who stays ${settings.inviteMemberAgeHours} hour(s). Claim verified invites below.`);
  }
  embed.addFields({
    name: 'Free ways to earn credits',
    value: earningMethods.join('\n') || 'No free credit-earning methods are enabled.',
    inline: false,
  });
  if (guildDoc.embedStyle?.footer) embed.setFooter({ text: guildDoc.embedStyle.footer });
  return embed;
}

function buildShopPayload(guildDoc, guild) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId('shop:buy')
      .setLabel('Purchase a tier')
      .setStyle(ButtonStyle.Success),
  ];
  if (guildDoc.dropProducts.length) {
    buttons.push(new ButtonBuilder()
      .setCustomId('shop:products')
      .setLabel('Explain a product')
      .setStyle(ButtonStyle.Secondary));
  }
  for (const tierName of TIER_NAMES) {
    const tier = guildDoc.getTier(tierName);
    if (!tier?.trialEnabled || !tier.roleId) continue;
    buttons.push(new ButtonBuilder()
      .setCustomId(`shop:trial:${tierName}`)
      .setLabel(`${tier.label || tierName} trial`)
      .setStyle(ButtonStyle.Primary));
  }
  if (guildDoc.creditSettings.dailyEnabled) {
    buttons.push(new ButtonBuilder()
      .setCustomId('shop:daily')
      .setLabel('Claim daily credits')
      .setStyle(ButtonStyle.Primary));
  }
  if (guildDoc.creditSettings.invitesEnabled) {
    buttons.push(new ButtonBuilder()
      .setCustomId('shop:invites')
      .setLabel('Claim invites')
      .setStyle(ButtonStyle.Secondary));
  }
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(index, index + 5)));
  }
  return {
    embeds: [buildShopEmbed(guildDoc, guild)],
    components: rows,
  };
}

async function publishShopPanel({ guildDoc, guild, channel }) {
  const savedPanel = guildDoc.publishedShops.find((entry) => entry.channelId === channel.id);
  let existingMessage = null;
  if (savedPanel) {
    try {
      existingMessage = await channel.messages.fetch(savedPanel.messageId);
    } catch (error) {
      if (![10003, 10008].includes(Number(error.code))) throw error;
    }
  }

  const payload = buildShopPayload(guildDoc, guild);
  const message = existingMessage
    ? await existingMessage.edit(payload)
    : await channel.send(payload);
  if (!savedPanel) guildDoc.publishedShops.push({ channelId: channel.id, messageId: message.id });
  else savedPanel.messageId = message.id;
  try {
    await guildDoc.save();
  } catch (error) {
    if (!existingMessage) {
      await message.delete().catch((cleanupError) => logger.error('shop_panel_publish_rollback_failed', {
        guildId: guild.id,
        messageId: message.id,
        error: cleanupError.message,
      }));
    }
    throw error;
  }
  return message;
}

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to publish the shop panel.', ephemeral: true });
  }

  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  try {
    await publishShopPanel({
      guildDoc,
      guild: interaction.guild,
      channel: interaction.channel,
    });
  } catch (err) {
    logger.error('shop_panel_post_failed', { guildId: interaction.guildId, channelId: interaction.channelId, error: err.message });
    return interaction.reply({ content: 'Could not post the shop panel. Check that the bot can send messages and embeds here.', ephemeral: true });
  }
  return interaction.reply({ content: `Shop panel posted in ${interaction.channel}.`, ephemeral: true });
}

async function handleComponent(interaction) {
  const [, action, tierName] = interaction.customId.split(':');
  if (action === 'buy') return showTierOptions(interaction);
  if (action === 'daily') return handleDailyClaim(interaction);
  if (action === 'invites') return handleInviteClaim(interaction);
  if (action === 'trial') return handleTrialClaim(interaction, tierName);
  if (action === 'products') return showProductChooser(interaction);
  if (action === 'product-select') return showProductDetails(interaction, interaction.values?.[0]);
  if (action === 'tier') return selectTier(interaction, tierName);
  if (action === 'open') return openTicket(interaction, tierName);
  return interaction.reply({ content: 'Unknown shop action.', ephemeral: true });
}

async function handleTrialClaim(interaction, tierName) {
  if (!interaction.guildId || !TIER_NAMES.includes(tierName)) {
    return interaction.reply({ content: 'That shop trial is not available.', ephemeral: true });
  }
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const tier = guildDoc.getTier(tierName);
  if (!tier?.trialEnabled || !tier.roleId) {
    return interaction.reply({ content: 'That tier does not currently offer a trial.', ephemeral: true });
  }
  const existing = await ShopTrialClaim.findOne({
    guildId: interaction.guildId,
    userId: interaction.user.id,
  }).lean();
  if (existing) {
    return interaction.reply({
      content: `You already used your one-time ${existing.tier} trial in this server.`,
      ephemeral: true,
    });
  }

  const now = new Date();
  const durationMs = tier.trialDurationHours * 60 * 60 * 1000;
  let claim;
  try {
    claim = await ShopTrialClaim.create({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      tier: tierName,
      claimedAt: now,
      expiresAt: new Date(now.getTime() + durationMs),
    });
  } catch (error) {
    if (error.code === 11000) {
      return interaction.reply({ content: 'You already used your one-time trial in this server.', ephemeral: true });
    }
    throw error;
  }

  let grant;
  try {
    grant = await addTimedTierRole({
      guild: interaction.guild,
      member: interaction.member,
      tierName,
      roleId: tier.roleId,
      durationMs,
    });
  } catch (error) {
    await ShopTrialClaim.deleteOne({ _id: claim._id, userId: interaction.user.id });
    logger.error('shop_trial_grant_failed', {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      tier: tierName,
      error: error.message,
    });
    return interaction.reply({ content: 'The trial role could not be granted. No trial was consumed; contact a server administrator.', ephemeral: true });
  }
  claim.expiresAt = grant.expiresAt;
  try {
    await claim.save();
  } catch (error) {
    logger.error('shop_trial_expiry_update_failed', {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      tier: tierName,
      error: error.message,
    });
  }
  return interaction.reply({
    content: `Your ${tier.label} trial is active until <t:${Math.floor(grant.expiresAt.getTime() / 1000)}:F>. This was your one trial for this server.`,
    ephemeral: true,
  });
}

async function showProductChooser(interaction) {
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  if (!guildDoc.dropProducts.length) {
    return interaction.reply({ content: 'No product generators are available to explain right now.', ephemeral: true });
  }
  return interaction.reply({
    content: 'Choose a product to see its claim amount, tier access, cooldown, and credit cost.',
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('shop:product-select')
        .setPlaceholder('Choose a product')
        .addOptions(guildDoc.dropProducts.slice(0, 25).map((product) => ({
          label: product.name.slice(0, 100),
          value: product.commandName || product.name,
          description: (product.description || product.category).slice(0, 100),
        })))
    )],
    ephemeral: true,
  });
}

async function showProductDetails(interaction, commandName) {
  if (!commandName) return interaction.reply({ content: 'Choose a product from the menu.', ephemeral: true });
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const product = guildDoc.dropProducts.find((entry) => (entry.commandName || entry.name) === commandName);
  if (!product) return interaction.reply({ content: 'That product is no longer available.', ephemeral: true });
  const details = TIER_NAMES.map((tierName) => {
    const tier = guildDoc.getTier(tierName);
    const accessible = tier.categories.includes(product.category);
    const quantity = product.quantities.get(tierName) ?? 1;
    const cooldown = product.cooldowns?.get(tierName) ?? product.cooldownMinutes ?? tier.cooldownMinutes;
    return `**${tier.label || tierName}:** ${accessible && quantity > 0 ? `${quantity} item(s), ${cooldown}m cooldown` : 'not available'}${product.creditCost ? `, ${product.creditCost} credits/claim` : ''}`;
  });
  const embed = new EmbedBuilder()
    .setColor(product.embedColor || guildDoc.embedStyle?.color || '#5865F2')
    .setTitle(product.name)
    .setDescription([product.description || 'Product drop details.', `**Category:** ${product.category}`, ...details].join('\n').slice(0, 4000));
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleDailyClaim(interaction) {
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  try {
    const claim = await claimDailyCredits({
      guildDoc,
      userId: interaction.user.id,
      tierName: resolveTier(guildDoc, interaction.member),
    });
    if (claim.reason === 'disabled') {
      return interaction.reply({ content: 'Daily credits are not enabled in this server.', ephemeral: true });
    }
    if (claim.reason === 'cooldown') {
      const nextClaim = Math.floor((claim.lastClaimAt.getTime() + guildDoc.creditSettings.dailyCooldownHours * 3_600_000) / 1000);
      return interaction.reply({ content: `You can claim daily credits again <t:${nextClaim}:R>.`, ephemeral: true });
    }
    return interaction.reply({ content: `Claimed **${claim.amount}** credits. Your wallet now has **${claim.balance}** credits.`, ephemeral: true });
  } catch (error) {
    logger.error('daily_credit_claim_failed', { guildId: interaction.guildId, userId: interaction.user.id, error: error.message });
    return interaction.reply({ content: 'The daily credit reward could not be claimed safely. Please try again later.', ephemeral: true });
  }
}

async function handleInviteClaim(interaction) {
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  try {
    const result = await claimInviteCredits({
      guildDoc,
      guild: interaction.guild,
      userId: interaction.user.id,
    });
    if (result.reason === 'disabled') {
      return interaction.reply({ content: 'Invite credit rewards are not enabled in this server.', ephemeral: true });
    }
    if (result.reason === 'none') {
      return interaction.reply({
        content: result.pendingCount
          ? `No invites are ready yet. **${result.pendingCount}** eligible invite(s) must remain in the server for ${guildDoc.creditSettings.inviteMemberAgeHours} hour(s).`
          : 'No verified invite rewards are ready to claim.',
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: `Claimed **${result.count}** verified invite(s) for **${result.amount}** credits. Your wallet now has **${result.balance}** credits.`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error('invite_credit_claim_failed', { guildId: interaction.guildId, userId: interaction.user.id, error: error.message });
    return interaction.reply({ content: 'Invite rewards could not be verified safely. Please try again later.', ephemeral: true });
  }
}

async function showTierOptions(interaction) {
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const buttons = TIER_NAMES.map((tierName) => {
    const tier = guildDoc.getTier(tierName);
    return new ButtonBuilder()
      .setCustomId(`shop:tier:${tierName}`)
      .setLabel(tier?.label || tierName)
      .setStyle(ButtonStyle.Primary);
  });
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(index, index + 5)));
  }
  return interaction.reply({
    content: 'Choose the tier you want to discuss with the server owner:',
    components: rows,
    ephemeral: true,
  });
}

async function selectTier(interaction, tierName) {
  if (!TIER_NAMES.includes(tierName)) {
    return interaction.reply({ content: 'That tier is not available.', ephemeral: true });
  }
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const tier = guildDoc.getTier(tierName);
  const button = new ButtonBuilder()
    .setCustomId(`shop:open:${tierName}`)
    .setLabel('Open private purchase ticket')
    .setStyle(ButtonStyle.Success);
  return interaction.update({
    content: `**${tier.label}** — ${tierDescription(guildDoc, tier, tierName)}\n\nOpen a private ticket with the server owner to arrange this tier.`,
    components: [new ActionRowBuilder().addComponents(button)],
  });
}

async function openTicket(interaction, tierName) {
  if (!TIER_NAMES.includes(tierName)) {
    return interaction.reply({ content: 'That tier is not available.', ephemeral: true });
  }

  await interaction.deferUpdate();
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const tier = guildDoc.getTier(tierName);
  const topic = `tier-shop-ticket:${interaction.user.id}:${tierName}`;
  let ticket = interaction.guild.channels.cache.find((channel) => channel.topic === topic);

  if (!ticket) {
    const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40) || 'member';
    const ticketMembers = [...new Set([interaction.user.id, interaction.guild.ownerId])];
    try {
      ticket = await interaction.guild.channels.create({
        name: `tier-${tierName}-${safeName}`.slice(0, 100),
        type: ChannelType.GuildText,
        topic,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          ...ticketMembers.map((id) => ({
            id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
          })),
          {
            id: interaction.client.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels],
          },
        ],
      });
    } catch (err) {
      logger.error('shop_ticket_create_failed', {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        tier: tierName,
        error: err.message,
      });
      return interaction.editReply({
        content: 'I could not open the ticket. The bot needs permission to manage channels; please contact the server owner.',
        components: [],
      });
    }

    try {
      await ticket.send({
        content: `<@${interaction.user.id}> <@${interaction.guild.ownerId}>`,
        embeds: [
          new EmbedBuilder()
            .setColor(guildDoc.embedStyle?.color || '#5865F2')
            .setTitle(`${tier.label} tier purchase inquiry`)
            .setDescription(`${tierDescription(guildDoc, tier, tierName)}\n\nThe member and server owner can use this private channel to discuss the purchase.`),
        ],
        allowedMentions: { users: [interaction.user.id, interaction.guild.ownerId] },
      });
    } catch (err) {
      logger.error('shop_ticket_intro_failed', { guildId: interaction.guildId, channelId: ticket.id, error: err.message });
      return interaction.editReply({
        content: `The ticket channel ${ticket} was created, but I could not post its introduction. The member and server owner can still use it.`,
        components: [],
      });
    }
  }

  return interaction.editReply({
    content: `Your private ${tier.label} tier ticket is ready: ${ticket}. The server owner can see it too.`,
    components: [],
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Post the tier shop panel in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute,
  handleComponent,
  buildShopEmbed,
  buildShopPayload,
  publishShopPanel,
  tierDescription,
};
