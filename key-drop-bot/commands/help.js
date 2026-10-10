'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const Guild = require('../schemas/Guild');
const User = require('../schemas/User');
const { TIER_NAMES, DEFAULT_SECURE_ITEMS_PER_CLICK } = require('../config/constants');
const { resolveTier, checkDropEligibility } = require('../utils/permissions');

const PAGE_COUNT = 3;

async function buildPage(index, interaction, guildDoc) {
  const prefix = process.env.PREFIX || '!';

  if (index === 0) {
    return new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('How Key Drop Bot works')
      .setDescription(
        `Run \`${prefix}drop\` in a drop channel to see categories, \`${prefix}drop random\` for a random ` +
          `category with stock, or \`${prefix}drop <category> [amount] [yes|no]\` for a specific drop. ` +
          'Amount is 1–25 (default 1); yes requires a CAPTCHA, no skips it, and omitting it follows the server setting. ' +
          'Your tier decides how many drops you get per day and how long you wait ' +
          'between them. Some drops show an image CAPTCHA — enter its code within the time ' +
          'limit to claim it. For a configured product, use its direct command such as `!premium`. ' +
          'Keys and links are sent to your DMs with a secure action.'
      )
      .setFooter({ text: `Page 1/${PAGE_COUNT}` });
  }

  if (index === 1) {
    const member = interaction.member;
    const tierName = resolveTier(guildDoc, member);
    const tierConfig = guildDoc.getTier(tierName);
    const userDoc = await User.getOrCreate(interaction.user.id, interaction.guildId);
    const elig = checkDropEligibility(userDoc, tierConfig);

    const cooldownLine = userDoc.lastDropAt
      ? `Last drop: <t:${Math.floor(userDoc.lastDropAt.getTime() / 1000)}:R>`
      : 'No drops claimed yet.';

    return new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Your status')
      .addFields(
        { name: 'Tier', value: tierConfig?.label || tierName, inline: true },
        { name: 'Drops left today', value: `${elig.remainingToday}/${tierConfig?.dailyLimit ?? 0}`, inline: true },
        { name: 'Cooldown', value: `${tierConfig?.cooldownMinutes ?? 0} min`, inline: true },
        { name: 'Total claimed', value: `${userDoc.totalDropsClaimed}`, inline: true },
        { name: 'Activity', value: cooldownLine, inline: false }
      )
      .setFooter({ text: `Page 2/${PAGE_COUNT}` });
  }

  const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Tiers & upgrade pricing').setFooter({ text: `Page 3/${PAGE_COUNT}` });
  for (const name of TIER_NAMES) {
    const t = guildDoc.getTier(name);
    if (!t) continue;
    const secureItemsPerClick = t.secureItemsPerClick ?? DEFAULT_SECURE_ITEMS_PER_CLICK[name];
    const products = guildDoc.dropProducts.filter((product) => t.categories.includes(product.category));
    const productSummary = products.length
      ? products.slice(0, 4).map((product) => `${product.name} ${product.quantities.get(name) ?? 1}/claim`).join(' · ') +
        (products.length > 4 ? ` · +${products.length - 4}` : '')
      : 'No product generators available';
    const captchaIntervals = [...new Set(guildDoc.dropChannels
      .map((channel) => channel.tierSettings.get(name)?.challengeEveryClaims ?? 3))].sort((a, b) => b - a);
    const captchaSummary = captchaIntervals.length
      ? `every ${captchaIntervals.join('/')}`
      : 'every 3';
    embed.addFields({
      name: t.label,
      value: `${t.description ? `${t.description}\n` : ''}${t.dailyLimit}/day • ${t.cooldownMinutes}m cooldown • ${products.length} product generators (${productSummary}) • captcha ${captchaSummary} product claims • ${t.price > 0 ? `$${t.price.toFixed(2)}` : 'Free'} • secure ${secureItemsPerClick === 0 ? 'auto' : `${secureItemsPerClick}/click`}${t.roleId ? ` • <@&${t.roleId}>` : ''}`,
      inline: false,
    });
  }
  embed.setDescription('Ask a server admin how to purchase an upgrade, or use `/shop` to open a private ticket. Pricing here is informational.');
  return embed;
}

function navRow(index) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`help:page:${index - 1}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId(`help:page:${index + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(index === PAGE_COUNT - 1)
  );
}

async function execute(interaction) {
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const embed = await buildPage(0, interaction, guildDoc);
  return interaction.reply({ embeds: [embed], components: [navRow(0)], ephemeral: true });
}

async function handleComponent(interaction) {
  const [, , pageStr] = interaction.customId.split(':');
  const index = Math.min(Math.max(Number(pageStr) || 0, 0), PAGE_COUNT - 1);
  const guildDoc = await Guild.getOrCreate(interaction.guildId);
  const embed = await buildPage(index, interaction, guildDoc);
  return interaction.update({ embeds: [embed], components: [navRow(index)] });
}

module.exports = {
  data: new SlashCommandBuilder().setName('help').setDescription('How drops work, your tier status, and upgrade pricing.'),
  execute,
  handleComponent,
};
