'use strict';

const User = require('../schemas/User');
const CreditTransaction = require('../schemas/CreditTransaction');
const logger = require('./logger');

function startingBalance(guildDoc) {
  return Number(guildDoc.creditSettings?.startingBalance || 0);
}

async function ensureCreditUser(guildDoc, userId) {
  return User.getOrCreate(userId, guildDoc.guildId, startingBalance(guildDoc));
}

async function recordBalanceChange({ guildDoc, userId, amount, source, reason = '', actorId = null }) {
  try {
    return await CreditTransaction.create({
      guildId: guildDoc.guildId,
      userId,
      amount,
      source,
      reason,
      actorId,
    });
  } catch (error) {
    const rollback = await User.updateOne(
      { userId, guildId: guildDoc.guildId },
      { $inc: { credits: -amount } }
    );
    if (rollback.modifiedCount !== 1) {
      logger.error('credit_balance_rollback_failed', {
        guildId: guildDoc.guildId,
        userId,
        amount,
        source,
        error: error.message,
      });
    }
    throw error;
  }
}

async function grantCredits({ guildDoc, userId, amount, source, reason = '', actorId = null }) {
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Credit grants must be a positive safe whole number.');
  }
  await ensureCreditUser(guildDoc, userId);
  const user = await User.findOneAndUpdate(
    {
      userId,
      guildId: guildDoc.guildId,
      credits: { $lte: Number.MAX_SAFE_INTEGER - amount },
    },
    { $inc: { credits: amount } },
    { new: true }
  );
  if (!user) throw new Error('The member wallet could not accept that credit amount.');
  await recordBalanceChange({ guildDoc, userId, amount, source, reason, actorId });
  return user.credits;
}

async function spendCredits({ guildDoc, userId, amount, reason = '' }) {
  if (!Number.isInteger(amount) || amount < 1) throw new Error('Credit cost must be a positive whole number.');
  await ensureCreditUser(guildDoc, userId);
  const user = await User.findOneAndUpdate(
    { userId, guildId: guildDoc.guildId, credits: { $gte: amount } },
    { $inc: { credits: -amount } },
    { new: true }
  );
  if (!user) return null;
  await recordBalanceChange({
    guildDoc,
    userId,
    amount: -amount,
    source: 'drop',
    reason,
  });
  return user.credits;
}

async function claimDailyCredits({ guildDoc, userId, tierName }) {
  const settings = guildDoc.creditSettings;
  if (!settings.dailyEnabled) return { reason: 'disabled' };
  const amount = Number(settings.dailyAmounts?.get(tierName) ?? 0);
  if (!amount) return { reason: 'disabled' };

  const previous = await ensureCreditUser(guildDoc, userId);
  const now = new Date();
  const cooldownMs = settings.dailyCooldownHours * 60 * 60 * 1000;
  const updated = await User.findOneAndUpdate(
    {
      userId,
      guildId: guildDoc.guildId,
      $or: [
        { lastDailyCreditAt: null },
        { lastDailyCreditAt: { $lte: new Date(now.getTime() - cooldownMs) } },
      ],
    },
    { $inc: { credits: amount }, $set: { lastDailyCreditAt: now } },
    { new: true }
  );
  if (!updated) return { reason: 'cooldown', lastClaimAt: previous.lastDailyCreditAt };
  try {
    await CreditTransaction.create({
      guildId: guildDoc.guildId,
      userId,
      amount,
      source: 'daily',
      reason: 'Daily shop reward',
    });
  } catch (error) {
    try {
      await User.updateOne(
        { userId, guildId: guildDoc.guildId, lastDailyCreditAt: now },
        { $inc: { credits: -amount }, $set: { lastDailyCreditAt: previous.lastDailyCreditAt || null } }
      );
    } catch (rollbackError) {
      logger.error('daily_credit_rollback_failed', {
        guildId: guildDoc.guildId,
        userId,
        amount,
        error: rollbackError.message,
      });
    }
    throw error;
  }
  return { amount, balance: updated.credits, nextClaimAt: new Date(now.getTime() + cooldownMs) };
}

async function rewardMessageCredits({ guildDoc, userId }) {
  const settings = guildDoc.creditSettings;
  const amount = Number(settings.messageCredits);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const previous = await ensureCreditUser(guildDoc, userId);
  const previousDay = previous.messageCreditDay;
  const previousAmount = previous.messageCreditsEarned || 0;
  const previousAt = previous.lastMessageCreditAt || null;
  const cooldownCutoff = new Date(now.getTime() - settings.messageCooldownMinutes * 60_000);
  if (previousDay === today && previousAmount + amount > settings.messageDailyCap) return null;

  const updated = await User.findOneAndUpdate(
    {
      userId,
      guildId: guildDoc.guildId,
      $and: [
        {
          $or: [
            { lastMessageCreditAt: null },
            { lastMessageCreditAt: { $lte: cooldownCutoff } },
          ],
        },
        {
          $or: [
            { messageCreditDay: { $ne: today } },
            { messageCreditsEarned: { $lte: settings.messageDailyCap - amount } },
          ],
        },
      ],
    },
    [{
      $set: {
        credits: { $add: [{ $ifNull: ['$credits', 0] }, amount] },
        lastMessageCreditAt: now,
        messageCreditDay: today,
        messageCreditsEarned: {
          $cond: [
            { $eq: ['$messageCreditDay', today] },
            { $add: [{ $ifNull: ['$messageCreditsEarned', 0] }, amount] },
            amount,
          ],
        },
      },
    }],
    { new: true }
  );
  if (!updated) return null;

  try {
    await CreditTransaction.create({
      guildId: guildDoc.guildId,
      userId,
      amount,
      source: 'message',
      reason: 'Configured message activity reward',
    });
  } catch (error) {
    try {
      await User.updateOne(
        { userId, guildId: guildDoc.guildId, lastMessageCreditAt: now },
        {
          $inc: { credits: -amount },
          $set: {
            lastMessageCreditAt: previousAt,
            messageCreditDay: previousDay,
            messageCreditsEarned: previousAmount,
          },
        }
      );
    } catch (rollbackError) {
      logger.error('message_credit_rollback_failed', {
        guildId: guildDoc.guildId,
        userId,
        amount,
        error: rollbackError.message,
      });
    }
    throw error;
  }
  return { amount, balance: updated.credits };
}

module.exports = {
  startingBalance,
  ensureCreditUser,
  grantCredits,
  spendCredits,
  claimDailyCredits,
  rewardMessageCredits,
};
