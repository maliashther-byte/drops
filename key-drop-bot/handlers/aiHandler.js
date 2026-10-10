'use strict';

const logger = require('../utils/logger');

let openaiClient = null;
function getClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openaiClient) {
    const OpenAI = require('openai');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

/**
 * Categorizes an array of raw lines from a bulk .txt upload into the
 * guild's existing category names. Returns a Map<categoryName, string[]>.
 * Falls back to the selected category when AI is unavailable — bulk
 * upload must always finish, never silently drop lines.
 */
async function categorizeLines(lines, categoryNames) {
  const client = getClient();
  if (!client) {
    return keywordCategorize(lines, categoryNames);
  }

  const BATCH_SIZE = 200; // keep prompts small enough to stay reliable
  const result = new Map(categoryNames.map((c) => [c, []]));
  const uncategorized = [];

  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const batch = lines.slice(i, i + BATCH_SIZE);
    try {
      const completion = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              `Categorize each input line into exactly one of these categories: ${categoryNames.join(', ')}. ` +
              'Respond ONLY with a JSON array, same length and order as the input, of category name strings. ' +
              'If a line does not clearly fit any category, use "uncategorized". No markdown, no explanation.',
          },
          { role: 'user', content: JSON.stringify(batch) },
        ],
        max_tokens: 4000,
        temperature: 0,
      });

      const raw = completion.choices?.[0]?.message?.content?.trim() || '[]';
      const cleaned = raw.replace(/^```json\s*|\s*```$/g, '');
      const labels = JSON.parse(cleaned);

      if (!Array.isArray(labels) || labels.length !== batch.length) {
        throw new Error('label count mismatch');
      }

      batch.forEach((line, idx) => {
        const label = labels[idx];
        if (result.has(label)) {
          result.get(label).push(line);
        } else {
          uncategorized.push(line);
        }
      });
    } catch (err) {
      logger.error('ai_categorize_batch_failed', { error: err.message, batchStart: i });
      // Fall back to keyword matching for just this failed batch so one
      // bad batch doesn't lose the whole upload.
      const fallback = keywordCategorize(batch, categoryNames);
      for (const [cat, vals] of fallback.entries()) {
        result.set(cat, [...(result.get(cat) || []), ...vals]);
      }
    }
  }

  if (uncategorized.length) {
    result.set('uncategorized', [...(result.get('uncategorized') || []), ...uncategorized]);
  }
  return result;
}

function keywordCategorize(lines, categoryNames) {
  const result = new Map(categoryNames.map((c) => [c, []]));
  result.set('uncategorized', []);

  for (const line of lines) {
    result.get('uncategorized').push(line);
  }
  return result;
}

module.exports = { categorizeLines };
