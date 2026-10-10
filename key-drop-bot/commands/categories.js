'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const Guild = require('../schemas/Guild');
const GlobalCategory = require('../schemas/GlobalCategory');
const GlobalStock = require('../schemas/GlobalStock');
const { DROP_TYPES } = require('../config/constants');
const logger = require('../utils/logger');

const CATEGORY_VIEW_PAGE_SIZE = 10;
const CATEGORY_ITEM_VALUE_LIMIT = 450;

function normalizeName(value) {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function isValidName(name) {
  return name.length >= 2 && /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(name) && !name.endsWith('-deleted');
}

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to manage global categories.', ephemeral: true });
  }

  return categoryPanel(interaction);
}

async function addCategory(interaction) {
  const name = normalizeName(interaction.options.getString('name'));
  const dropType = interaction.options.getString('drop_type');
  const description = interaction.options.getString('description')?.trim() || '';

  if (!isValidName(name)) {
    return interaction.reply({ content: 'Use 2-30 lowercase letters, numbers, or hyphens. Names ending in `-deleted` are reserved.', ephemeral: true });
  }
  if (!DROP_TYPES.includes(dropType)) {
    return interaction.reply({ content: 'Choose key, link, or cooldown-refresh category type.', ephemeral: true });
  }
  if (await GlobalCategory.exists({ name })) {
    return interaction.reply({ content: `Global category **${name}** already exists.`, ephemeral: true });
  }

  const deletedItems = await GlobalStock.exists({ category: `${name}-deleted` });
  if (deletedItems) {
    return interaction.reply({ content: `**${name}** has archived inventory. Choose another name so the archived items remain separate.`, ephemeral: true });
  }
  try {
    await GlobalCategory.create({ name, dropType, description });
  } catch (err) {
    logger.error('global_category_add_failed', { category: name, error: err.message });
    return interaction.reply({ content: 'Category creation failed. No changes were made.', ephemeral: true });
  }

  try {
    await Guild.getOrCreate(interaction.guildId);
  } catch (err) {
    logger.error('global_category_guild_sync_failed', { guildId: interaction.guildId, category: name, error: err.message });
    return interaction.reply({ content: `Global category **${name}** was created, but this server could not sync it yet. It will sync after the next interaction.`, ephemeral: true });
  }
  return interaction.reply({ content: `Created global category **${name}** (${dropType}). It will be available in every server.`, ephemeral: true });
}

async function removeCategory(interaction) {
  const name = interaction.options.getString('name');
  const category = await GlobalCategory.findOne({ name });
  if (!category) {
    return interaction.reply({ content: `Global category **${name}** does not exist.`, ephemeral: true });
  }

  try {
    const result = await GlobalStock.updateMany(
      { category: name, archived: { $ne: true } },
      { $set: { category: `${name}-deleted`, archived: true } }
    );
    await category.deleteOne();
    await synchronizeProducts(interaction, name, null);
    return interaction.reply({
      content: `Removed global category **${name}**. Its ${result.modifiedCount} stock item(s) remain visible as **${name}-deleted** and cannot be claimed.`,
      ephemeral: true,
    });
  } catch (err) {
    logger.error('global_category_remove_failed', { category: name, error: err.message });
    return interaction.reply({ content: 'Category removal failed. Reopen the `/categories` panel before retrying.', ephemeral: true });
  }
}

async function editCategory(interaction) {
  const oldName = interaction.options.getString('category');
  const category = await GlobalCategory.findOne({ name: oldName });
  if (!category) {
    return interaction.reply({ content: `Global category **${oldName}** does not exist.`, ephemeral: true });
  }

  const requestedName = interaction.options.getString('new_name');
  const newName = requestedName ? normalizeName(requestedName) : oldName;
  const dropType = interaction.options.getString('drop_type');
  const descriptionInput = interaction.options.getString('description');
  if (!requestedName && !dropType && descriptionInput === null) {
    return interaction.reply({ content: 'Provide at least one field to edit.', ephemeral: true });
  }
  if (requestedName && !isValidName(newName)) {
    return interaction.reply({ content: 'Use 2-30 lowercase letters, numbers, or hyphens. Names ending in `-deleted` are reserved.', ephemeral: true });
  }
  if (newName !== oldName && await GlobalCategory.exists({ name: newName })) {
    return interaction.reply({ content: `Global category **${newName}** already exists.`, ephemeral: true });
  }
  if (newName !== oldName && await GlobalStock.exists({ category: newName })) {
    return interaction.reply({ content: `**${newName}** already has inventory. Choose another name so stock remains separate.`, ephemeral: true });
  }
  if (dropType && !DROP_TYPES.includes(dropType)) {
    return interaction.reply({ content: 'Choose key, link, or cooldown-refresh category type.', ephemeral: true });
  }
  if (dropType && dropType !== category.dropType && await GlobalStock.exists({ category: oldName, archived: { $ne: true } })) {
    return interaction.reply({ content: 'Remove or claim all stock in this category before changing its type.', ephemeral: true });
  }

  let stockRenamed = false;
  try {
    if (newName !== oldName) {
      await GlobalStock.updateMany(
        { category: oldName, archived: { $ne: true } },
        { $set: { category: newName } }
      );
      stockRenamed = true;
      category.name = newName;
    }
    if (dropType) category.dropType = dropType;
    if (descriptionInput !== null) category.description = descriptionInput.trim();
    await category.save();
  } catch (err) {
    if (stockRenamed) {
      try {
        await GlobalStock.updateMany(
          { category: newName, archived: { $ne: true } },
          { $set: { category: oldName } }
        );
      } catch (rollbackError) {
        logger.error('global_category_rename_rollback_failed', {
          category: oldName,
          newCategory: newName,
          error: rollbackError.message,
        });
        return interaction.reply({ content: `Category save failed and stock rollback also failed. Check the \`/database\` panel; some stock may appear as **${newName}-deleted**.`, ephemeral: true });
      }
    }
    category.name = oldName;
    logger.error('global_category_edit_failed', { category: oldName, error: err.message });
    return interaction.reply({ content: 'Category edit failed. Check the `/categories` and `/database` panels before retrying.', ephemeral: true });
  }

  await synchronizeProducts(interaction, oldName, newName);
  return interaction.reply({ content: `Updated global category **${newName}**.`, ephemeral: true });
}

async function synchronizeProducts(interaction, oldCategory, newCategory) {
  const cursor = Guild.find({ 'dropProducts.category': oldCategory }).cursor();
  for await (const guildDoc of cursor) {
    try {
      if (newCategory) {
        for (const product of guildDoc.dropProducts) {
          if (product.category === oldCategory) product.category = newCategory;
        }
      } else {
        guildDoc.dropProducts = guildDoc.dropProducts.filter((product) => product.category !== oldCategory);
      }
      await guildDoc.save();
    } catch (err) {
      logger.error('global_category_product_sync_failed', {
        guildId: guildDoc.guildId,
        category: oldCategory,
        error: err.message,
      });
    }
  }
}

async function listCategories(interaction) {
  const categories = await GlobalCategory.find({}).sort({ name: 1 }).lean();
  const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Global drop categories');
  if (!categories.length) {
    embed.setDescription('No global categories yet. Use Add in the `/categories` panel.');
  } else {
    const lines = categories.slice(0, 25).map((category) =>
      `**${category.name}** (${category.dropType})${category.description ? ` — ${category.description}` : ''}`
    );
    if (categories.length > lines.length) lines.push(`And ${categories.length - 25} more.`);
    embed.setDescription(lines.join('\n'));
    embed.setFooter({ text: 'Categories and inventory are shared by all servers.' });
  }
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function categoryPanel(interaction) {
  const categories = await GlobalCategory.find({}).sort({ name: 1 }).limit(25).lean();
  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('Category management')
    .setDescription(
      categories.length
        ? categories.map((category) => `**${category.name}** (${category.dropType})${category.description ? ` — ${category.description}` : ''}`).join('\n')
        : 'No categories exist yet.'
    )
    .addFields(
      { name: 'Actions', value: 'Use the buttons below to create, edit, remove, and inspect categories.', inline: false },
      { name: 'Inventory', value: 'Category inspection displays the inventory values and claim status privately.', inline: false }
    )
    .setFooter({ text: 'Categories and inventory are shared by every server.' });
  if (categories.length === 25) {
    const count = await GlobalCategory.countDocuments({});
    if (count > categories.length) embed.setFooter({ text: `Showing 25 of ${count} categories. Categories and inventory are shared globally.` });
  }
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('categories:action:add').setLabel('Add').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('categories:action:edit').setLabel('Edit').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('categories:action:remove').setLabel('Remove').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('categories:action:list').setLabel('List').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('categories:action:view').setLabel('View inventory').setStyle(ButtonStyle.Secondary)
    ),
  ];
  return interaction.reply({ embeds: [embed], components, ephemeral: true });
}

async function viewCategory(interaction, name, page, update = false) {
  const category = await GlobalCategory.findOne({ name }).lean();
  if (!category) {
    const content = `Global category **${name}** does not exist.`;
    return update
      ? interaction.update({ content, embeds: [], components: [] })
      : interaction.reply({ content, ephemeral: true });
  }

  const query = { category: name };
  const total = await GlobalStock.countDocuments(query);
  const pageCount = Math.max(1, Math.ceil(total / CATEGORY_VIEW_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  const items = await GlobalStock.find(query)
    .sort({ createdAt: 1, _id: 1 })
    .skip(currentPage * CATEGORY_VIEW_PAGE_SIZE)
    .limit(CATEGORY_VIEW_PAGE_SIZE)
    .lean();
  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(`Inventory: ${category.name}`)
    .setDescription(`${category.dropType} category${category.description ? ` • ${category.description}` : ''}\n${total} item(s) total. Values are shown to administrators only.`)
    .setFooter({ text: `Page ${currentPage + 1}/${pageCount}` });

  if (!items.length) {
    embed.addFields({ name: 'Inventory', value: 'This category has no inventory.' });
  } else {
    const offset = currentPage * CATEGORY_VIEW_PAGE_SIZE;
    embed.addFields(items.map((item, index) => ({
      name: `#${offset + index + 1} • ${item.archived ? 'Archived' : item.claimed ? 'Claimed' : 'Available'}`,
      value: item.value.length > CATEGORY_ITEM_VALUE_LIMIT
        ? `${item.value.slice(0, CATEGORY_ITEM_VALUE_LIMIT - 3)}...`
        : item.value,
      inline: false,
    })));
  }

  const components = total > CATEGORY_VIEW_PAGE_SIZE
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`categories:view:${name}:${currentPage - 1}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`categories:view:${name}:${currentPage + 1}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= pageCount - 1)
    )]
    : [];

  const payload = { embeds: [embed], components };
  return update ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true });
}

async function handleComponent(interaction) {
  const [, action, name, pageString] = interaction.customId.split(':');
  if (action === 'action') {
    if (name === 'list') return listCategories(interaction);
    return showCategoryModal(interaction, name);
  }
  if (action === 'panel_view') return viewCategory(interaction, interaction.values[0], 0, true);
  if (action !== 'view') return interaction.reply({ content: 'Unknown category panel action.', ephemeral: true });
  return viewCategory(interaction, name, Number(pageString) || 0, true);
}

async function showCategoryModal(interaction, action) {
  const modal = new ModalBuilder()
    .setCustomId(`categories:modal:${action}`)
    .setTitle(`${action[0].toUpperCase()}${action.slice(1)} category`);
  const input = (id, label, required, style = TextInputStyle.Short, maxLength = 100) =>
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(maxLength);
  if (action === 'add') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('name', 'Category name', true, TextInputStyle.Short, 30)),
      new ActionRowBuilder().addComponents(input('drop_type', 'Type: key, link, cooldown-refresh', true, TextInputStyle.Short, 16)),
      new ActionRowBuilder().addComponents(input('description', 'Description (optional)', false))
    );
  } else if (action === 'edit') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('category', 'Current category name', true, TextInputStyle.Short, 30)),
      new ActionRowBuilder().addComponents(input('new_name', 'New name (optional)', false, TextInputStyle.Short, 30)),
      new ActionRowBuilder().addComponents(input('drop_type', 'New type: key, link, cooldown-refresh', false, TextInputStyle.Short, 16)),
      new ActionRowBuilder().addComponents(input('description', 'New description (optional)', false))
    );
  } else if (action === 'remove') {
    modal.addComponents(new ActionRowBuilder().addComponents(input('name', 'Category name to remove', true, TextInputStyle.Short, 30)));
  } else if (action === 'view') {
    modal.addComponents(new ActionRowBuilder().addComponents(input('name', 'Category to inspect', true, TextInputStyle.Short, 30)));
  } else {
    return interaction.reply({ content: 'Unknown category action.', ephemeral: true });
  }
  return interaction.showModal(modal);
}

async function handleModal(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to manage global categories.', ephemeral: true });
  }
  const [, , action] = interaction.customId.split(':');
  if (action === 'view') return viewCategory(interaction, interaction.fields.getTextInputValue('name').trim(), 0);
  const values = Object.fromEntries(interaction.fields.fields.map((field) => [field.customId, field.value]));
  const options = {
    getSubcommand: () => action,
    getString: (name) => values[name]?.trim() || null,
  };
  const adaptedInteraction = Object.create(interaction);
  adaptedInteraction.options = options;
  return executeCategoryAction(adaptedInteraction, action);
}

async function executeCategoryAction(interaction, action) {
  switch (action) {
    case 'add': return addCategory(interaction);
    case 'edit': return editCategory(interaction);
    case 'remove': return removeCategory(interaction);
    default: return interaction.reply({ content: 'Unknown category action.', ephemeral: true });
  }
}

module.exports = {
  data: new SlashCommandBuilder().setName('categories').setDescription('Open the category management panel.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute,
  handleComponent,
  handleModal,
};
