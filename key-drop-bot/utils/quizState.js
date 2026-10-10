'use strict';

// Active quizzes keyed by the message ID that holds the quiz buttons.
// Transient by design — if the bot restarts mid-quiz, the quiz message's
// buttons will just fail to resolve; the user can run !drop again.

const pending = new Map();

function create(messageId, quizData) {
  pending.set(messageId, { ...quizData, createdAt: Date.now() });
}

function get(messageId) {
  return pending.get(messageId) || null;
}

function remove(messageId) {
  pending.delete(messageId);
}

function findByBoxMessageId(messageId) {
  return [...pending.entries()].filter(([, quiz]) => quiz.boxMessageId === messageId);
}

module.exports = { create, get, remove, findByBoxMessageId };
