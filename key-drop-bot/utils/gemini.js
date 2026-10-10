'use strict';

const DEFAULT_MODEL = 'gemini-2.5-flash';

function configuredModel() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

function redactCredentials(text) {
  return String(text)
    .replace(/\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[credential redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{25,}\b/g, '[credential redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[credential redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[credential redacted]')
    .replace(/\b[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{6,}\.[A-Za-z\d_-]{20,}\b/g, '[credential redacted]');
}

async function generateJson({ systemInstruction, contents, temperature = 0.2 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('Gemini is not configured. Set GEMINI_API_KEY on the bot server.');
    error.status = 503;
    throw error;
  }
  const model = configuredModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: redactCredentials(systemInstruction) }] },
          contents: contents.map((entry) => ({
            role: entry.role === 'model' ? 'model' : 'user',
            parts: [{ text: redactCredentials(entry.text) }],
          })),
          generationConfig: {
            responseMimeType: 'application/json',
            temperature,
          },
        }),
      }
    );
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Gemini timed out. Please retry in a moment.');
    throw new Error(`Gemini request failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Gemini returned HTTP ${response.status}. Check the configured API key and model.`);
  }
  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned no usable response.');
  try {
    return { value: JSON.parse(text), model };
  } catch {
    throw new Error('Gemini returned an invalid JSON response; no settings were changed.');
  }
}

module.exports = { DEFAULT_MODEL, configuredModel, redactCredentials, generateJson };
