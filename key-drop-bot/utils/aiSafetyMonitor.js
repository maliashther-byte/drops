'use strict';

const Guild = require('../schemas/Guild');
const AiActivityMetric = require('../schemas/AiActivityMetric');
const AiSafetyAlert = require('../schemas/AiSafetyAlert');
const CreditTransaction = require('../schemas/CreditTransaction');
const logger = require('./logger');
const { generateJson, configuredModel } = require('./gemini');

const WINDOW_MS = 15 * 60 * 1000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

async function trackMessageActivity({ guildId, userId }) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
  try {
    await AiActivityMetric.updateOne(
      { guildId, userId, windowStart },
      { $inc: { messageCount: 1 } },
      { upsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    await AiActivityMetric.updateOne(
      { guildId, userId, windowStart },
      { $inc: { messageCount: 1 } }
    );
  }
}

async function analyzeGuild(guildId, now = new Date()) {
  if (!process.env.GEMINI_API_KEY) return { analyzed: 0, reason: 'gemini-disabled' };
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const [activity, transactions] = await Promise.all([
    AiActivityMetric.aggregate([
      { $match: { guildId, windowStart: { $gte: since } } },
      {
        $group: {
          _id: '$userId',
          totalMessages: { $sum: '$messageCount' },
          peakMessagesIn15Minutes: { $max: '$messageCount' },
          activeWindows: { $sum: 1 },
        },
      },
      { $match: { $or: [{ peakMessagesIn15Minutes: { $gte: 30 } }, { totalMessages: { $gte: 120 } }] } },
      { $sort: { peakMessagesIn15Minutes: -1, totalMessages: -1 } },
      { $limit: 40 },
    ]),
    CreditTransaction.aggregate([
      { $match: { guildId, createdAt: { $gte: since }, source: { $in: ['message', 'drop'] } } },
      {
        $group: {
          _id: '$userId',
          messageRewards: { $sum: { $cond: [{ $eq: ['$source', 'message'] }, 1, 0] } },
          productClaims: { $sum: { $cond: [{ $eq: ['$source', 'drop'] }, 1, 0] } },
        },
      },
    ]),
  ]);
  if (!activity.length) return { analyzed: 0, reason: 'no-candidates' };

  const transactionByUser = new Map(transactions.map((entry) => [entry._id, entry]));
  const userByCandidate = new Map();
  const candidates = activity.map((entry, index) => {
    const candidateId = `member-${index + 1}`;
    userByCandidate.set(candidateId, entry._id);
    const accountActivity = transactionByUser.get(entry._id);
    return {
      candidateId,
      totalMessagesIn24Hours: entry.totalMessages,
      peakMessagesIn15Minutes: entry.peakMessagesIn15Minutes,
      active15MinuteWindows: entry.activeWindows,
      messageRewardEventsIn24Hours: accountActivity?.messageRewards || 0,
      productClaimEventsIn24Hours: accountActivity?.productClaims || 0,
    };
  });
  const { value, model } = await generateJson({
    systemInstruction: [
      'Assess aggregate Discord bot activity for possible credit-reward or drop abuse. The supplied metrics contain no message text or real member identifiers.',
      'Do not assume high activity is malicious by itself. Only flag a clearly anomalous relationship between message volume, reward frequency, and product claims. Never recommend punishment or enforcement.',
      'Return JSON only: {"assessments":[{"candidateId":"member-1","severity":"low|medium|high","confidence":0.0,"reason":"brief evidence-based explanation"}]}. Include every supplied candidate once. Use low when evidence is insufficient.',
    ].join('\n'),
    contents: [{ role: 'user', text: JSON.stringify({ candidates }) }],
    temperature: 0,
  });
  if (!Array.isArray(value?.assessments)) throw new Error('Gemini returned an invalid safety assessment.');

  const windowKey = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS).toISOString();
  let alertsCreated = 0;
  for (const assessment of value.assessments) {
    const userId = userByCandidate.get(assessment.candidateId);
    const evidence = candidates.find((candidate) => candidate.candidateId === assessment.candidateId);
    if (!userId || !evidence || !['medium', 'high'].includes(assessment.severity) ||
      !Number.isFinite(assessment.confidence) || assessment.confidence < 0.75 ||
      typeof assessment.reason !== 'string' || !assessment.reason.trim()) continue;
    try {
      await AiSafetyAlert.create({
        guildId,
        userId,
        windowKey,
        severity: assessment.severity,
        confidence: Math.min(1, Math.max(0, assessment.confidence)),
        summary: assessment.reason.trim().slice(0, 500),
        evidence: {
          peakMessagesIn15Minutes: evidence.peakMessagesIn15Minutes,
          activeWindows: evidence.active15MinuteWindows,
          messageRewards: evidence.messageRewardEventsIn24Hours,
          productClaims: evidence.productClaimEventsIn24Hours,
        },
        model,
      });
      alertsCreated += 1;
    } catch (error) {
      if (error.code === 11000) continue;
      throw error;
    }
  }
  return { analyzed: candidates.length, alertsCreated };
}

async function analyzeConfiguredGuilds() {
  if (!process.env.GEMINI_API_KEY) return;
  const guilds = await Guild.find({ 'creditSettings.aiSafetyEnabled': true })
    .select({ guildId: 1 })
    .lean();
  for (const { guildId } of guilds) {
    try {
      const result = await analyzeGuild(guildId);
      logger.info('ai_safety_analysis_completed', { guildId, ...result });
    } catch (error) {
      logger.error('ai_safety_analysis_failed', { guildId, error: error.message });
    }
  }
}

function startAiSafetyMonitor() {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('ai_safety_monitor_disabled', { reason: 'Set GEMINI_API_KEY to enable aggregate activity analysis.' });
    return;
  }
  const timer = setInterval(() => {
    analyzeConfiguredGuilds().catch((error) => {
      logger.error('ai_safety_sweep_failed', { error: error.message });
    });
  }, WINDOW_MS);
  timer.unref();
  analyzeConfiguredGuilds().catch((error) => {
    logger.error('ai_safety_sweep_failed', { error: error.message });
  });
}

module.exports = { WINDOW_MS, trackMessageActivity, analyzeGuild, analyzeConfiguredGuilds, startAiSafetyMonitor };
