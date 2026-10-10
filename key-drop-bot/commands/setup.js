'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const Guild = require('../schemas/Guild');
const { TIER_NAMES, DEFAULT_SECURE_ITEMS_PER_CLICK } = require('../config/constants');
const logger = require('../utils/logger');
const { copySetup } = require('./copysetup');

function dashboardConfigured() {
  return Boolean(process.env.DISCORD_CLIENT_SECRET && process.env.DASHBOARD_REDIRECT_URI);
}

const QUICKSTART_TIER_SETTINGS = Object.fromEntries(TIER_NAMES.map((tierName) => [
  tierName,
  {
    buttonDailyLimit: 4,
    buttonCooldownMinutes: 0,
    prefixCooldownMinutes: 0,
    challengeEveryClaims: 3,
  },
]));

const MAIN_MENU_OPTIONS = [
  { label: 'Quick start (recommended)', value: 'quickstart', description: 'Choose drop channels and use sensible defaults' },
  { label: 'Drop Channels', value: 'channels', description: 'Where public claim announcements post' },
  { label: 'Log Channel', value: 'log_channel', description: 'Where admin activity is logged' },
  { label: 'Embed Appearance', value: 'embed', description: 'Color, title, footer, images' },
  { label: 'Copy Setup from Another Server', value: 'copy_setup', description: 'Clone a working server setup and create matching channels' },
  { label: 'Tiers (cooldown, price, secure rules)', value: 'tiers', description: 'Configure roles and benefits for Free → Diamond' },
  { label: 'CAPTCHA & AI Toggles', value: 'toggles', description: 'Default CAPTCHA gate, AI auto-categorization' },
  { label: 'Finish Setup', value: 'finish', description: 'Mark setup complete' },
];

function mainMenuRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('setup:menu')
    .setPlaceholder('What would you like to configure?')
    .addOptions(MAIN_MENU_OPTIONS);
  return new ActionRowBuilder().addComponents(menu);
}

async function execute(interaction) {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to run /setup.', ephemeral: true });
  }

  await Guild.getOrCreate(interaction.guildId);

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('Key Drop Bot — Setup')
    .setDescription(`Choose Quick start for a fast default setup, then add generators with \`/dropconfig\`${dashboardConfigured() ? ' or customize settings in the web dashboard' : ' and fine-tune settings in this menu'}.`);

  await interaction.reply({ embeds: [embed], components: [mainMenuRow()], ephemeral: true });
}

async function handleComponent(interaction) {
  const [, action, arg] = interaction.customId.split(':');
  const guildDoc = await Guild.getOrCreate(interaction.guildId);

  switch (action) {
    case 'menu':
      return handleMainMenuSelect(interaction, guildDoc);
    case 'channels_drop':
      guildDoc.dropChannelIds = interaction.values;
      await guildDoc.save();
      return interaction.update({ content: `Drop channels set: ${interaction.values.map((id) => `<#${id}>`).join(', ')}`, embeds: [], components: [mainMenuRow()] });
    case 'quickstart_channels': {
      const configured = new Map(guildDoc.dropChannels.map((entry) => [entry.channelId, entry]));
      for (const channelId of interaction.values) {
        if (!configured.has(channelId)) {
          configured.set(channelId, {
            channelId,
            prefix: '!drop',
            tierSettings: new Map(Object.entries(QUICKSTART_TIER_SETTINGS)),
          });
        }
      }
      guildDoc.dropChannels = [...configured.values()];
      guildDoc.dropChannelIds = [...new Set([...guildDoc.dropChannelIds, ...interaction.values])];
      guildDoc.setupCompletedAt = new Date();
      await guildDoc.save();
      const configuredChannelIds = guildDoc.dropChannels.map((entry) => entry.channelId);
      const nextStep = dashboardConfigured()
        ? 'Add a generator in `/dropconfig` or use the web dashboard to customize tiers, appearance, CAPTCHA, and products.'
        : 'Add a generator in `/dropconfig`; run `/setup` again to customize tiers, appearance, CAPTCHA, and other settings.';
      return interaction.update({
        content: `✅ Quick setup complete. Drop channels: ${configuredChannelIds.map((id) => `<#${id}>`).join(', ')}. ${nextStep}`,
        embeds: [],
        components: [mainMenuRow()],
      });
    }
    case 'channels_log':
      guildDoc.logChannelId = interaction.values[0];
      await guildDoc.save();
      return interaction.update({ content: `Log channel set: <#${interaction.values[0]}>`, embeds: [], components: [mainMenuRow()] });
    case 'copy_setup':
      return promptCopySetupModal(interaction);
    case 'tier_select':
      return promptTierModal(interaction, interaction.values[0], guildDoc);
    case 'tier_role':
      return handleTierRoleSelect(interaction, arg, guildDoc);
    case 'toggle_quiz':
      guildDoc.quizEnabledByDefault = !guildDoc.quizEnabledByDefault;
      await guildDoc.save();
      return showToggles(interaction, guildDoc);
    case 'toggle_ai':
      guildDoc.aiCategorizationEnabled = !guildDoc.aiCategorizationEnabled;
      await guildDoc.save();
      return showToggles(interaction, guildDoc);
    case 'back':
      return interaction.update({ content: null, embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Key Drop Bot — Setup').setDescription('Pick a section to configure.')], components: [mainMenuRow()] });
    default:
      return interaction.update({ content: 'Unknown setup action.', components: [mainMenuRow()] });
  }
}

async function handleMainMenuSelect(interaction, guildDoc) {
  const choice = interaction.values[0];
  switch (choice) {
    case 'quickstart': {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId('setup:quickstart_channels')
        .setPlaceholder('Choose up to 5 drop channels')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(5);
      return interaction.update({
        content: 'Pick where members will use `!drop`. Quick start keeps your existing settings and uses the bot’s safe defaults for new channels.',
        embeds: [],
        components: [new ActionRowBuilder().addComponents(menu), backRow()],
      });
    }
    case 'channels': {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId('setup:channels_drop')
        .setPlaceholder('Select one or more drop channels')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(5);
      return interaction.update({ content: 'Select the channel(s) public drop claims will be announced in:', embeds: [], components: [new ActionRowBuilder().addComponents(menu), backRow()] });
    }
    case 'log_channel': {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId('setup:channels_log')
        .setPlaceholder('Select a log channel')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);
      return interaction.update({ content: 'Select the channel admin activity will be logged to:', embeds: [], components: [new ActionRowBuilder().addComponents(menu), backRow()] });
    }
    case 'embed':
      return promptEmbedModal(interaction);
    case 'copy_setup':
      return promptCopySetupModal(interaction);
    case 'tiers': {
      const menu = new StringSelectMenuBuilder()
        .setCustomId('setup:tier_select')
        .setPlaceholder('Select a tier to configure')
        .addOptions(TIER_NAMES.map((t) => ({ label: guildDoc.getTier(t)?.label || t, value: t })));
      return interaction.update({ content: 'Select a tier to edit its daily limit, cooldown, shop price/explanation, secure limit, and role:', embeds: [], components: [new ActionRowBuilder().addComponents(menu), backRow()] });
    }
    case 'toggles':
      return showToggles(interaction, guildDoc);
    case 'finish':
      guildDoc.setupCompletedAt = new Date();
      await guildDoc.save();
      return interaction.update({ content: '✅ Setup marked complete. Run `/setup` any time to make changes.', embeds: [], components: [] });
    default:
      return interaction.update({ content: 'Unknown option.', components: [mainMenuRow()] });
  }
}

function backRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:back').setLabel('← Back to menu').setStyle(ButtonStyle.Secondary)
  );
}

function promptCopySetupModal(interaction) {
  const modal = new ModalBuilder().setCustomId('setup:copy_setup_modal').setTitle('Copy setup from another server');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('source_guild_id')
        .setLabel('Source server ID')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Paste the server ID from the source guild')
    )
  );
  return interaction.showModal(modal);
}

// ---------- Embed style ----------

function promptEmbedModal(interaction) {
  const modal = new ModalBuilder().setCustomId('setup:embed_modal').setTitle('Embed Appearance');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('color').setLabel('Hex color (e.g. #5865F2)').setStyle(TextInputStyle.Short).setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Embed title').setStyle(TextInputStyle.Short).setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('footer').setLabel('Footer text').setStyle(TextInputStyle.Short).setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('thumbnailUrl').setLabel('Thumbnail image URL').setStyle(TextInputStyle.Short).setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('imageUrl').setLabel('Banner image URL').setStyle(TextInputStyle.Short).setRequired(false)
    )
  );
  return interaction.showModal(modal);
}

async function handleEmbedModal(interaction, guildDoc) {
  const color = interaction.fields.getTextInputValue('color').trim();
  const title = interaction.fields.getTextInputValue('title').trim();
  const footer = interaction.fields.getTextInputValue('footer').trim();
  const thumbnailUrl = interaction.fields.getTextInputValue('thumbnailUrl').trim();
  const imageUrl = interaction.fields.getTextInputValue('imageUrl').trim();

  if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
    return interaction.reply({ content: 'Color must be a 6-digit hex code like `#5865F2`.', ephemeral: true });
  }

  guildDoc.embedStyle = {
    color: color || guildDoc.embedStyle.color,
    title: title || guildDoc.embedStyle.title,
    footer: footer || guildDoc.embedStyle.footer,
    thumbnailUrl: thumbnailUrl || guildDoc.embedStyle.thumbnailUrl,
    imageUrl: imageUrl || guildDoc.embedStyle.imageUrl,
  };
  await guildDoc.save();

  const preview = new EmbedBuilder()
    .setColor(guildDoc.embedStyle.color)
    .setTitle(guildDoc.embedStyle.title)
    .setFooter({ text: guildDoc.embedStyle.footer })
    .setDescription('This is a preview of your drop embed style.');
  if (guildDoc.embedStyle.thumbnailUrl) preview.setThumbnail(guildDoc.embedStyle.thumbnailUrl);
  if (guildDoc.embedStyle.imageUrl) preview.setImage(guildDoc.embedStyle.imageUrl);

  return interaction.reply({ content: 'Embed style saved.', embeds: [preview], components: [mainMenuRow()], ephemeral: true });
}

// ---------- Tiers ----------

function promptTierModal(interaction, tierName, guildDoc) {
  const tier = guildDoc.getTier(tierName);
  const modal = new ModalBuilder().setCustomId(`setup:tier_modal:${tierName}`).setTitle(`Configure tier: ${tierName}`);
  const descriptionInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Shop tier explanation')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(850);
  if (tier?.description) descriptionInput.setValue(tier.description.slice(0, 850));
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('dailyLimit').setLabel('Daily drop limit (0-100)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setValue(String(tier?.dailyLimit ?? 1))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('cooldownMinutes').setLabel('Item command cooldown in minutes (0-10080)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setValue(String(tier?.cooldownMinutes ?? 0))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('price').setLabel('Shop price (e.g. 4.99, 0 for free)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10).setValue(String(tier?.price ?? 0))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('secureItemsPerClick')
        .setLabel('Items removed per secure click (0 = auto)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(2)
        .setValue(String(tier?.secureItemsPerClick ?? defaultSecureItemsPerClick(tierName)))
    ),
    new ActionRowBuilder().addComponents(
      descriptionInput
    )
  );
  return interaction.showModal(modal);
}

function defaultSecureItemsPerClick(tierName) {
  return DEFAULT_SECURE_ITEMS_PER_CLICK[tierName] ?? 1;
}

async function handleTierModal(interaction, tierName, guildDoc) {
  const dailyLimit = Number(interaction.fields.getTextInputValue('dailyLimit'));
  const cooldownMinutes = Number(interaction.fields.getTextInputValue('cooldownMinutes'));
  const price = Number(interaction.fields.getTextInputValue('price'));
  const secureItemsPerClick = Number(interaction.fields.getTextInputValue('secureItemsPerClick'));
  const description = interaction.fields.getTextInputValue('description').trim();

  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 100 ||
    !Number.isInteger(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 10080 ||
    !Number.isFinite(price) || price < 0 || price > 1_000_000 ||
    !Number.isInteger(secureItemsPerClick) || secureItemsPerClick < 0 || secureItemsPerClick > 25) {
    return interaction.reply({ content: 'Daily drops must be 0-100, cooldown must be 0-10080 minutes, price must be 0-1000000, and secure items must be a whole number from 0 to 25 (0 means automatic removal).', ephemeral: true });
  }

  const current = guildDoc.getTier(tierName) || {};
  guildDoc.tiers.set(tierName, { ...current, dailyLimit, cooldownMinutes, price, description, secureItemsPerClick });
  await guildDoc.save();

  const roleMenu = new RoleSelectMenuBuilder().setCustomId(`setup:tier_role:${tierName}`).setPlaceholder(`Assign the role that marks a member as ${tierName}`);
  return interaction.reply({
    content: `Saved **${tierName}**: ${dailyLimit}/day, ${cooldownMinutes}m cooldown, $${price.toFixed(2)}, secure ${secureItemsPerClick || 'automatically'}. Now pick the role for this tier:`,
    components: [new ActionRowBuilder().addComponents(roleMenu), backRow()],
    ephemeral: true,
  });
}

async function handleTierRoleSelect(interaction, tierName, guildDoc) {
  const roleId = interaction.values[0];
  const current = guildDoc.getTier(tierName) || {};
  guildDoc.tiers.set(tierName, { ...current, roleId });
  await guildDoc.save();
  return interaction.update({ content: `Tier **${tierName}** now maps to <@&${roleId}>.`, components: [mainMenuRow()] });
}

// ---------- Toggles ----------

async function showToggles(interaction, guildDoc) {
  const quizBtn = new ButtonBuilder()
    .setCustomId('setup:toggle_quiz')
    .setLabel(`CAPTCHA gate by default: ${guildDoc.quizEnabledByDefault ? 'ON' : 'OFF'}`)
    .setStyle(guildDoc.quizEnabledByDefault ? ButtonStyle.Success : ButtonStyle.Secondary);
  const aiBtn = new ButtonBuilder()
    .setCustomId('setup:toggle_ai')
    .setLabel(`AI bulk categorization: ${guildDoc.aiCategorizationEnabled ? 'ON' : 'OFF'}`)
    .setStyle(guildDoc.aiCategorizationEnabled ? ButtonStyle.Success : ButtonStyle.Secondary);

  return interaction.update({
    content: 'Toggle defaults below. Per drop, use `!drop <category> <amount> yes` to require a CAPTCHA or `no` to skip it.',
    embeds: [],
    components: [new ActionRowBuilder().addComponents(quizBtn, aiBtn), backRow()],
  });
}

// ---------- Modal dispatch ----------

async function handleModal(interaction) {
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const [, action, arg] = interaction.customId.split(':');

  try {
    switch (action) {
      case 'embed_modal':
        return await handleEmbedModal(interaction, guildDoc);
      case 'copy_setup_modal':
        return await copySetup({
          interaction,
          sourceGuildId: interaction.fields.getTextInputValue('source_guild_id').trim(),
        });
      case 'tier_modal':
        return await handleTierModal(interaction, arg, guildDoc);
      default:
        return interaction.reply({ content: 'Unknown setup modal.', ephemeral: true });
    }
  } catch (err) {
    logger.error('setup_modal_failed', { action, error: err.message });
    return interaction.reply({ content: 'Something went wrong saving that. Nothing was changed — try again.', ephemeral: true });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure drop channels, embed style, tiers, and drop options.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute,
  handleComponent,
  handleModal,
};
