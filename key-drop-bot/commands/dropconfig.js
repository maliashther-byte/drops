'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');

const Guild = require('../schemas/Guild');
const { TIER_NAMES, DEFAULT_SECURE_ITEMS_PER_CLICK } = require('../config/constants');
const { addTimedTierRole } = require('../handlers/tierGrants');
const { lootBoxEmbed } = require('../utils/embeds');
const quizState = require('../utils/quizState');
const logger = require('../utils/logger');
const { resetCooldowns } = require('../utils/resetCooldowns');
const { issueCooldownReward, cooldownRewardPayload } = require('../handlers/cooldownRewards');
const { publishButtonDrop } = require('../utils/buttonDrops');

const PRODUCT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const PRODUCT_LIMIT = 10;
const PRODUCT_COLORS = ['#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#1ABC9C', '#E67E22', '#9B59B6', '#3498DB', '#95A5A6'];
const DEFAULT_TIER_SETTINGS = {
  buttonDailyLimit: 4,
  buttonCooldownMinutes: 0,
  prefixCooldownMinutes: 0,
  challengeEveryClaims: 3,
};

function productCommandName(product) {
  return product.commandName || product.name;
}

async function cleanupLegacyProductMenus(client) {
  const cursor = Guild.find({ 'dropChannels.menuMessageId': { $ne: null } }).cursor();
  for await (const guildDoc of cursor) {
    let changed = false;
    let guild;
    try {
      guild = await client.guilds.fetch(guildDoc.guildId);
    } catch (err) {
      logger.warn('legacy_drop_menu_guild_fetch_failed', { guildId: guildDoc.guildId, error: err.message });
      continue;
    }

    for (const channelConfig of guildDoc.dropChannels) {
      if (!channelConfig.menuMessageId) continue;
      try {
        const channel = await guild.channels.fetch(channelConfig.channelId);
        const oldMenu = await channel.messages.fetch(channelConfig.menuMessageId);
        await oldMenu.delete();
        channelConfig.menuMessageId = null;
        changed = true;
      } catch (err) {
        if ([10003, 10008].includes(Number(err.code))) {
          channelConfig.menuMessageId = null;
          changed = true;
          continue;
        }
        logger.warn('legacy_drop_menu_cleanup_failed', {
          guildId: guildDoc.guildId,
          channelId: channelConfig.channelId,
          messageId: channelConfig.menuMessageId,
          error: err.message,
        });
      }
    }
    if (changed) {
      try {
        await guildDoc.save();
      } catch (err) {
        logger.error('legacy_drop_menu_config_save_failed', { guildId: guildDoc.guildId, error: err.message });
      }
    }
  }
}

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to configure drop products.', ephemeral: true });
  }

  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const subcommand = interaction.options.getSubcommand(false);
  if (!subcommand) return showPanel(interaction, guildDoc);
  switch (subcommand) {
    case 'channel':
      return setChannel(interaction, guildDoc);
    case 'product-add':
      return addProduct(interaction, guildDoc);
    case 'product-edit':
      return editProduct(interaction, guildDoc);
    case 'product-remove':
      return removeProduct(interaction, guildDoc);
    case 'product-list':
      return listProducts(interaction, guildDoc);
    case 'tier':
      return setTier(interaction, guildDoc);
    case 'panel':
      return showPanel(interaction, guildDoc);
    default:
      return interaction.reply({ content: 'Unknown drop configuration action.', ephemeral: true });
  }
}

async function publishButtonDropCommand(interaction, guildDoc) {
  const commandName = interaction.options.getString('product').trim().toLowerCase();
  const product = guildDoc.dropProducts.find((entry) => productCommandName(entry) === commandName);
  if (!product) {
    return interaction.reply({ content: `No generator uses the command \`!${commandName}\`.`, ephemeral: true });
  }
  const channel = interaction.options.getChannel('channel');
  if (!channel?.isTextBased() || channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Choose a server text channel.', ephemeral: true });
  }
  if (!guildDoc.dropChannels.some((entry) => entry.channelId === channel.id)) {
    return interaction.reply({ content: 'Add this channel to the drop channels in `/dropconfig` first so its CAPTCHA and button limits apply.', ephemeral: true });
  }
  const title = interaction.options.getString('title')?.trim() || product.name;
  const description = interaction.options.getString('description')?.trim() || product.description || `Press the button to claim **${product.name}**.`;
  const label = interaction.options.getString('button_label')?.trim() || 'Claim';
  const imageUrl = interaction.options.getString('image_url')?.trim() || null;
  if (title.length > 256 || description.length > 4000 || label.length > 80) {
    return interaction.reply({ content: 'Title, description, or button label exceeds Discord’s length limit.', ephemeral: true });
  }
  if (imageUrl) {
    try {
      if (new URL(imageUrl).protocol !== 'https:') throw new Error('HTTPS required');
    } catch {
      return interaction.reply({ content: 'Image URL must be a valid HTTPS URL.', ephemeral: true });
    }
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const message = await publishButtonDrop({
      guildDoc,
      product,
      channel,
      title,
      description,
      label,
      imageUrl,
    });
    return interaction.editReply(`Published **${product.name}** in ${channel}. The button applies the generator’s tier quantities, cooldowns, daily cap, and CAPTCHA settings.`);
  } catch (error) {
    logger.error('drop_button_publish_failed', {
      guildId: interaction.guildId,
      product: product.name,
      channelId: channel.id,
      error: error.message,
    });
    return interaction.editReply('Could not publish the drop button. Check the bot’s channel permissions and try again.');
  }
}

async function setButtonLimits(interaction, guildDoc) {
  const channel = interaction.options.getChannel('channel');
  const tierName = interaction.options.getString('tier');
  const channelConfig = guildDoc.dropChannels.find((entry) => entry.channelId === channel?.id);
  if (!channelConfig) {
    return interaction.reply({ content: `Configure ${channel} first from the \`/dropconfig\` panel.`, ephemeral: true });
  }
  const dailyLimit = interaction.options.getInteger('daily_limit');
  const cooldownMinutes = interaction.options.getInteger('cooldown_minutes');
  const current = channelConfig.tierSettings.get(tierName) || DEFAULT_TIER_SETTINGS;
  const currentSettings = typeof current.toObject === 'function' ? current.toObject() : current;
  channelConfig.tierSettings.set(tierName, {
    ...currentSettings,
    buttonDailyLimit: dailyLimit,
    buttonCooldownMinutes: cooldownMinutes,
  });
  try {
    await guildDoc.save();
  } catch (error) {
    logger.error('drop_button_limits_save_failed', {
      guildId: interaction.guildId,
      channelId: channel.id,
      tier: tierName,
      error: error.message,
    });
    return interaction.reply({ content: 'Could not save the button limits. The previous settings are unchanged; try again.', ephemeral: true });
  }
  return interaction.reply({
    content: `Updated **${tierName}** button limits in ${channel}: **${dailyLimit}** claims per day, **${cooldownMinutes}** minute cooldown.`,
    ephemeral: true,
  });
}

async function showPanel(interaction, guildDoc) {
  await cleanupLegacyMenusForGuild(guildDoc, interaction.guild);
  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('Drop configuration')
    .setDescription('Configure channels and item generators. Add a generator to connect a short `!command` to a shared category and choose how many items each tier receives.')
    .addFields(
      {
        name: 'Configured channels',
        value: guildDoc.dropChannels.length
          ? guildDoc.dropChannels.map((entry) => `<#${entry.channelId}> — prefix \`${entry.prefix}\``).join('\n').slice(0, 1024)
          : 'No channels configured. Use the Channel button.',
        inline: false,
      },
      {
        name: 'Products',
        value: guildDoc.dropProducts.length
          ? guildDoc.dropProducts.slice(0, 8).map((product) => {
            const quantities = TIER_NAMES.map((tier) => `${tier}: ${product.quantities.get(tier) ?? 1}`).join(' · ');
            return `\`!${productCommandName(product)}\` → **${product.name}** → ${product.category} (${quantities})`;
          }).join('\n').slice(0, 900) + (guildDoc.dropProducts.length > 8 ? `\n…and ${guildDoc.dropProducts.length - 8} more; use List products.` : '')
          : 'No products configured. Use the Add product button.',
        inline: false,
      },
      {
        name: 'Tier cooldowns & secure actions',
        value: TIER_NAMES.map((tierName) => {
          const tier = guildDoc.getTier(tierName);
          const secureCount = tier?.secureItemsPerClick ?? DEFAULT_SECURE_ITEMS_PER_CLICK[tierName];
          return `**${tier?.label || tierName}**: ${tier?.dailyLimit ?? 0}/day · ${tier?.cooldownMinutes ?? 0}m cooldown · secure ${secureCount === 0 ? 'auto' : `${secureCount}/click`}`;
        }).join('\n'),
        inline: false,
      }
    )
    .setFooter({ text: 'Set tier cooldowns, prices, descriptions, and secure limits from /setup → Tiers.' });
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dropconfig:panel:channel').setLabel('Channel').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('dropconfig:panel:product-add').setLabel('Add item generator').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('dropconfig:panel:product-edit').setLabel('Edit product').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('dropconfig:panel:product-remove').setLabel('Remove product').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('dropconfig:panel:product-list').setLabel('List products').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dropconfig:panel:tier').setLabel('Verification intervals').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('dropconfig:panel:tier-drop').setLabel('Drop a tier').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('dropconfig:panel:copy-setup').setLabel('Copy setup').setStyle(ButtonStyle.Secondary)
    ),
  ];
  if (interaction.user.id === interaction.guild.ownerId) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dropconfig:owner-refresh').setLabel('Refresh member cooldowns').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('dropconfig:owner-reward').setLabel('Issue 1-week refresh reward').setStyle(ButtonStyle.Success)
    ));
  }
  return interaction.reply({ embeds: [embed], components, ephemeral: true });
}

async function cleanupLegacyMenusForGuild(guildDoc, guild) {
  let changed = false;
  for (const channelConfig of guildDoc.dropChannels) {
    if (!channelConfig.menuMessageId) continue;
    try {
      const channel = await guild.channels.fetch(channelConfig.channelId);
      const oldMenu = await channel.messages.fetch(channelConfig.menuMessageId);
      await oldMenu.delete();
      channelConfig.menuMessageId = null;
      changed = true;
    } catch (err) {
      if ([10003, 10008].includes(Number(err.code))) {
        channelConfig.menuMessageId = null;
        changed = true;
        continue;
      }
      logger.warn('legacy_drop_menu_cleanup_failed', {
        guildId: guildDoc.guildId,
        channelId: channelConfig.channelId,
        messageId: channelConfig.menuMessageId,
        error: err.message,
      });
    }
  }
  if (changed) {
    try {
      await guildDoc.save();
    } catch (err) {
      logger.error('legacy_drop_menu_config_save_failed', { guildId: guildDoc.guildId, error: err.message });
    }
  }
}

async function handleComponent(interaction) {
  const [, action, panelAction] = interaction.customId.split(':');
  if (action === 'owner-refresh' || action === 'owner-reward') {
    if (interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({ content: 'Only the server owner can use this action.', ephemeral: true });
    }
    return showActionModal(interaction, action);
  }
  if (action === 'panel') return showActionModal(interaction, panelAction);
  if (action === 'tier-quantity') {
    const [, , productName, tierName, ownerId] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: 'Only the administrator who opened this tier panel can change these amounts.', ephemeral: true });
    }
    if (!TIER_NAMES.includes(tierName)) {
      return interaction.reply({ content: 'That tier is not valid.', ephemeral: true });
    }
    return showProductTierModal(interaction, productName, tierName, ownerId);
  }
  if (action === 'claim-limit') {
    const [, , productName, ownerId] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: 'Only the administrator who opened this product panel can change its claim limit.', ephemeral: true });
    }
    return showProductClaimLimitModal(interaction, productName, ownerId);
  }
  if (action === 'cooldowns') {
    const [, , productName, ownerId] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: 'Only the administrator who opened this product panel can change its tier cooldowns.', ephemeral: true });
    }
    return showProductCooldownsModal(interaction, productName, ownerId);
  }
  if (action === 'tier-done') {
    const [, , productName, ownerId] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: 'Only the administrator who opened this tier panel can close it.', ephemeral: true });
    }
    return interaction.update({ content: `Tier amounts saved for **${productName}**.`, components: [] });
  }
  return interaction.reply({ content: 'Unknown drop configuration action.', ephemeral: true });
}

function showActionModal(interaction, action) {
  const modal = new ModalBuilder().setCustomId(`dropconfig:panel_modal:${action}`).setTitle(`${action.replace('-', ' ')} configuration`);
  const input = (id, label, required, maxLength = 100) =>
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(maxLength);
  if (action === 'owner-refresh' || action === 'owner-reward') {
    modal.setTitle(action === 'owner-refresh' ? 'Refresh member cooldowns' : 'Issue cooldown refresh reward');
    modal.addComponents(new ActionRowBuilder().addComponents(
      input('user_id', 'Member user ID (17-20 digits)', true, 20)
    ));
  } else if (action === 'channel') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('channel_id', 'Server text channel ID', true, 25)),
      new ActionRowBuilder().addComponents(input('prefix', 'Channel prefix or product command', false, 15)
        .setPlaceholder('Use !drop or assign a product command such as !discord'))
    );
  } else if (action === 'product-add') {
    modal.setTitle('Add item generator');
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('name', 'Product name (max 80)', true, 80)
        .setPlaceholder('Example: School Websites')),
      new ActionRowBuilder().addComponents(input('command_name', 'Member command (without !)', true, 32)
        .setPlaceholder('Example: unblocked — members will type !unblocked')),
      new ActionRowBuilder().addComponents(input('category', 'Existing shared category (max 30 chars)', true, 30)
        .setPlaceholder('Example: minecraft-usernames — this is where items come from')),
      new ActionRowBuilder().addComponents(input('cooldown_minutes', 'Cooldown per use, in minutes (optional)', false, 5)
        .setPlaceholder('Blank uses each member tier cooldown; enter 0-10080 to override')),
      new ActionRowBuilder().addComponents(input('color', 'Embed color (optional)', false, 7)
        .setPlaceholder('Example: #5865F2 — leave blank for an automatic unique color'))
    );
  } else if (action === 'product-edit') {
    modal.setTitle('Edit item generator');
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('name', 'Existing product name', true, 80)
        .setPlaceholder('Enter the product name as configured')),
      new ActionRowBuilder().addComponents(input('command_name', 'Change member command (optional)', false, 32)
        .setPlaceholder('Enter unblocked; members will type !unblocked')),
      new ActionRowBuilder().addComponents(input('category', 'Change category (optional)', false, 30)
        .setPlaceholder('Leave empty to keep the current category')),
      new ActionRowBuilder().addComponents(input('cooldown_minutes', 'Cooldown per use, in minutes (optional)', false, 7)
        .setPlaceholder('Blank keeps current; enter 0-10080, or "default" for tier cooldown')),
      new ActionRowBuilder().addComponents(input('color', 'Change color (optional)', false, 7)
        .setPlaceholder('Leave empty to keep the current color'))
    );
  } else if (action === 'product-remove') {
    modal.setTitle('Remove item generator');
    modal.addComponents(new ActionRowBuilder().addComponents(input('name', 'Product name to remove', true, 80)));
  } else if (action === 'tier') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('channel_id', 'Configured text channel ID', true, 25)),
      new ActionRowBuilder().addComponents(input('tier', 'Tier: free, bronze, silver, gold, diamond', true, 10)),
      new ActionRowBuilder().addComponents(input('challenge_every_claims', 'CAPTCHA every N claims (1-20)', true, 2))
    );
  } else if (action === 'tier-drop') {
    modal.setTitle('Create timed tier drop');
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('tier', 'Tier: bronze, silver, gold, diamond', true, 10)),
      new ActionRowBuilder().addComponents(input('duration_hours', 'Access duration in hours (1-8760)', true, 5))
    );
  } else if (action === 'copy-setup') {
    modal.setTitle('Copy setup from another server');
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('source_guild_id', 'Source server ID', true, 20).setPlaceholder('Paste the other server ID'))
    );
  } else if (action === 'product-list') {
    return listPanelProducts(interaction);
  } else {
    return interaction.reply({ content: 'Unknown drop configuration action.', ephemeral: true });
  }
  return interaction.showModal(modal);
}

function showProductTierModal(interaction, productName, tierName, ownerId) {
  const tier = tierName[0].toUpperCase() + tierName.slice(1);
  const input = new TextInputBuilder()
    .setCustomId('quantity')
    .setLabel(`${tier} items per claim (0-500)`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(3)
    .setPlaceholder('Enter a whole number, e.g. 250');
  const modal = new ModalBuilder()
    .setCustomId(`dropconfig:panel_modal:tier-quantity:${productName}:${tierName}:${ownerId}`)
    .setTitle(`${tier} amount for ${productName}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

function productTierPanel(product, ownerId, intro) {
  const tierButtons = TIER_NAMES.map((tierName) => {
    const label = tierName[0].toUpperCase() + tierName.slice(1);
    return new ButtonBuilder()
      .setCustomId(`dropconfig:tier-quantity:${productCommandName(product)}:${tierName}:${ownerId}`)
      .setLabel(`${label}: ${product.quantities.get(tierName) ?? 1}`)
      .setStyle(ButtonStyle.Primary);
  });
  const rows = [
    new ActionRowBuilder().addComponents(tierButtons.slice(0, 5)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dropconfig:claim-limit:${productCommandName(product)}:${ownerId}`)
        .setLabel(productClaimLimitLabel(product))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`dropconfig:cooldowns:${productCommandName(product)}:${ownerId}`)
        .setLabel('Tier cooldowns')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`dropconfig:tier-done:${productCommandName(product)}:${ownerId}`)
        .setLabel('Done')
        .setStyle(ButtonStyle.Success)
    ),
  ];
  return {
    content: `${intro}\n\n**Set items per claim for each tier** (0–500). Click a tier, enter one number, and save. Use **${productClaimLimitLabel(product)}** to set the daily claim cap; 0 means unlimited, and Default uses each member's tier limit.`,
    components: rows,
    ephemeral: true,
  };
}

function productClaimLimitLabel(product) {
  if (product.dailyLimit === null || product.dailyLimit === undefined) return 'Daily max: Default';
  return product.dailyLimit === 0 ? 'Daily max: Unlimited' : `Daily max: ${product.dailyLimit}`;
}

async function showProductCooldownsModal(interaction, productName, ownerId) {
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const product = guildDoc.dropProducts.find((entry) =>
    entry.name === productName || productCommandName(entry) === productName);
  if (!product) {
    return interaction.reply({ content: `Generator **${productName}** no longer exists.`, ephemeral: true });
  }
  const modal = new ModalBuilder()
    .setCustomId(`dropconfig:panel_modal:cooldowns:${productName}:${ownerId}`)
    .setTitle('Cooldowns by member tier');
  for (const tierName of TIER_NAMES) {
    const current = product.cooldowns?.get(tierName) ?? product.cooldownMinutes;
    const input = new TextInputBuilder()
      .setCustomId(`cooldown_${tierName}`)
      .setLabel(`${tierName[0].toUpperCase() + tierName.slice(1)} cooldown (minutes)`)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(8)
      .setPlaceholder('Enter default or 0-10080');
    input.setValue(current === null || current === undefined ? 'default' : String(current));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return interaction.showModal(modal);
}

async function saveProductCooldowns(interaction, productName, ownerId) {
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: 'Only the administrator who opened this product panel can change its tier cooldowns.', ephemeral: true });
  }
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const product = guildDoc.dropProducts.find((entry) =>
    entry.name === productName || productCommandName(entry) === productName);
  if (!product) {
    return interaction.reply({ content: `Generator **${productName}** no longer exists.`, ephemeral: true });
  }

  for (const tierName of TIER_NAMES) {
    const rawCooldown = interaction.fields.getTextInputValue(`cooldown_${tierName}`).trim().toLowerCase();
    if (rawCooldown === 'default') {
      product.cooldowns.delete(tierName);
      continue;
    }
    if (!/^\d{1,5}$/.test(rawCooldown) || Number(rawCooldown) > 10080) {
      return interaction.reply({ content: 'Each tier cooldown must be `default` or a whole number from 0 to 10080 minutes.', ephemeral: true });
    }
    product.cooldowns.set(tierName, Number(rawCooldown));
  }
  try {
    await guildDoc.save();
  } catch (err) {
    logger.error('drop_product_tier_cooldown_save_failed', {
      guildId: interaction.guildId,
      product: productName,
      error: err.message,
    });
    return interaction.reply({ content: 'Could not save the tier cooldowns. The previous settings are unchanged; try again.', ephemeral: true });
  }
  return interaction.reply(productTierPanel(
    product,
    ownerId,
    `Saved the tier cooldowns for **${product.name}**.`
  ));
}

function showProductClaimLimitModal(interaction, productName, ownerId) {
  const modal = new ModalBuilder()
    .setCustomId(`dropconfig:panel_modal:claim-limit:${productName}:${ownerId}`)
    .setTitle('Product daily claim limit');
  const input = new TextInputBuilder()
    .setCustomId('daily_limit')
    .setLabel('Claims per user per day (1-1000)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(9)
    .setValue('default')
    .setPlaceholder('Enter default, unlimited, or a number from 1 to 1000');
  const current = interaction.message?.components?.flatMap((row) => row.components || [])
    .find((component) => component.customId === `dropconfig:claim-limit:${productName}:${ownerId}`)?.label;
  if (current?.endsWith('Unlimited')) input.setValue('unlimited');
  else if (current && current.startsWith('Daily max: ') && current !== 'Daily max: Default') {
    input.setValue(current.slice('Daily max: '.length));
  }
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

async function saveProductClaimLimit(interaction, productName, ownerId) {
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: 'Only the administrator who opened this product panel can change its claim limit.', ephemeral: true });
  }
  const rawLimit = interaction.fields.getTextInputValue('daily_limit').trim().toLowerCase();
  let dailyLimit = null;
  if (rawLimit === 'unlimited') {
    dailyLimit = 0;
  } else if (rawLimit !== 'default') {
    if (!/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 1000) {
      return interaction.reply({ content: 'Enter `default`, `unlimited`, or a whole number from 1 to 1000.', ephemeral: true });
    }
    dailyLimit = Number(rawLimit);
  }
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const product = guildDoc.dropProducts.find((entry) =>
    entry.name === productName || productCommandName(entry) === productName);
  if (!product) {
    return interaction.reply({ content: `Generator **${productName}** no longer exists.`, ephemeral: true });
  }
  product.dailyLimit = dailyLimit;
  try {
    await guildDoc.save();
  } catch (err) {
    logger.error('drop_product_daily_limit_save_failed', {
      guildId: interaction.guildId,
      product: productName,
      error: err.message,
    });
    return interaction.reply({ content: 'Could not save the daily claim limit. The previous value is unchanged; try again.', ephemeral: true });
  }
  const savedLimit = product.dailyLimit === null
    ? 'the member tier limit'
    : product.dailyLimit === 0 ? 'unlimited claims' : `${product.dailyLimit} claims per day`;
  return interaction.reply(productTierPanel(
    product,
    ownerId,
    `Updated **${product.name}** to **${savedLimit}**.`
  ));
}

async function saveProductTierQuantity(interaction, productName, tierName, ownerId) {
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: 'Only the administrator who opened this tier panel can change these amounts.', ephemeral: true });
  }
  if (!TIER_NAMES.includes(tierName)) {
    return interaction.reply({ content: 'That tier is not valid.', ephemeral: true });
  }
  const rawQuantity = interaction.fields.getTextInputValue('quantity').trim();
  if (!/^\d{1,3}$/.test(rawQuantity) || Number(rawQuantity) > 500) {
    return interaction.reply({ content: 'Enter one whole number from 0 to 500.', ephemeral: true });
  }

  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const product = guildDoc.dropProducts.find((entry) =>
    entry.name === productName || productCommandName(entry) === productName);
  if (!product) {
    return interaction.reply({ content: `Generator **${productName}** no longer exists.`, ephemeral: true });
  }
  product.quantities.set(tierName, Number(rawQuantity));
  try {
    await guildDoc.save();
  } catch (err) {
    logger.error('drop_product_tier_quantity_save_failed', {
      guildId: interaction.guildId,
      product: productName,
      tier: tierName,
      error: err.message,
    });
    return interaction.reply({ content: `Could not save the ${tierName} amount. The previous value is unchanged; try again.`, ephemeral: true });
  }

  return interaction.reply(productTierPanel(product, ownerId, `Saved **${tierName[0].toUpperCase() + tierName.slice(1)}** as **${rawQuantity}** item(s) per claim for \`!${productCommandName(product)}\`.`));
}

async function listPanelProducts(interaction) {
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  return listProducts(interaction, guildDoc);
}

async function handleModal(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to configure drop products.', ephemeral: true });
  }
  const [, , action] = interaction.customId.split(':');
  const values = Object.fromEntries(interaction.fields.fields.map((field) => [field.customId, field.value.trim()]));
  if (action === 'copy-setup') {
    const { copySetup } = require('./copysetup');
    return copySetup({ interaction, sourceGuildId: values.source_guild_id });
  }
  if (action === 'owner-refresh' || action === 'owner-reward') {
    if (interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({ content: 'Only the server owner can use this action.', ephemeral: true });
    }
    if (!/^\d{17,20}$/.test(values.user_id)) {
      return interaction.reply({ content: 'Enter a valid Discord member ID.', ephemeral: true });
    }
    const member = await interaction.guild.members.fetch(values.user_id).catch(() => null);
    if (!member) return interaction.reply({ content: 'That member could not be found in this server.', ephemeral: true });
    if (action === 'owner-refresh') {
      try {
        const counts = await resetCooldowns(member.id, interaction.guildId);
        return interaction.reply({
          content: `Refreshed all product and drop cooldowns for ${member} (cleared ${counts.productAndButtonRecords} product/drop records).`,
          ephemeral: true,
        });
      } catch (err) {
        logger.error('owner_cooldown_refresh_failed', { guildId: interaction.guildId, userId: member.id, error: err.message });
        return interaction.reply({ content: 'Could not refresh cooldowns. Please try again.', ephemeral: true });
      }
    }
    let reward = null;
    try {
      reward = await issueCooldownReward({ guildId: interaction.guildId, userId: member.id, source: 'owner' });
      await member.send(cooldownRewardPayload(reward));
    } catch (err) {
      if (reward) {
        await reward.deleteOne().catch((deleteErr) => logger.error('cooldown_reward_issue_rollback_failed', {
          rewardId: reward.id,
          error: deleteErr.message,
        }));
      }
      logger.error('owner_cooldown_reward_issue_failed', { guildId: interaction.guildId, userId: member.id, error: err.message });
      return interaction.reply({ content: 'Could not DM that member a cooldown reward. Check their DM settings and try again.', ephemeral: true });
    }
    return interaction.reply({ content: `Sent ${member} a one-use cooldown refresh reward that expires in one week.`, ephemeral: true });
  }
  if (action === 'tier-drop') return createTierDrop(interaction, values);
  if (action === 'tier-quantity') {
    const [, , , productName, tierName, ownerId] = interaction.customId.split(':');
    return saveProductTierQuantity(interaction, productName, tierName, ownerId);
  }
  if (action === 'claim-limit') {
    const [, , , productName, ownerId] = interaction.customId.split(':');
    return saveProductClaimLimit(interaction, productName, ownerId);
  }
  if (action === 'cooldowns') {
    const [, , , productName, ownerId] = interaction.customId.split(':');
    return saveProductCooldowns(interaction, productName, ownerId);
  }

  let channel = null;
  if (action === 'channel' || action === 'tier') {
    const channelId = values.channel_id;
    if (!/^\d{17,20}$/.test(channelId)) return interaction.reply({ content: 'Enter a valid server text channel ID.', ephemeral: true });
    channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return interaction.reply({ content: 'That channel was not found or is not a server text channel.', ephemeral: true });
    }
  }

  if (action === 'tier' && !TIER_NAMES.includes(values.tier?.toLowerCase())) {
    return interaction.reply({ content: `Choose one of these tiers: ${TIER_NAMES.join(', ')}.`, ephemeral: true });
  }
  let productCooldownMinutes;
  if (action === 'product-add' || action === 'product-edit') {
    const rawCooldown = values.cooldown_minutes?.toLowerCase();
    if (rawCooldown && rawCooldown !== 'default') {
      if (!/^\d{1,5}$/.test(rawCooldown) || Number(rawCooldown) > 10080) {
        return interaction.reply({ content: 'Cooldown must be a whole number from 0 to 10080 minutes, or `default` to use tier cooldowns.', ephemeral: true });
      }
      productCooldownMinutes = Number(rawCooldown);
    } else if (rawCooldown === 'default') {
      productCooldownMinutes = 'default';
    }
  }
  const embedColor = values.color ? normalizeProductColor(values.color) : null;
  if (values.color && !embedColor) {
    return interaction.reply({ content: 'Embed color must be a 6-digit hex color, such as `#5865F2`.', ephemeral: true });
  }
  const challengeEveryClaims = action === 'tier' ? Number(values.challenge_every_claims) : null;
  if (action === 'tier' && (!Number.isInteger(challengeEveryClaims) || challengeEveryClaims < 1 || challengeEveryClaims > 20)) {
    return interaction.reply({ content: 'Verification interval must be a whole number from 1 to 20.', ephemeral: true });
  }
  const options = {
    getSubcommand: () => action,
    getString: (name) => {
      if (name === 'channel_id') return values.channel_id;
      if (name === 'channel') return null;
      if (name === 'prefix') return values.prefix || null;
      if (name === 'name') return values.name?.trim() || null;
      if (name === 'command_name') return values.command_name?.trim().replace(/^!/, '').toLowerCase() || null;
      if (name === 'category') return values.category?.toLowerCase() || null;
      if (name === 'tier') return values.tier?.toLowerCase() || null;
      if (name === 'cooldown_minutes') return productCooldownMinutes ?? null;
      if (name === 'embed_color') return embedColor;
      return null;
    },
    getInteger: (name) => {
      if (action === 'tier') return name === 'challenge_every_claims' ? challengeEveryClaims : null;
      return null;
    },
    getChannel: () => channel,
  };
  const adaptedInteraction = Object.create(interaction);
  adaptedInteraction.options = options;
  return execute(adaptedInteraction);
}

function normalizeProductColor(value) {
  const color = value.trim();
  if (/^[0-9A-Fa-f]{6}$/.test(color)) return `#${color.toUpperCase()}`;
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) return color.toUpperCase();
  return null;
}

function productColor(guildDoc, product) {
  if (product.embedColor) return product.embedColor;
  const index = guildDoc.dropProducts.findIndex((entry) => entry.name === product.name);
  return PRODUCT_COLORS[Math.max(0, index) % PRODUCT_COLORS.length];
}

function getAvailableProductColor(guildDoc, excludedProduct = null) {
  const usedColors = new Set(
    guildDoc.dropProducts
      .filter((product) => product !== excludedProduct)
      .map((product) => productColor(guildDoc, product).toUpperCase())
  );
  return PRODUCT_COLORS.find((color) => !usedColors.has(color.toUpperCase())) || null;
}



async function createTierDrop(interaction, values) {
  const tierName = values.tier.toLowerCase();
  if (!TIER_NAMES.includes(tierName)) {
    return interaction.reply({ content: `Choose a reward tier: ${TIER_NAMES.join(', ')}.`, ephemeral: true });
  }
  if (!/^\d{1,5}$/.test(values.duration_hours)) {
    return interaction.reply({ content: 'Duration must be a whole number of hours between 1 and 8760.', ephemeral: true });
  }
  const durationHours = Number(values.duration_hours);
  if (durationHours < 1 || durationHours > 8760) {
    return interaction.reply({ content: 'Duration must be between 1 hour and 8760 hours (one year).', ephemeral: true });
  }

  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const tier = guildDoc.getTier(tierName);
  if (!tier?.roleId) {
    return interaction.reply({ content: `No Discord role is configured for the **${tierName}** tier. Configure its role in \`/setup\` first.`, ephemeral: true });
  }
  const channelId = guildDoc.dropChannelIds[0] || guildDoc.dropChannels[0]?.channelId;
  if (!channelId) {
    return interaction.reply({ content: 'Configure a drop channel in \`/setup\` or \`/dropconfig\` before creating tier drops.', ephemeral: true });
  }
  const channel = await interaction.guild.channels.fetch(channelId).catch((err) => {
    logger.error('tier_drop_channel_fetch_failed', { guildId: interaction.guildId, channelId, error: err.message });
    return null;
  });
  if (!channel?.isTextBased() || !channel.send) {
    return interaction.reply({ content: 'The configured drop channel is unavailable. Check the channel settings and bot permissions.', ephemeral: true });
  }

  guildDoc.lootBoxCount = (guildDoc.lootBoxCount || 0) + 1;
  try {
    await guildDoc.save();
  } catch (err) {
    logger.error('tier_drop_counter_save_failed', { guildId: interaction.guildId, error: err.message });
    return interaction.reply({ content: 'Could not create the tier drop right now. Try again shortly.', ephemeral: true });
  }

  const reward = `${tier.label} tier access for ${durationHours} hour(s)`;
  const boxButton = new ButtonBuilder()
    .setCustomId('lootbox:claim')
    .setLabel('Claim this tier')
    .setEmoji('🎁')
    .setStyle(ButtonStyle.Success);
  let boxMessage;
  try {
    boxMessage = await channel.send({
      embeds: [lootBoxEmbed(guildDoc, {
        number: guildDoc.lootBoxCount,
        category: `${tierName} tier`,
        reward,
      })],
      components: [new ActionRowBuilder().addComponents(boxButton)],
    });
  } catch (err) {
    logger.error('tier_drop_post_failed', { guildId: interaction.guildId, channelId, error: err.message });
    return interaction.reply({ content: 'Could not post the tier drop. Check bot permissions in the drop channel.', ephemeral: true });
  }

  quizState.create(boxMessage.id, {
    kind: 'tier',
    guildId: interaction.guildId,
    tierName,
    durationMs: durationHours * 60 * 60 * 1000,
    number: guildDoc.lootBoxCount,
    reward,
    claiming: false,
    claimedBy: null,
    messageRef: boxMessage,
  });
  return interaction.reply({ content: `Posted timed **${tier.label}** tier drop #${guildDoc.lootBoxCount} in ${channel}.`, ephemeral: true });
}

async function setChannel(interaction, guildDoc) {
  const channel = interaction.options.getChannel('channel');
  const prefix = interaction.options.getString('prefix')?.trim() || '!drop';
  if (!/^![a-z0-9_-]{1,14}$/i.test(prefix)) {
    return interaction.reply({ content: 'Prefix must start with `!` and contain only letters, numbers, hyphens, or underscores (max 15 characters).', ephemeral: true });
  }
  if (!channel?.isTextBased() || channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Choose a server text channel.', ephemeral: true });
  }

  let channelConfig = guildDoc.dropChannels.find((entry) => entry.channelId === channel.id);
  if (!channelConfig) {
    channelConfig = {
      channelId: channel.id,
      prefix,
      tierSettings: new Map(TIER_NAMES.map((name) => [name, DEFAULT_TIER_SETTINGS])),
    };
    guildDoc.dropChannels.push(channelConfig);
  } else {
    channelConfig.prefix = prefix;
  }
  const assignedProduct = guildDoc.dropProducts.find((product) =>
    productCommandName(product).toLowerCase() === prefix.slice(1).toLowerCase());
  if (assignedProduct) {
    for (const entry of guildDoc.dropChannels) {
      if (entry.channelId !== channel.id && entry.prefix?.toLowerCase() === prefix.toLowerCase()) {
        entry.prefix = '!drop';
      }
    }
  }
  try {
    await guildDoc.save();
  } catch (err) {
    logger.error('drop_channel_setup_failed', { guildId: interaction.guildId, channelId: channel.id, error: err.message });
    return interaction.reply({ content: 'Could not save the drop channel configuration. Try again shortly.', ephemeral: true });
  }
  try {
    await cleanupLegacyMenusForGuild(guildDoc, interaction.guild);
    const channelMessage = assignedProduct
      ? `Product command \`!${productCommandName(assignedProduct)}\` is assigned only to ${channel}.`
      : `Drop channel saved as ${channel}.`;
    return interaction.reply({
      content: `${channelMessage}\nUse the configured product command in its assigned channel.`,
      ephemeral: true,
    });
  } catch (err) {
    logger.error('drop_channel_setup_failed', { guildId: interaction.guildId, channelId: channel.id, error: err.message });
    return interaction.reply({ content: 'Could not save the drop channel configuration. Try again shortly.', ephemeral: true });
  }
}

async function addProduct(interaction, guildDoc) {
  const name = interaction.options.getString('name').trim();
  const commandName = interaction.options.getString('command_name')?.trim().toLowerCase();
  const categoryName = interaction.options.getString('category');
  if (!name || name.length > 80) {
    return interaction.reply({ content: 'Product name must be between 1 and 80 characters.', ephemeral: true });
  }
  if (!PRODUCT_NAME_PATTERN.test(commandName || '')) {
    return interaction.reply({ content: 'Member command must be 2–32 lowercase letters, numbers, hyphens, or underscores, without `!`. Members type `!command`.', ephemeral: true });
  }
  if (guildDoc.dropProducts.some((product) => product.name === name)) {
    return interaction.reply({ content: `Product name **${name}** is already used in this server.`, ephemeral: true });
  }
  if (guildDoc.dropProducts.some((product) => productCommandName(product) === commandName)) {
    return interaction.reply({ content: `Member command \`!${commandName}\` is already used by another generator.`, ephemeral: true });
  }
  if (guildDoc.dropProducts.length >= PRODUCT_LIMIT) {
    return interaction.reply({ content: `This server can configure up to ${PRODUCT_LIMIT} item generators. Remove one before adding another.`, ephemeral: true });
  }
  if (!guildDoc.getCategory(categoryName)) {
    return interaction.reply({ content: `Global category **${categoryName}** does not exist.`, ephemeral: true });
  }

  const quantities = new Map(TIER_NAMES.map((tierName) => [tierName, 1]));
  const cooldownInput = interaction.options.getString('cooldown_minutes');
  const cooldownMinutes = cooldownInput === 'default' ? null : cooldownInput;
  const requestedColor = interaction.options.getString('embed_color');
  const embedColor = requestedColor || getAvailableProductColor(guildDoc);
  if (requestedColor && guildDoc.dropProducts.some((product) => productColor(guildDoc, product).toUpperCase() === requestedColor.toUpperCase())) {
    return interaction.reply({ content: 'Each generator needs its own embed color. Choose a color not used by another generator.', ephemeral: true });
  }
  if (!embedColor) {
    return interaction.reply({ content: 'All 10 generator colors are in use. Edit a generator color before adding another.', ephemeral: true });
  }
  guildDoc.dropProducts.push({
    name,
    commandName,
    category: categoryName,
    quantities,
    cooldownMinutes,
    embedColor,
  });
  try {
    await guildDoc.save();
  } catch (err) {
    logger.error('drop_product_add_failed', { guildId: interaction.guildId, product: name, error: err.message });
    return interaction.reply({ content: 'Product could not be saved. Reopen `/dropconfig` before retrying.', ephemeral: true });
  }
  return interaction.reply(productTierPanel(
    guildDoc.dropProducts.find((product) => product.commandName === commandName),
    interaction.user.id,
    `Added **${name}** for shared category **${categoryName}**. Members claim it with \`!${commandName}\`.`
  ));
}

async function editProduct(interaction, guildDoc) {
  const name = interaction.options.getString('name');
  const product = guildDoc.dropProducts.find((entry) => entry.name === name);
  if (!product) return interaction.reply({ content: `Product **${name}** does not exist.`, ephemeral: true });

  const categoryName = interaction.options.getString('category');
  const commandName = interaction.options.getString('command_name');
  const cooldownMinutes = interaction.options.getString('cooldown_minutes');
  const embedColor = interaction.options.getString('embed_color');
  if (commandName && !PRODUCT_NAME_PATTERN.test(commandName)) {
    return interaction.reply({ content: 'Member command must be 2–32 lowercase letters, numbers, hyphens, or underscores, without `!`.', ephemeral: true });
  }
  if (commandName && guildDoc.dropProducts.some((entry) =>
    entry !== product && productCommandName(entry) === commandName)) {
    return interaction.reply({ content: `Member command \`!${commandName}\` is already used by another generator.`, ephemeral: true });
  }
  if (categoryName && !guildDoc.getCategory(categoryName)) {
    return interaction.reply({ content: `Global category **${categoryName}** does not exist.`, ephemeral: true });
  }
  if (embedColor && guildDoc.dropProducts.some((entry) =>
    entry !== product && productColor(guildDoc, entry).toUpperCase() === embedColor.toUpperCase())) {
    return interaction.reply({ content: 'Each generator needs its own embed color. Choose a color not used by another generator.', ephemeral: true });
  }
  if (categoryName) product.category = categoryName;
  if (commandName) product.commandName = commandName;
  if (cooldownMinutes !== null) {
    product.cooldownMinutes = cooldownMinutes === 'default' ? null : cooldownMinutes;
  }
  if (embedColor) product.embedColor = embedColor;
  try {
    await guildDoc.save();
  } catch (err) {
    logger.error('drop_product_edit_failed', { guildId: interaction.guildId, product: name, error: err.message });
    return interaction.reply({ content: 'Product edit failed. Reopen `/dropconfig` before retrying.', ephemeral: true });
  }
  return interaction.reply(productTierPanel(
    product,
    interaction.user.id,
    `Updated generator **${name}**. You can also change its tier amounts below.`
  ));
}

async function removeProduct(interaction, guildDoc) {
  const name = interaction.options.getString('name');
  if (!guildDoc.dropProducts.some((entry) => entry.name === name)) {
    return interaction.reply({ content: `Product **${name}** does not exist.`, ephemeral: true });
  }
  guildDoc.dropProducts = guildDoc.dropProducts.filter((product) => product.name !== name);
  try {
    await guildDoc.save();
  } catch (err) {
    logger.error('drop_product_remove_failed', { guildId: interaction.guildId, product: name, error: err.message });
    return interaction.reply({ content: 'Product removal failed. Reopen `/dropconfig` before retrying.', ephemeral: true });
  }
  return interaction.reply({ content: `Removed product **${name}** from this server.`, ephemeral: true });
}

async function listProducts(interaction, guildDoc) {
  if (!guildDoc.dropProducts.length) {
    return interaction.reply({ content: 'No products configured. Use the Add product button in `/dropconfig`.', ephemeral: true });
  }
  const lines = guildDoc.dropProducts.map((product) => {
    const quantities = TIER_NAMES.map((tierName) => `${tierName}: ${product.quantities.get(tierName) ?? 1}`).join(' · ');
    const cooldown = TIER_NAMES.map((tierName) => {
      const minutes = product.cooldowns?.get(tierName) ?? product.cooldownMinutes;
      return `${tierName}:${minutes === null || minutes === undefined ? 'tier' : `${minutes}m`}`;
    }).join('/');
    return `\`!${productCommandName(product)}\` → **${product.name}** → \`${product.category}\` (${quantities}; ${cooldown})`;
  });
  let content = '';
  let shown = 0;
  for (const line of lines) {
    if (content.length + line.length + 1 > 1700) break;
    content += `${content ? '\n' : ''}${line}`;
    shown += 1;
  }
  if (shown < lines.length) content += `\n…and ${lines.length - shown} more products.`;
  return interaction.reply({ content, ephemeral: true });
}

async function setTier(interaction, guildDoc) {
  const tierName = interaction.options.getString('tier');
  const channel = interaction.options.getChannel('channel');
  const channelConfig = guildDoc.dropChannels.find((entry) => entry.channelId === channel.id);
  if (!channelConfig) {
    return interaction.reply({ content: `Configure ${channel} first from the \`/dropconfig\` panel.`, ephemeral: true });
  }
  const current = channelConfig.tierSettings.get(tierName) || DEFAULT_TIER_SETTINGS;
  const challengeEveryClaims = interaction.options.getInteger('challenge_every_claims');
  if (challengeEveryClaims === null) {
    return interaction.reply({ content: 'Set how often CAPTCHA verification should be required (1-20 claims).', ephemeral: true });
  }

  const currentSettings = typeof current.toObject === 'function' ? current.toObject() : current;
  channelConfig.tierSettings.set(tierName, {
    ...currentSettings,
    challengeEveryClaims,
  });
  await guildDoc.save();
  return interaction.reply({
    content: `Updated **${tierName}** in ${channel}: CAPTCHA verification every ${challengeEveryClaims} successful claim(s). Set the product cooldown for this tier in \`/setup\` → Tiers.`,
    ephemeral: true,
  });
}

async function autocompleteButtonProduct(interaction) {
  if (interaction.options.getFocused(true).name !== 'product') return interaction.respond([]);
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const query = interaction.options.getFocused().toLowerCase();
  return interaction.respond(guildDoc.dropProducts
    .filter((product) => productCommandName(product).toLowerCase().includes(query))
    .slice(0, 25)
    .map((product) => ({
      name: `${product.name} (!${productCommandName(product)})`.slice(0, 100),
      value: productCommandName(product),
    })));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dropconfig')
    .setDescription('Open the drop configuration panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute,
  handleComponent,
  handleModal,
  publishButtonDropCommand,
  setButtonLimits,
  autocompleteButtonProduct,
  cleanupLegacyProductMenus,
};
