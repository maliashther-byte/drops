'use strict';

const { EmbedBuilder } = require('discord.js');

function baseEmbed(guildDoc) {
  const style = guildDoc.embedStyle || {};
  const embed = new EmbedBuilder()
    .setColor(style.color || '#5865F2')
    .setFooter({ text: style.footer || 'Key Drop Bot' })
    .setTimestamp();
  if (style.thumbnailUrl) embed.setThumbnail(style.thumbnailUrl);
  if (style.imageUrl) embed.setImage(style.imageUrl);
  return embed;
}

function publicClaimEmbed(guildDoc, { user, category, dropType }) {
  const style = guildDoc.embedStyle || {};
  const verb = dropType === 'role' ? 'claimed a role from' : 'claimed an item from';
  return baseEmbed(guildDoc)
    .setTitle(style.title || 'Key Drop')
    .setDescription(`🎉 **${user}** just ${verb} **${category}**!`);
}

function lootBoxEmbed(guildDoc, { number, category, reward, owner = null }) {
  const claimed = Boolean(owner);
  const embed = new EmbedBuilder()
    .setColor(claimed ? '#ED4245' : '#57F287')
    .setTitle(`Loot Box #${number}`)
    .setDescription(
      `**Reward:** ${reward || category}\n\n` +
      (claimed
        ? `**Owned by ${owner}.**`
        : '**Click the 🎁 button below to claim this box!**\n\n*Only one person can claim this box — first come, first served!*')
    )
    .setFooter({ text: guildDoc.embedStyle?.footer || 'Key Drop Bot' });
  return embed;
}

function dmItemsEmbed(guildDoc, { category, items, autoSecure = false, startIndex = 0, productName = '', description = '', disclaimer = '' }) {
  const cooldownReward = items.every((item) => item.dropType === 'cooldown-refresh');
  const itemDescription = [
    description.trim(),
    /disney/i.test(`${category} ${productName}`)
      ? 'Disney items may not work. We do not guarantee that they will.'
      : disclaimer,
  ].filter(Boolean).join('\n');
  const embed = baseEmbed(guildDoc)
    .setTitle('Your secure drop')
    .setDescription(
      `**Category:** ${category}\n` +
      (itemDescription ? `**Description:** ${itemDescription}\n` : '') +
      (cooldownReward
        ? 'Press Activate within 7 days to refresh your cooldowns.'
        : autoSecure
        ? 'Your tier automatically removes these items from shared inventory.'
        : 'Use the button below when you are ready to permanently remove items from shared inventory.')
    );
  embed.addFields(items.map((item, index) => ({
    name: `${item.dropType === 'link' ? 'Link' : item.dropType === 'cooldown-refresh' ? 'Cooldown refresh' : 'Key'} ${startIndex + index + 1}`,
    value: item.dropType === 'cooldown-refresh'
      ? 'Activate the button below within 7 days to refresh your cooldowns.'
      : item.value,
    inline: false,
  })));
  if (items.some((item) => item.value.length > 1024) || embedCharacterCount(embed) > 6000) {
    throw new Error('The item values are too long to fit in one secure delivery message.');
  }
  return embed;
}

function embedCharacterCount(embed) {
  const data = embed.data;
  return (data.title?.length || 0) +
    (data.description?.length || 0) +
    (data.footer?.text?.length || 0) +
    (data.author?.name?.length || 0) +
    (data.fields || []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

function dmItemsEmbeds(guildDoc, { category, items, autoSecure = false, productName = '', description = '', disclaimer = '' }) {
  const embeds = [];
  let startIndex = 0;
  const cooldownReward = items.every((item) => item.dropType === 'cooldown-refresh');
  const instructions = cooldownReward
    ? 'Press Activate within 7 days to refresh your cooldowns.'
    : autoSecure
    ? 'Your tier automatically removes these items from shared inventory.'
    : 'Use the button below when you are ready to permanently remove items from shared inventory.';
  const itemDescription = [
    description.trim(),
    /disney/i.test(`${category} ${productName}`)
      ? 'Disney items may not work. We do not guarantee that they will.'
      : disclaimer,
  ].filter(Boolean).join('\n');
  const embedDescription = `**Category:** ${category}\n${itemDescription ? `**Description:** ${itemDescription}\n` : ''}${instructions}`;

  while (startIndex < items.length) {
    let endIndex = startIndex;
    let length = embedDescription.length + 'Your secure drop'.length + (guildDoc.embedStyle?.footer || 'Key Drop Bot').length;
    while (endIndex < items.length && endIndex - startIndex < 25) {
      const item = items[endIndex];
      const fieldName = `${item.dropType === 'link' ? 'Link' : item.dropType === 'cooldown-refresh' ? 'Cooldown refresh' : 'Key'} ${endIndex + 1}`;
      const fieldValue = item.dropType === 'cooldown-refresh'
        ? 'Activate the button below within 7 days to refresh your cooldowns.'
        : item.value;
      const itemLength = fieldName.length + fieldValue.length;
      if (endIndex > startIndex && length + itemLength > 5900) break;
      if (length + itemLength > 5900) {
        throw new Error(`Item ${endIndex + 1} is too long to fit in a secure delivery embed.`);
      }
      length += itemLength;
      endIndex += 1;
    }
    embeds.push(dmItemsEmbed(guildDoc, {
      category,
      items: items.slice(startIndex, endIndex),
      autoSecure,
      startIndex,
      productName,
      description,
      disclaimer,
    }));
    startIndex = endIndex;
  }
  return embeds;
}

function roleGrantedEmbed(guildDoc, { category, roleMention }) {
  return baseEmbed(guildDoc)
    .setTitle('Role granted')
    .setDescription(`You claimed **${category}** and were given ${roleMention}.`);
}

function errorEmbed(guildDoc, message) {
  return baseEmbed(guildDoc).setTitle('Unable to process drop').setColor('#ED4245').setDescription(message);
}

function outOfStockEmbed(guildDoc, category) {
  return errorEmbed(guildDoc, `**${category}** is currently out of stock. Try again later or pick another category.`);
}

function cooldownEmbed(guildDoc, remainingMs) {
  const seconds = Math.ceil(remainingMs / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const human = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  return errorEmbed(guildDoc, `You're on cooldown. Try again in **${human}**.`);
}

function dailyLimitEmbed(guildDoc, tierLabel) {
  return errorEmbed(guildDoc, `You've used all your drops for today on the **${tierLabel}** tier. Upgrade with \`/help\` to raise your limit, or come back tomorrow.`);
}

module.exports = {
  baseEmbed,
  publicClaimEmbed,
  lootBoxEmbed,
  dmItemsEmbed,
  dmItemsEmbeds,
  embedCharacterCount,
  roleGrantedEmbed,
  errorEmbed,
  outOfStockEmbed,
  cooldownEmbed,
  dailyLimitEmbed,
};
