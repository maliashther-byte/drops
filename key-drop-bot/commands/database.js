'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');

const Guild = require('../schemas/Guild');
const Stock = require('../schemas/GlobalStock');
const LegacyStock = require('../schemas/Stock');
const GlobalCategory = require('../schemas/GlobalCategory');
const { categorizeLines } = require('../handlers/aiHandler');
const logger = require('../utils/logger');

const MAX_BULK_LINES = 100_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const BULK_INSERT_BATCH_SIZE = 1000;
const AI_CATEGORIZATION_LINE_LIMIT = 5000;

async function execute(interaction) {
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const category = interaction.options.getString('category');
  const attachment = interaction.options.getAttachment('file');
  if (category || attachment) {
    if (!category || !attachment) {
      return interaction.reply({ content: 'Choose both a category and a `.txt` file to bulk upload.', ephemeral: true });
    }
    return handleBulk(interaction, guildDoc);
  }
  return showDatabasePanel(interaction, guildDoc);
}

async function showDatabasePanel(interaction, guildDoc) {
  const payload = await buildStockView(guildDoc, true);
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('database:panel:add').setLabel('Add items').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('database:panel:bulk').setLabel('Bulk upload').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('database:panel:remove').setLabel('Remove item').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('database:panel:edit').setLabel('Edit item').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('database:panel:view').setLabel('Refresh stock').setStyle(ButtonStyle.Secondary)
  );
  return interaction.reply({ ...payload, components: [buttons], ephemeral: true });
}

async function showDatabaseModal(interaction, action) {
  const modal = new ModalBuilder().setCustomId(`database:panel_modal:${action}`).setTitle(`${action[0].toUpperCase()}${action.slice(1)} stock`);
  const input = (id, label, required, style = TextInputStyle.Short) =>
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (action === 'bulk') {
    modal.setTitle('Paste bulk stock');
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('category', 'Fallback category name', true)),
      new ActionRowBuilder().addComponents(input('values', 'Inventory items (one per line)', true, TextInputStyle.Paragraph).setMaxLength(4000))
    );
  } else if (action === 'add') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('category', 'Category name', true)),
      new ActionRowBuilder().addComponents(input('value', 'Values (one per line)', true, TextInputStyle.Paragraph))
    );
  } else if (action === 'remove') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('category', 'Category name', true)),
      new ActionRowBuilder().addComponents(input('value', 'Exact item value to remove', true))
    );
  } else if (action === 'edit') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(input('category', 'Category name', true)),
      new ActionRowBuilder().addComponents(input('current_value', 'Exact current item value', true)),
      new ActionRowBuilder().addComponents(input('new_value', 'Replacement item value', true))
    );
  }
  return interaction.showModal(modal);
}

async function handleComponent(interaction) {
  const [, action, panelAction] = interaction.customId.split(':');
  if (action !== 'panel') return interaction.reply({ content: 'Unknown database panel action.', ephemeral: true });
  if (panelAction === 'bulk') {
    return showDatabaseModal(interaction, panelAction);
  }
  if (panelAction === 'view') {
    const guildDoc = await Guild.getOrCreate(interaction.guildId);
    const payload = await buildStockView(guildDoc, true);
    return interaction.update({ ...payload, components: interaction.message.components });
  }
  if (['add', 'remove', 'edit'].includes(panelAction)) return showDatabaseModal(interaction, panelAction);
  return interaction.reply({ content: 'Unknown database panel action.', ephemeral: true });
}

async function handleModal(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: 'Administrator permission is required to manage stock.', ephemeral: true });
  }
  const [, , action] = interaction.customId.split(':');
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  try {
    if (action === 'bulk') return await handleBulkTextModal(interaction, guildDoc);
    if (action === 'add') {
      return await handleAddModal(interaction, interaction.fields.getTextInputValue('category').trim(), guildDoc);
    }
    const values = Object.fromEntries(interaction.fields.fields.map((field) => [field.customId, field.value]));
    const options = { getString: (name) => values[name]?.trim() || null };
    const adaptedInteraction = Object.create(interaction);
    adaptedInteraction.options = options;
    if (action === 'remove') return await handleRemove(adaptedInteraction, guildDoc);
    if (action === 'edit') return await handleEdit(adaptedInteraction, guildDoc);
    return interaction.reply({ content: 'Unknown database panel action.', ephemeral: true });
  } catch (err) {
    logger.error('database_panel_action_failed', { action, error: err.message });
    const payload = { content: 'The stock action failed. Nothing else was changed.', ephemeral: true };
    return interaction.deferred || interaction.replied
      ? interaction.followUp(payload)
      : interaction.reply(payload);
  }
}

async function handleAddModal(interaction, categoryName, guildDoc) {
  const category = guildDoc.getCategory(categoryName);
  if (!category) {
    return interaction.reply({ content: `Category **${categoryName}** no longer exists.`, ephemeral: true });
  }

  const raw = interaction.fields.getTextInputValue('value');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    return interaction.reply({ content: 'No non-empty lines found.', ephemeral: true });
  }

  const { inserted, duplicates } = await insertStock(categoryName, category.dropType, lines, interaction.user.id, 'manual');

  return interaction.reply({
    content: `Added **${inserted}** item(s) to **${categoryName}**.${duplicates ? ` Skipped ${duplicates} duplicate(s).` : ''}`,
    ephemeral: true,
  });
}

// ---------- Bulk uploads ----------

async function handleBulk(interaction, guildDoc) {
  const categoryName = interaction.options.getString('category');
  const attachment = interaction.options.getAttachment('file');
  const category = guildDoc.getCategory(categoryName);

  if (!category) {
    return interaction.reply({ content: `No category named **${categoryName}**. Create it first from the \`/categories\` panel.`, ephemeral: true });
  }
  if (!attachment.name.toLowerCase().endsWith('.txt')) {
    return interaction.reply({ content: 'Please attach a `.txt` file.', ephemeral: true });
  }
  if (attachment.size > MAX_FILE_BYTES) {
    return interaction.reply({ content: `File too large. Max ${MAX_FILE_BYTES / 1024 / 1024}MB.`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  let text;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_FILE_BYTES) {
      return interaction.editReply(`File too large. Max ${MAX_FILE_BYTES / 1024 / 1024}MB.`);
    }
    text = buffer.toString('utf8');
  } catch (err) {
    logger.error('database_bulk_download_failed', { error: err.message });
    return interaction.editReply('Could not download the attachment. Try again.');
  }

  const parsed = parseBulkLines(text);
  if (parsed.exceedsLimit) {
    return interaction.editReply(`This upload contains more than **${MAX_BULK_LINES.toLocaleString()}** items. Split the file and upload it in parts.`);
  }
  const { lines } = parsed;
  if (!lines.length) {
    return interaction.editReply('File had no usable lines.');
  }

  return processBulkLines(interaction, guildDoc, categoryName, category, lines, (content) => interaction.editReply(content));
}

async function handleBulkTextModal(interaction, guildDoc) {
  const categoryName = interaction.fields.getTextInputValue('category').trim();
  const category = guildDoc.getCategory(categoryName);
  if (!category) {
    return interaction.reply({ content: `No category named **${categoryName}**. Create it first from the \`/categories\` panel.`, ephemeral: true });
  }
  const parsed = parseBulkLines(interaction.fields.getTextInputValue('values'));
  const { lines } = parsed;
  if (!lines.length) return interaction.reply({ content: 'No usable items were provided.', ephemeral: true });
  if (parsed.exceedsLimit) {
    return interaction.reply({ content: `This upload contains more than **${MAX_BULK_LINES.toLocaleString()}** items. Upload it in parts using \`/database category:<name> file:<.txt>\`.`, ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  return processBulkLines(interaction, guildDoc, categoryName, category, lines, (content) => interaction.editReply(content));
}

function parseBulkLines(text) {
  const lines = [];
  const normalized = text.replace(/^\uFEFF/, '');
  for (const match of normalized.matchAll(/[^\r\n]+/g)) {
    const line = match[0].trim();
    if (!line) continue;
    if (lines.length === MAX_BULK_LINES) return { lines, exceedsLimit: true };
    lines.push(line);
  }
  return { lines, exceedsLimit: false };
}

async function processBulkLines(interaction, guildDoc, categoryName, category, lines, respond) {
  const useAi = guildDoc.aiCategorizationEnabled && lines.length <= AI_CATEGORIZATION_LINE_LIMIT;
  const categoryNames = useAi
    ? guildDoc.categories.filter((entry) => entry.dropType !== 'role').map((entry) => entry.name)
    : [];
  const totals = new Map();
  let processed = 0;

  for (let offset = 0; offset < lines.length; offset += BULK_INSERT_BATCH_SIZE) {
    const batch = lines.slice(offset, offset + BULK_INSERT_BATCH_SIZE);
    let grouped;
    if (useAi) {
      try {
        grouped = await categorizeLines(batch, categoryNames);
      } catch (err) {
        logger.error('database_bulk_categorize_failed', { error: err.message, batchStart: offset });
        return respond(`Upload stopped after ${processed.toLocaleString()} of ${lines.length.toLocaleString()} lines. AI categorization failed; check the database before retrying the remaining lines.`);
      }
    } else {
      grouped = new Map([[categoryName, batch]]);
    }

    for (const [targetCategoryName, categoryLines] of grouped.entries()) {
      if (!categoryLines.length) continue;
      const targetCategory = guildDoc.getCategory(targetCategoryName);
      const targetName = targetCategory ? targetCategory.name : categoryName;
      const dropType = targetCategory ? targetCategory.dropType : category.dropType;
      const source = useAi ? 'bulk-ai' : 'bulk-keyword';
      let result;
      try {
        result = await insertStock(targetName, dropType, categoryLines, interaction.user.id, source);
      } catch (err) {
        const partial = totals.get(targetName) || { inserted: 0, duplicates: 0 };
        partial.inserted += err.partialInserted || 0;
        partial.duplicates += err.duplicateCount || 0;
        totals.set(targetName, partial);
        const insertedSoFar = [...totals.values()].reduce((total, value) => total + value.inserted, 0);
        const duplicateCount = [...totals.values()].reduce((total, value) => total + value.duplicates, 0);
        const batchEnd = Math.min(offset + batch.length, lines.length);
        logger.error('database_bulk_insert_failed', {
          category: targetName,
          batchStart: offset,
          batchEnd,
          processedLines: processed,
          totalLines: lines.length,
          inserted: insertedSoFar,
          duplicates: duplicateCount,
          error: err.message,
        });
        return respond(
          `Upload stopped during input lines **${(offset + 1).toLocaleString()}–${batchEnd.toLocaleString()}** ` +
          `(before this batch, **${processed.toLocaleString()} / ${lines.length.toLocaleString()}** lines were fully processed). ` +
          `**${insertedSoFar.toLocaleString()}** item(s) were added and **${duplicateCount.toLocaleString()}** duplicates skipped; ` +
          'part of the current batch may already be stored. ' +
          (useAi
            ? 'Check stock before retrying; AI may categorize the same lines differently.'
            : 'After resolving the database error, retry the same file; exact duplicates in the selected category are skipped.')
        );
      }
      const { inserted, duplicates } = result;
      const total = totals.get(targetName) || { inserted: 0, duplicates: 0 };
      total.inserted += inserted;
      total.duplicates += duplicates;
      totals.set(targetName, total);
    }

    processed += batch.length;
    if (processed < lines.length && processed % (BULK_INSERT_BATCH_SIZE * 10) === 0) {
      await respond(`Uploading in batches: **${processed.toLocaleString()} / ${lines.length.toLocaleString()}** items processed.`);
    }
  }

  const totalInserted = [...totals.values()].reduce((total, value) => total + value.inserted, 0);
  const totalDuplicates = [...totals.values()].reduce((total, value) => total + value.duplicates, 0);
  const perCategory = [...totals.entries()]
    .filter(([, value]) => value.inserted)
    .map(([name, value]) => `• ${name}: +${value.inserted.toLocaleString()}`);
  const categorizationNote = guildDoc.aiCategorizationEnabled && !useAi
    ? ' AI categorization was skipped for this large upload; all items were added to the selected category.'
    : useAi
      ? ' AI categorization was enabled.'
      : ' AI categorization was off.';

  return respond(
    `Upload complete: **${lines.length.toLocaleString()} / ${lines.length.toLocaleString()}** non-empty lines processed; ` +
    `**${totalInserted.toLocaleString()}** added, **${totalDuplicates.toLocaleString()}** duplicate(s) skipped.${categorizationNote}\n` +
    `${perCategory.join('\n') || 'No new items were added.'}`
  );
}

async function insertStock(category, dropType, values, addedBy, source) {
  let inserted = 0;
  let duplicates = 0;
  for (let offset = 0; offset < values.length; offset += BULK_INSERT_BATCH_SIZE) {
    const docs = values.slice(offset, offset + BULK_INSERT_BATCH_SIZE).map((value) => ({
      category,
      dropType,
      value,
      addedBy,
      source,
    }));

    try {
      const result = await Stock.insertMany(docs, { ordered: false });
      inserted += result.length;
    } catch (err) {
      if (err.insertedDocs) inserted += err.insertedDocs.length;
      const writeErrors = err.writeErrors || [];
      const duplicateErrors = writeErrors.filter((writeError) =>
        (writeError.code ?? writeError.err?.code ?? writeError.error?.code) === 11000
      ).length;
      duplicates += duplicateErrors;
      const otherErrors = writeErrors.length - duplicateErrors;
      if (otherErrors > 0 || !writeErrors.length) {
        logger.error('database_insert_partial_failure', { category, otherErrors, error: err.message });
        err.partialInserted = inserted;
        err.duplicateCount = duplicates;
        throw err;
      }
    }
  }
  return { inserted, duplicates };
}

// ---------- Item removal ----------

async function handleRemove(interaction, guildDoc) {
  const categoryName = interaction.options.getString('category');
  const value = interaction.options.getString('value');

  if (!guildDoc.getCategory(categoryName)) {
    return interaction.reply({ content: `Category **${categoryName}** is not active.`, ephemeral: true });
  }

  const deleted = await Stock.findOneAndDelete({
    category: categoryName,
    value,
    claimed: false,
    archived: { $ne: true },
  });
  if (!deleted) {
    return interaction.reply({ content: `No unclaimed item matching that value in **${categoryName}**.`, ephemeral: true });
  }
  return interaction.reply({ content: `Removed one item from **${categoryName}**.`, ephemeral: true });
}

// ---------- Item editing ----------

async function handleEdit(interaction, guildDoc) {
  const categoryName = interaction.options.getString('category');
  const oldValue = interaction.options.getString('current_value');
  const newValue = interaction.options.getString('new_value');

  if (!guildDoc.getCategory(categoryName)) {
    return interaction.reply({ content: `Category **${categoryName}** is not active.`, ephemeral: true });
  }

  const doc = await Stock.findOne({
    category: categoryName,
    value: oldValue,
    claimed: false,
    archived: { $ne: true },
  });
  if (!doc) {
    return interaction.reply({ content: `No unclaimed item matching that value in **${categoryName}**.`, ephemeral: true });
  }

  doc.value = newValue;
  try {
    await doc.save();
  } catch (err) {
    if (err.code === 11000) {
      return interaction.reply({ content: `**${newValue}** already exists in **${categoryName}**.`, ephemeral: true });
    }
    logger.error('database_edit_failed', { error: err.message });
    return interaction.reply({ content: 'Edit failed — nothing was changed.', ephemeral: true });
  }

  return interaction.reply({ content: `Updated one item in **${categoryName}**.`, ephemeral: true });
}

// ---------- Stock overview ----------

async function buildStockView(guildDoc, panel = false) {
  const rows = await Stock.aggregate([
    { $match: {} },
    {
      $group: {
        _id: { category: '$category', archived: '$archived', claimed: '$claimed' },
        count: { $sum: 1 },
      },
    },
  ]);
  const legacyRows = await LegacyStock.aggregate([
    { $match: {} },
    {
      $group: {
        _id: { category: '$category', archived: '$archived', claimed: '$claimed' },
        count: { $sum: 1 },
      },
    },
  ]);

  const activeCategories = new Set(guildDoc.categories.map((category) => category.name));
  const byCategory = new Map();
  const deletedCategories = new Map();
  for (const row of [...rows, ...legacyRows]) {
    const { category, archived, claimed } = row._id;
    const isDeleted = archived || !activeCategories.has(category);
    const target = isDeleted ? deletedCategories : byCategory;
    const entry = target.get(category) || { available: 0, claimed: 0 };
    if (claimed) entry.claimed = row.count;
    else entry.available = row.count;
    target.set(category, entry);
  }

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(panel ? 'Database management panel' : 'Global stock levels')
    .setDescription('Stock is shared by every server.')
    .setTimestamp();
  if (panel) {
    embed.addFields({
      name: 'Manage inventory',
      value: 'Use the buttons below to add, edit, remove, bulk upload, or refresh stock.',
      inline: false,
    });
  }
  if (!byCategory.size && !deletedCategories.size && !guildDoc.categories.length) {
    embed.setDescription('No stock in any category yet. Use Add items or Bulk upload below.');
  } else {
    const fields = [];
    for (const cat of guildDoc.categories) {
      const stats = byCategory.get(cat.name) || { available: 0, claimed: 0 };
      fields.push({ name: `${cat.name} (${cat.dropType})`, stats });
    }
    for (const [category, stats] of deletedCategories) {
      fields.push({ name: category.endsWith('-deleted') ? category : `${category}-deleted`, stats });
    }
    for (const { name, stats } of fields.slice(0, panel ? 24 : 25)) {
      embed.addFields({
        name,
        value: `Available: **${stats.available}**\nClaimed: **${stats.claimed}**`,
        inline: true,
      });
    }
    const categoryLimit = panel ? 24 : 25;
    if (fields.length > categoryLimit) embed.setDescription(`Showing ${categoryLimit} of ${fields.length} categories.`);
  }

  return { embeds: [embed] };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('database')
    .setDescription('Open the stock panel, or bulk upload a text file.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option.setName('category').setDescription('Bulk upload target category').setAutocomplete(true))
    .addAttachmentOption((option) => option.setName('file').setDescription('.txt file, one item per line')),
  execute,
  handleComponent,
  handleModal,
  parseBulkLines,
  processBulkLines,
  insertStock,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = await GlobalCategory.find({ name: { $regex: `^${focused.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } })
      .sort({ name: 1 })
      .limit(25)
      .lean();
    return interaction.respond(choices.map((category) => ({ name: `${category.name} (${category.dropType})`, value: category.name })));
  },
};
