'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const configuredLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, event, meta = {}) {
  if (LEVELS[level] > configuredLevel) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  };
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out(JSON.stringify(line));
}

module.exports = {
  error: (event, meta) => emit('error', event, meta),
  warn: (event, meta) => emit('warn', event, meta),
  info: (event, meta) => emit('info', event, meta),
  debug: (event, meta) => emit('debug', event, meta),
};
