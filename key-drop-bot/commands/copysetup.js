'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const Guild = require('../schemas/Guild');
const logger = require('../utils/logger');

const COPY_SECTIONS = ['dropSetup', 'tiers', 'appearance', 'safety', 'credits'];

function createCopyError(message, status = 400) {
  const error = new Error(message);
  error.name = 'CopySetupError';
  error.status = status;
  return error;
}

async function findOrCreateTargetChannel(guild, sourceChannel, fallbackName) {
  const existing = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildText && channel.name === sourceChannel.name
  );
  if (existing) return existing;

  const parent = sourceChannel.parentId
    ? guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && channel.id === sourceChannel.parentId)
    : null;

  return guild.channels.create({
    name: fallbackName || sourceChannel.name,
    type: ChannelType.GuildText,
    parent: parent?.id || undefined,
    reason: 'Copying a drop-setup configuration into this server',
  });
}

async function copySetupToGuild({ client, targetGuild, sourceGuildId, sourceGuild: providedSourceGuild = null, sections = COPY_SECTIONS }) {
  if (!/^\d+$/.test(sourceGuildId || '')) {
    throw createCopyError('Provide the source server ID as a number.');
  }
  if (sourceGuildId === targetGuild.id) {
    throw createCopyError('Choose a different server to copy from.');
  }

  let sourceGuild = providedSourceGuild;
  if (!sourceGuild) {
    try {
      sourceGuild = await client.guilds.fetch(sourceGuildId);
    } catch (err) {
      logger.warn('copy_setup_source_guild_fetch_failed', {
        guildId: targetGuild.id,
        sourceGuildId,
        error: err.message,
      });
      throw createCopyError('I can only copy from a server this bot is already in.', 404);
    }
  }

  const selectedSections = [...new Set(sections)].filter((section) => COPY_SECTIONS.includes(section));
  if (!selectedSections.length) {
    throw createCopyError('Select at least one setup section to copy.');
  }

  const sourceDoc = await Guild.getOrCreate(sourceGuildId);
  if (selectedSections.includes('credits') && sourceDoc.creditSettings.invitesEnabled &&
    !targetGuild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw createCopyError('The bot needs Manage Server permission in the target server to copy enabled invite rewards.');
  }
  const targetDoc = await Guild.getOrCreate(targetGuild.id);
  const copiedDropChannels = [];
  const copiedChannelIds = new Map();

  if (selectedSections.includes('dropSetup')) {
    await targetGuild.channels.fetch();
    for (const channelConfig of sourceDoc.dropChannels) {
      const sourceChannel = await sourceGuild.channels.fetch(channelConfig.channelId).catch(() => null);
      if (!sourceChannel || sourceChannel.type !== ChannelType.GuildText) continue;

      const targetChannel = await findOrCreateTargetChannel(targetGuild, sourceChannel, sourceChannel.name);
      copiedChannelIds.set(channelConfig.channelId, targetChannel.id);
    }

    for (const channelConfig of sourceDoc.dropChannels) {
      const newChannelId = copiedChannelIds.get(channelConfig.channelId);
      if (!newChannelId) continue;
      const tierSettings = new Map();
      for (const [tierName, settings] of channelConfig.tierSettings?.entries?.() || []) {
        const plainSettings = typeof settings?.toObject === 'function' ? settings.toObject() : settings || {};
        tierSettings.set(tierName, { ...plainSettings });
      }
      copiedDropChannels.push({
        channelId: newChannelId,
        prefix: channelConfig.prefix || '!drop',
        menuMessageId: null,
        tierSettings,
      });
    }

    targetDoc.dropChannels = copiedDropChannels;
    targetDoc.dropChannelIds = copiedDropChannels.map((channelConfig) => channelConfig.channelId);
    targetDoc.dropProducts = sourceDoc.dropProducts.map((product) => ({
      name: product.name,
      commandName: product.commandName || product.name,
      category: product.category,
      description: product.description || '',
      embedColor: product.embedColor || null,
      dailyLimit: product.dailyLimit ?? null,
      cooldownMinutes: product.cooldownMinutes ?? null,
      creditCost: product.creditCost ?? 0,
      buttonChannelId: copiedChannelIds.get(product.buttonChannelId) || null,
      buttonMessageId: null,
      buttonTitle: product.buttonTitle || '',
      buttonDescription: product.buttonDescription || '',
      buttonLabel: product.buttonLabel || 'Claim',
      buttonImageUrl: product.buttonImageUrl || '',
      cooldowns: new Map(Array.from(product.cooldowns?.entries?.() || [])),
      quantities: new Map(Array.from(product.quantities?.entries?.() || [])),
    }));

    if (sourceDoc.logChannelId) {
      const sourceLogChannel = await sourceGuild.channels.fetch(sourceDoc.logChannelId).catch(() => null);
      const targetLogChannel = sourceLogChannel
        ? await findOrCreateTargetChannel(targetGuild, sourceLogChannel, sourceLogChannel.name)
        : null;
      targetDoc.logChannelId = targetLogChannel?.id || null;
    } else {
      targetDoc.logChannelId = null;
    }
  }

  if (selectedSections.includes('tiers')) {
    await sourceGuild.roles.fetch();
    await targetGuild.roles.fetch();
    const targetRolesByName = new Map(
      targetGuild.roles.cache.map((role) => [role.name.toLowerCase(), role.id])
    );
    targetDoc.tiers = new Map(Array.from(sourceDoc.tiers?.entries?.() || []).map(([tierName, tier]) => {
      const sourceTier = typeof tier?.toObject === 'function' ? tier.toObject() : tier || {};
      return [tierName, {
        ...sourceTier,
        roleId: sourceTier.roleId
          ? targetRolesByName.get(sourceGuild.roles.cache.get(sourceTier.roleId)?.name.toLowerCase()) || null
          : null,
        categories: [...(sourceTier.categories || [])],
      }];
    }));
  }

  if (selectedSections.includes('appearance')) {
    targetDoc.embedStyle = typeof sourceDoc.embedStyle?.toObject === 'function'
      ? { ...sourceDoc.embedStyle.toObject() }
      : { ...(sourceDoc.embedStyle || {}) };
  }

  if (selectedSections.includes('safety')) {
    targetDoc.quizEnabledByDefault = Boolean(sourceDoc.quizEnabledByDefault);
    targetDoc.aiCategorizationEnabled = Boolean(sourceDoc.aiCategorizationEnabled);
  }

  if (selectedSections.includes('credits')) {
    const settings = sourceDoc.creditSettings;
    const messageChannelIds = [];
    for (const sourceChannelId of settings?.messageChannelIds || []) {
      const sourceChannel = await sourceGuild.channels.fetch(sourceChannelId).catch(() => null);
      if (!sourceChannel || sourceChannel.type !== ChannelType.GuildText) continue;
      const targetChannel = await findOrCreateTargetChannel(targetGuild, sourceChannel, sourceChannel.name);
      messageChannelIds.push(targetChannel.id);
    }
    targetDoc.creditSettings = {
      ...(settings?.toObject?.() || settings || {}),
      dailyAmounts: new Map(Array.from(settings?.dailyAmounts?.entries?.() || [])),
      messageChannelIds,
      messageEligibleTiers: [...(settings?.messageEligibleTiers || [])],
    };
    const costsByCommand = new Map(sourceDoc.dropProducts.map((product) => [
      product.commandName || product.name,
      product.creditCost ?? 0,
    ]));
    for (const product of targetDoc.dropProducts) {
      const commandName = product.commandName || product.name;
      if (costsByCommand.has(commandName)) product.creditCost = costsByCommand.get(commandName);
    }
  }

  targetDoc.setupCompletedAt = new Date();
  await targetDoc.save();
  return { sourceGuild, copiedDropChannels, sections: selectedSections };
}

function selectedSectionsFromInteraction(interaction) {
  const options = {
    dropSetup: interaction.options.getBoolean('copy_drop_setup'),
    tiers: interaction.options.getBoolean('copy_tiers'),
    appearance: interaction.options.getBoolean('copy_appearance'),
    safety: interaction.options.getBoolean('copy_safety'),
    credits: interaction.options.getBoolean('copy_credits'),
  };
  const selected = Object.entries(options).filter(([, include]) => include).map(([section]) => section);
  return selected.length ? selected : COPY_SECTIONS;
}

async function copySetup({ interaction, sourceGuildId, sections = COPY_SECTIONS }) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to copy a server setup.', ephemeral: true });
  }
  if (!/^\d+$/.test(sourceGuildId || '')) {
    return interaction.reply({ content: 'Provide the source server ID as a number.', ephemeral: true });
  }
  if (sourceGuildId === interaction.guildId) {
    return interaction.reply({ content: 'Choose a different server to copy from.', ephemeral: true });
  }

  let sourceGuild;
  try {
    sourceGuild = await interaction.client.guilds.fetch(sourceGuildId);
  } catch (err) {
    logger.warn('copy_setup_source_guild_fetch_failed', {
      guildId: interaction.guildId,
      sourceGuildId,
      error: err.message,
    });
    return interaction.reply({ content: 'I can only copy from a server this bot is already in.', ephemeral: true });
  }
  const sourceMember = await sourceGuild.members.fetch(interaction.user.id).catch(() => null);
  if (!sourceMember?.permissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'You must have Administrator permission in the source server to copy its settings.', ephemeral: true });
  }

  try {
    const result = await copySetupToGuild({
      client: interaction.client,
      targetGuild: interaction.guild,
      sourceGuildId,
      sourceGuild,
      sections,
    });
    const sectionLabels = result.sections.map((section) => ({
      dropSetup: 'channels and products',
      tiers: 'tier settings',
      appearance: 'embed appearance',
      safety: 'CAPTCHA and AI settings',
      credits: 'credit earning rules and product costs',
    }[section])).join(', ');
    return interaction.reply({
      content: `✅ Copied ${sectionLabels} from **${result.sourceGuild.name}**${result.sections.includes('dropSetup') ? `. ${result.copiedDropChannels.length} drop channel(s) were configured and matching channels were created or reused` : ''}.`,
      ephemeral: true,
    });
  } catch (err) {
    logger.error('copy_setup_save_failed', { guildId: interaction.guildId, sourceGuildId, error: err.message });
    if (err.name === 'CopySetupError') {
      return interaction.reply({ content: err.message, ephemeral: true });
    }
    return interaction.reply({ content: 'The copied setup could not be saved in this server. Please try again.', ephemeral: true });
  }
}

async function execute(interaction) {
  return copySetup({
    interaction,
    sourceGuildId: interaction.options.getString('source_guild_id')?.trim(),
    sections: selectedSectionsFromInteraction(interaction),
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('copysetup')
    .setDescription('Copy an existing drop setup into this server and create matching channels.')
    .addStringOption((option) =>
      option.setName('source_guild_id')
        .setDescription('The Discord server ID to copy from. Leave all section switches off to copy everything.')
        .setRequired(true)
    )
    .addBooleanOption((option) =>
      option.setName('copy_drop_setup')
        .setDescription('Copy drop channels and products (creates or reuses matching channels).')
    )
    .addBooleanOption((option) =>
      option.setName('copy_tiers')
        .setDescription('Copy tier roles, limits, cooldowns, prices, and secure-item settings.')
    )
    .addBooleanOption((option) =>
      option.setName('copy_appearance')
        .setDescription('Copy embed appearance.')
    )
    .addBooleanOption((option) =>
      option.setName('copy_safety')
        .setDescription('Copy CAPTCHA and AI settings.')
    )
    .addBooleanOption((option) =>
      option.setName('copy_credits')
        .setDescription('Copy credit rules and generator costs, but not balances or transactions.')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute,
  copySetup,
  copySetupToGuild,
  COPY_SECTIONS,
};
