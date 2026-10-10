'use strict';

const TIERS = ['free', 'bronze', 'silver', 'gold', 'diamond'];
const COPY_SECTIONS = [
  ['dropSetup', 'Channels and generators'],
  ['tiers', 'Tier roles and limits'],
  ['appearance', 'Embed appearance'],
  ['safety', 'CAPTCHA and AI options'],
  ['credits', 'Credit rules and generator costs'],
];

const $ = (selector) => document.querySelector(selector);
let csrfToken = '';
let guilds = [];
let config = null;
let operations = { categories: [], archivedCategories: [], events: [] };
let inventoryPage = { items: [], offset: 0, limit: 50, total: 0 };
let creditStats = null;
let selectedInventoryCategory = '';
let activeTab = 'overview';
let aiConversations = [];
let aiHistory = [];
let selectedAiConversationId = '';
let aiSafetyAlerts = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

async function api(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The dashboard request timed out. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 401) {
    showSignIn();
    throw new Error('Your Discord session ended. Sign in again.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The request failed.');
  return body;
}

function showSignIn() {
  $('#signin').hidden = false;
  $('#dashboard').hidden = true;
  $('#account').hidden = true;
}

async function start() {
  try {
    const session = await api('/api/session');
    csrfToken = session.csrfToken;
    $('#username').textContent = session.user.username;
    $('#account').hidden = false;
    guilds = await api('/api/guilds');
    if (!guilds.length) {
      $('#dashboard').hidden = false;
      $('#panel').innerHTML = '<h2>No manageable servers found</h2><p class="hint">The bot must be in a server where your Discord account has Administrator permission.</p>';
      return;
    }
    $('#dashboard').hidden = false;
    $('#guild-select').innerHTML = guilds.map((guild, index) =>
      `<option value="${escapeHtml(guild.id)}" ${index === 0 ? 'selected' : ''}>${escapeHtml(guild.name)}${guild.configured ? ` — saved setup (${guild.channels} channels, ${guild.generators} generators)` : ' — no saved setup yet'}</option>`
    ).join('');
    await loadGuild();
  } catch (error) {
    if (error.message.includes('Sign in')) showSignIn();
    else {
      $('#dashboard').hidden = false;
      $('#panel').innerHTML = `<section class="error-card"><h2>Dashboard could not load</h2><p>${escapeHtml(error.message)}</p><button class="button" id="retry-load" type="button">Try again</button></section>`;
      setStatus(error.message, true);
    }
  }
}

async function loadGuild() {
  setStatus('Loading…');
  const guildId = encodeURIComponent($('#guild-select').value);
  try {
    const [nextConfig, nextOperations] = await Promise.all([
      api(`/api/guilds/${guildId}`),
      api(`/api/guilds/${guildId}/operations`),
    ]);
    if (!nextConfig || typeof nextConfig !== 'object' || !Array.isArray(nextConfig.channels)) {
      throw new Error('The server settings response was empty or invalid. Reload the dashboard and try again.');
    }
    config = nextConfig;
    operations = nextOperations;
    creditStats = null;
    inventoryPage = { items: [], offset: 0, limit: 50, total: 0 };
    selectedInventoryCategory = operations.categories.some((category) => category.name === selectedInventoryCategory)
      ? selectedInventoryCategory
      : (operations.archivedCategories || []).some((category) => category.name === selectedInventoryCategory)
        ? selectedInventoryCategory
      : (operations.categories[0]?.name || '');
    setStatus('');
    renderPanel();
  } catch (error) {
    $('#panel').innerHTML = `<section class="error-card"><h2>Server settings could not load</h2><p>${escapeHtml(error.message || 'Unexpected dashboard error.')}</p><button class="button" id="retry-load" type="button">Try again</button></section>`;
    setStatus(error.message || 'Server settings could not load.', true);
    throw error;
  }
}

function setStatus(message, isError = false) {
  $('#status').textContent = message || '';
  $('#status').classList.toggle('danger-text', isError);
}

async function loadCreditStats(userId = '') {
  const guildId = encodeURIComponent($('#guild-select').value);
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  creditStats = await api(`/api/guilds/${guildId}/credit-stats${query}`);
  const target = $('#credit-stats');
  if (!target) return;
  const summary = creditStats.summary;
  const aiStatus = creditStats.aiSafetyEnabled
    ? 'Gemini monitoring is enabled. Activity is aggregated; no message content is saved or sent to Gemini.'
    : 'AI monitoring is disabled. Enable it below and configure GEMINI_API_KEY on the bot host.';
  const wallet = creditStats.wallet
    ? `<div class="section"><strong>Member wallet:</strong> ${escapeHtml(creditStats.wallet.credits)} credits
      <p class="hint">Member ID ${escapeHtml(creditStats.wallet.userId)} · initialized ${new Date(creditStats.wallet.createdAt).toLocaleString()}</p></div>`
    : creditStats.userId
      ? '<div class="empty">No wallet exists for that member in this server.</div>'
      : '';
  const transactions = creditStats.transactions.length
    ? `<div class="inventory-list">${creditStats.transactions.map((entry) => `
      <div class="inventory-row"><span>${new Date(entry.createdAt).toLocaleString()}</span>
        <span>${escapeHtml(entry.source)}</span><strong class="${entry.amount < 0 ? 'danger-text' : ''}">${entry.amount > 0 ? '+' : ''}${escapeHtml(entry.amount)}</strong>
        <code>${escapeHtml(entry.userId)}</code><span>${escapeHtml(entry.reason || '')}</span></div>`).join('')}</div>`
    : '<div class="empty">No credit transactions recorded yet.</div>';
  target.innerHTML = `<p class="hint">${escapeHtml(aiStatus)}</p><div class="overview-grid">
      <article class="section stat-card"><p class="eyebrow">Wallets initialized</p><strong>${escapeHtml(summary.walletCount)}</strong></article>
      <article class="section stat-card"><p class="eyebrow">Credits in circulation</p><strong>${escapeHtml(summary.totalCredits)}</strong></article>
      <article class="section stat-card"><p class="eyebrow">Transactions</p><strong>${escapeHtml(summary.transactionCount)}</strong></article>
    </div>${wallet}<h4>Recent transactions</h4>${transactions}`;
}

async function loadAiSafetyAlerts() {
  const guildId = encodeURIComponent($('#guild-select').value);
  const result = await api(`/api/guilds/${guildId}/ai/safety-alerts`);
  aiSafetyAlerts = result.alerts;
  const status = $('#credit-ai-status');
  if (status) {
    status.textContent = result.enabled
      ? 'Gemini monitoring is enabled. Only aggregate activity counts are analyzed; message content is never stored or sent.'
      : 'Monitoring is disabled until GEMINI_API_KEY is set and message rewards are enabled.';
  }
  for (const selector of ['#credit-ai-alerts', '#ai-builder-alerts']) {
    const target = $(selector);
    if (target) target.innerHTML = renderAiSafetyAlerts();
  }
}

async function loadAiBuilder() {
  const guildId = encodeURIComponent($('#guild-select').value);
  const [conversations, history] = await Promise.all([
    api(`/api/guilds/${guildId}/ai/conversations`),
    api(`/api/guilds/${guildId}/ai/history`),
  ]);
  aiConversations = conversations;
  aiHistory = history;
  if (!aiConversations.some((conversation) => conversation.id === selectedAiConversationId)) {
    selectedAiConversationId = aiConversations.find((conversation) => conversation.status === 'active')?.id || '';
  }
  await loadAiSafetyAlerts();
  renderPanel();
}

async function createAiConversation() {
  const guildId = encodeURIComponent($('#guild-select').value);
  const conversation = await api(`/api/guilds/${guildId}/ai/conversations`, {
    method: 'POST',
    body: JSON.stringify({ title: 'New AI setup conversation' }),
  });
  aiConversations.unshift(conversation);
  selectedAiConversationId = conversation.id;
  renderPanel();
  $('#ai-message').focus();
}

async function sendAiMessage() {
  const text = $('#ai-message').value.trim();
  if (!text) throw new Error('Describe what you want to configure first.');
  const guildId = encodeURIComponent($('#guild-select').value);
  const conversation = await api(
    `/api/guilds/${guildId}/ai/conversations/${encodeURIComponent(selectedAiConversationId)}/messages`,
    { method: 'POST', body: JSON.stringify({ text }) }
  );
  aiConversations = aiConversations.map((entry) => entry.id === conversation.id ? conversation : entry);
  setStatus(conversation.pendingChanges ? 'Gemini prepared a reviewed proposal; it has not been deployed.' : 'Gemini replied. Continue answering its questions.');
  renderPanel();
}

async function confirmAiDeployment() {
  if (!window.confirm('Deploy the AI-reviewed settings shown in this conversation?')) return;
  const guildId = encodeURIComponent($('#guild-select').value);
  const result = await api(
    `/api/guilds/${guildId}/ai/conversations/${encodeURIComponent(selectedAiConversationId)}/confirm`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  aiConversations = aiConversations.map((entry) => entry.id === result.conversation.id ? result.conversation : entry);
  await loadGuild();
  await loadAiBuilder();
  setStatus('AI proposal deployed. You can undo it from AI deployment history.');
}

async function discardAiProposal() {
  if (!window.confirm('Discard this proposal without changing the server?')) return;
  const guildId = encodeURIComponent($('#guild-select').value);
  const conversation = await api(
    `/api/guilds/${guildId}/ai/conversations/${encodeURIComponent(selectedAiConversationId)}/discard`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  aiConversations = aiConversations.map((entry) => entry.id === conversation.id ? conversation : entry);
  renderPanel();
  setStatus('AI proposal discarded. No settings were changed.');
}

async function undoAiDeployment(button) {
  if (!window.confirm('Restore the settings from before this AI deployment? This is available only if later changes do not conflict.')) return;
  const guildId = encodeURIComponent($('#guild-select').value);
  await api(`/api/guilds/${guildId}/ai/history/${encodeURIComponent(button.dataset.undoAi)}/undo`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await loadGuild();
  await loadAiBuilder();
  setStatus('AI deployment undone.');
}

async function dismissAiAlert(button) {
  const guildId = encodeURIComponent($('#guild-select').value);
  await api(`/api/guilds/${guildId}/ai/safety-alerts/${encodeURIComponent(button.dataset.dismissAlert)}/dismiss`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await loadAiSafetyAlerts();
}

async function grantMemberCredits() {
  const guildId = encodeURIComponent($('#guild-select').value);
  const result = await api(`/api/guilds/${guildId}/credits/grant`, {
    method: 'POST',
    body: JSON.stringify({
      userId: $('#credit-grant-user').value.trim(),
      amount: Number($('#credit-grant-amount').value),
      reason: $('#credit-grant-reason').value.trim(),
    }),
  });
  setStatus(`Granted ${result.amount} credits. Member wallet balance: ${result.balance}.`);
  await loadCreditStats(result.userId);
}

function channelOptions(selected = '') {
  return config.availableChannels.map((channel) =>
    `<option value="${escapeHtml(channel.id)}" ${channel.id === selected ? 'selected' : ''}>#${escapeHtml(channel.name)}</option>`
  ).join('');
}

function configuredChannelOptions(selected = '') {
  return config.channels.map((channel) => {
    const available = config.availableChannels.find((item) => item.id === channel.channelId);
    return `<option value="${escapeHtml(channel.channelId)}" ${channel.channelId === selected ? 'selected' : ''}>#${escapeHtml(available?.name || channel.name || channel.channelId)}</option>`;
  }).join('');
}

function roleOptions(selected = '') {
  return `<option value="">No role</option>${config.availableRoles.map((role) =>
    `<option value="${escapeHtml(role.id)}" ${role.id === selected ? 'selected' : ''}>${escapeHtml(role.name)}</option>`
  ).join('')}`;
}

function categoryOptions(selected = '') {
  return config.categories.map((category) =>
    `<option value="${escapeHtml(category.name)}" ${category.name === selected ? 'selected' : ''}>${escapeHtml(category.name)}</option>`
  ).join('');
}

function field(label, value, attributes = '') {
  return `<label class="field">${escapeHtml(label)}<input value="${escapeHtml(value)}" ${attributes}></label>`;
}

function renderPanel() {
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === activeTab));
  const saveLabels = {
    channels: 'Save channels',
    products: 'Save generators',
    tiers: 'Save tiers',
    appearance: 'Save appearance',
    options: 'Save options',
    credits: 'Save credit settings',
  };
  $('#save').hidden = !saveLabels[activeTab];
  if (saveLabels[activeTab]) $('#save').textContent = saveLabels[activeTab];
  if (!config) {
    $('#panel').innerHTML = '<section class="section"><h2>Loading server settings</h2><p class="hint">Your configuration is still being retrieved. This section will appear when it is ready.</p></section>';
    return;
  }
  const renderers = {
    overview: renderOverview,
    channels: renderChannels,
    products: renderProducts,
    tiers: renderTiers,
    categories: renderCategories,
    inventory: renderInventory,
    events: renderEvents,
    shop: renderShop,
    credits: renderCredits,
    'ai-builder': renderAiBuilder,
    'member-tools': renderMemberTools,
    appearance: renderAppearance,
    options: renderOptions,
    copy: renderCopy,
  };
  try {
    $('#panel').innerHTML = renderers[activeTab]();
  } catch (error) {
    console.error('Dashboard tab render failed', { tab: activeTab, error });
    $('#panel').innerHTML = `<section class="error-card"><h2>This section could not load</h2><p>${escapeHtml(error.message || 'Unexpected dashboard error.')}</p><button class="button" id="retry-load" type="button">Reload settings</button></section>`;
    setStatus('Section failed to load.', true);
  }
}

function renderOverview() {
  const available = operations.categories.reduce((sum, category) => sum + category.available, 0);
  const claimed = operations.categories.reduce((sum, category) => sum + category.claimed, 0);
  const cards = [
    ['Drop channels', config.channels.length, 'Members can run commands only in these channels.'],
    ['Generators', config.products.length, 'Each product command is assigned to one channel.'],
    ['Available stock', available.toLocaleString(), 'Shared inventory available to every server using this bot.'],
    ['Scheduled events', operations.events.length, 'Timed category announcements currently active.'],
  ];
  return `<h2>Server overview</h2>
    <p class="hint">Your bot configuration at a glance. Shared categories and inventory affect every server using this bot.</p>
    <div class="overview-grid">${cards.map(([title, value, hint]) => `
      <article class="section stat-card"><p class="eyebrow">${escapeHtml(title)}</p><strong>${escapeHtml(value)}</strong><p class="hint">${escapeHtml(hint)}</p></article>`).join('')}</div>
    <div class="section"><h3>Setup checklist</h3>
      <p>${config.channels.length ? '✅' : '⬜'} Configure at least one drop channel</p>
      <p>${config.products.length ? '✅' : '⬜'} Connect a generator to a shared category</p>
      <p>${available ? '✅' : '⬜'} Add available stock${claimed ? ` · ${claimed.toLocaleString()} already claimed` : ''}</p>
      <p>${TIERS.every((tier) => config.tiers[tier]?.roleId) ? '✅' : '⬜'} Assign optional tier roles</p>
    </div>
    <p class="hint">Choose a section on the left to manage settings, inventory, events, and your public tier shop.</p>`;
}

function renderChannels() {
  const channels = config.channels.length
    ? config.channels.map((channel) => `
      <div class="row channel-row">
        <label class="field">Drop channel<select data-channel-id>${channelOptions(channel.channelId)}</select></label>
        <label class="field">Command prefix<input data-prefix value="${escapeHtml(channel.prefix)}" maxlength="33"></label>
        <button class="button danger" data-remove-channel type="button">Remove</button>
        <div class="channel-details"><details><summary>Button caps, cooldowns, and CAPTCHA by tier</summary>
          <div class="field-grid">${TIERS.map((tier) => `
            ${field(tier[0].toUpperCase() + tier.slice(1) + ' — CAPTCHA every N claims',
              channel.tierSettings?.[tier]?.challengeEveryClaims ?? 3,
              `data-challenge="${tier}" type="number" min="1" max="20"`)}
            ${field(tier[0].toUpperCase() + tier.slice(1) + ' — button claims per day',
              channel.tierSettings?.[tier]?.buttonDailyLimit ?? 4,
              `data-button-daily="${tier}" type="number" min="1" max="1000"`)}
            ${field(tier[0].toUpperCase() + tier.slice(1) + ' — button cooldown (minutes)',
              channel.tierSettings?.[tier]?.buttonCooldownMinutes ?? 0,
              `data-button-cooldown="${tier}" type="number" min="0" max="10080"`)}
          `).join('')}</div>
        </details></div>
      </div>`).join('')
    : '<div class="empty">No drop channels yet. Add the places where members should be able to run drop commands.</div>';
  return `<h2>Drop channels</h2>
    <p class="hint">Commands only work inside a configured channel. A generator command such as <code>!discord</code> must be assigned as that channel’s prefix.</p>
    <div id="channels-list">${channels}</div>
    <button class="button" id="add-channel" type="button">Add drop channel</button>
    <h3>Log channel</h3>
    <label class="field">Optional admin log channel<select id="log-channel"><option value="">Not set</option>${channelOptions(config.logChannelId)}</select></label>`;
}

function renderProducts() {
  const products = config.products.length
    ? config.products.map((product, index) => {
      const assigned = config.channels.find((channel) => channel.prefix.toLowerCase() === `!${product.commandName}`)?.channelId || '';
      return `<article class="section product-card" data-product-index="${index}">
        <div class="section-title"><h3>Generator ${index + 1}</h3><button class="button danger" data-remove-product type="button">Remove</button></div>
        <div class="field-grid">
          ${field('Display name', product.name, 'data-product="name" maxlength="80"')}
          ${field('Member command (without !)', product.commandName, 'data-product="commandName" maxlength="32"')}
          <label class="field">Shared category<select data-product="category">${categoryOptions(product.category)}</select></label>
          <label class="field">Assigned drop channel<select data-product="channelId"><option value="">Choose channel</option>${configuredChannelOptions(assigned)}</select></label>
          <label class="field product-description">DM description<textarea data-product="description" maxlength="850" placeholder="Optional description shown with claimed items">${escapeHtml(product.description || '')}</textarea></label>
          <label class="field">Embed color<input data-product="embedColor" type="color" value="${escapeHtml(product.embedColor || '#5865F2')}"></label>
          ${field('Daily cap (blank = tier default, 0 = unlimited)', product.dailyLimit ?? '', 'data-product="dailyLimit" type="number" min="0" max="1000"')}
          ${field('Cooldown minutes (blank = tier default)', product.cooldownMinutes ?? '', 'data-product="cooldownMinutes" type="number" min="0" max="10080"')}
          ${field('Credit cost per claim (0 = free)', product.creditCost ?? 0, 'data-product="creditCost" type="number" min="0" max="1000000"')}
        </div>
        <h3>Items per claim by tier</h3>
        <div class="field-grid">${TIERS.map((tier) => field(
          tier[0].toUpperCase() + tier.slice(1),
          product.quantities?.[tier] ?? 1,
          `data-quantity="${tier}" type="number" min="0" max="500"`
        )).join('')}</div>
        <h3>Tier-specific cooldown override (minutes, optional)</h3>
        <div class="field-grid">${TIERS.map((tier) => field(
          tier[0].toUpperCase() + tier.slice(1),
          product.cooldowns?.[tier] ?? '',
          `data-cooldown="${tier}" type="number" min="0" max="10080"`
        )).join('')}</div>
        <h3>Published claim embed</h3>
        <p class="hint">${product.buttonPublished ? `Currently published in #${escapeHtml(config.availableChannels.find((channel) => channel.id === product.buttonChannelId)?.name || product.buttonChannelId)}. Re-publishing replaces the old embed.` : 'Design and publish a button embed. Claims use the generator’s quantities, cooldowns, caps, and CAPTCHA settings.'}</p>
        <div class="field-grid">
          ${field('Embed title', product.buttonTitle || product.name, 'data-product="buttonTitle" maxlength="256"')}
          <label class="field">Publish channel<select data-product="buttonChannelId"><option value="">Choose configured drop channel</option>${configuredChannelOptions(product.buttonChannelId || '')}</select></label>
          ${field('Button label', product.buttonLabel || 'Claim', 'data-product="buttonLabel" maxlength="80"')}
          ${field('Image URL (HTTPS)', product.buttonImageUrl || '', 'data-product="buttonImageUrl" type="url" maxlength="1000"')}
        </div>
        <label class="field">Embed details<textarea data-product="buttonDescription" maxlength="4000" placeholder="Explain what this button gives members">${escapeHtml(product.buttonDescription || '')}</textarea></label>
        <button class="button primary" data-publish-button type="button">Publish / update claim embed</button>
      </article>`;
    }).join('')
    : '<div class="empty">No generators yet. Add one to connect a command to a shared category.</div>';
  return `<h2>Item generators</h2>
    <p class="hint">Assign each generator a channel. Members can only claim it in that channel. Categories and inventory are shared across servers.</p>
    <div id="products-list">${products}</div>
    <button class="button" id="add-product" type="button" ${config.products.length >= 10 ? 'disabled' : ''}>Add generator</button>`;
}

function renderCategories() {
  const categories = operations.categories.map((category) => `
    <article class="section category-card" data-original-name="${escapeHtml(category.name)}">
      <div class="field-grid">
        ${field('Category name', category.name, 'data-category="name" maxlength="30"')}
        <label class="field">Type<select data-category="dropType">
          ${[['key', 'Keys'], ['link', 'Links'], ['cooldown-refresh', 'Cooldown refresh']].map(([value, label]) =>
            `<option value="${value}" ${category.dropType === value ? 'selected' : ''}>${label}</option>`
          ).join('')}
        </select></label>
      </div>
      <label class="field">Description<textarea data-category="description" maxlength="850">${escapeHtml(category.description || '')}</textarea></label>
      <p class="hint">${category.available.toLocaleString()} available · ${category.claimed.toLocaleString()} claimed · Shared across all bot servers</p>
      <div class="copy-actions"><button class="button" data-save-category type="button">Save category</button><button class="button danger" data-delete-category type="button">Remove category</button></div>
    </article>`).join('');
  return `<h2>Shared categories</h2>
    <p class="hint danger-text">Categories are shared globally across every server running this bot. Removing a category archives its stock and removes generators that use it.</p>
    <div id="category-list">${categories || '<div class="empty">No categories yet. Create one before adding generators or stock.</div>'}</div>
    <section class="section"><h3>Create category</h3>
      <div class="field-grid">${field('Name (letters, numbers, hyphens)', '', 'id="new-category-name" maxlength="30" placeholder="example-category"')}
        <label class="field">Type<select id="new-category-type"><option value="key">Keys</option><option value="link">Links</option><option value="cooldown-refresh">Cooldown refresh</option></select></label>
      </div>
      <label class="field">Description<textarea id="new-category-description" maxlength="850"></textarea></label>
      <button class="button primary" id="create-category" type="button">Create shared category</button>
    </section>`;
}

function renderInventory() {
  const categorySelect = `<option value="">Choose category</option>${operations.categories.map((category) =>
    `<option value="${escapeHtml(category.name)}" ${category.name === selectedInventoryCategory ? 'selected' : ''}>${escapeHtml(category.name)} (${category.available.toLocaleString()} available)</option>`
  ).join('')}${(operations.archivedCategories || []).length
    ? `<optgroup label="Archived (view only)">${operations.archivedCategories.map((category) =>
      `<option value="${escapeHtml(category.name)}" ${category.name === selectedInventoryCategory ? 'selected' : ''}>${escapeHtml(category.name)} — archived</option>`
    ).join('')}</optgroup>`
    : ''}`;
  const currentItems = inventoryPage.items.length ? inventoryPage.items.map((item) => `
    <div class="inventory-row">
      <code>${escapeHtml(item.value)}</code>
      <span class="${item.claimed ? 'danger-text' : ''}">${item.claimed ? `Claimed by ${escapeHtml(item.claimedBy || 'member')}` : 'Available'}</span>
      ${item.claimed || inventoryPage.archived ? '' : `<div class="inventory-actions"><button class="button" data-edit-stock="${escapeHtml(item.id)}" type="button">Edit</button><button class="button danger" data-delete-stock="${escapeHtml(item.id)}" type="button">Remove</button></div>`}
    </div>`).join('') : '<div class="empty">Select a category to inspect stock.</div>';
  const selected = selectedInventoryCategory;
  const isArchived = Boolean(inventoryPage.archived);
  const start = inventoryPage.total ? inventoryPage.offset + 1 : 0;
  const end = Math.min(inventoryPage.offset + inventoryPage.items.length, inventoryPage.total);
  return `<h2>Shared inventory</h2>
    <p class="hint danger-text">Inventory is shared globally across all bot servers. Claimed entries cannot be removed here. Never upload credentials or keys you do not control.</p>
    <label class="field">Category<select id="inventory-category">${categorySelect}</select></label>
    <section class="section"><h3>${isArchived ? 'Archived inventory' : 'Add stock'}</h3>
      ${isArchived ? '<p class="hint">Archived items cannot be claimed, edited, or removed from the dashboard.</p>' : `
      <p class="hint">Paste one key or link per line. Blank lines and duplicate values are ignored.</p>
      <label class="field">Items<textarea id="inventory-values" rows="7" placeholder="Paste one item per line"></textarea></label>
      <label class="check-row"><input id="inventory-ai" type="checkbox" ${config.aiCategorizationEnabled ? 'checked' : ''}> Categorize across existing categories with AI (up to 5,000 lines)</label>
      <button class="button primary" id="add-stock" type="button">Add items to shared inventory</button>`}
    </section>
    <section class="section"><div class="section-title"><h3>Items (${inventoryPage.total.toLocaleString()})</h3><button class="button" id="refresh-stock" type="button">Refresh</button></div>
      ${currentItems}
      <div class="copy-actions"><button class="button" id="stock-previous" type="button" ${inventoryPage.offset <= 0 ? 'disabled' : ''}>Previous</button><span class="hint">${start}–${end} of ${inventoryPage.total}</span><button class="button" id="stock-next" type="button" ${end >= inventoryPage.total ? 'disabled' : ''}>Next</button></div>
    </section>
    <span id="inventory-selected" hidden>${escapeHtml(selected)}</span>`;
}

function renderEvents() {
  const activeEvents = operations.events.length ? operations.events.map((event) => `
    <article class="section event-row" data-event-id="${escapeHtml(event.id)}">
      <div class="section-title"><h3>${escapeHtml(event.category)} drop event</h3><button class="button danger" data-end-event type="button">End event</button></div>
      <p class="hint">#${escapeHtml(event.channelName)} · ends ${new Date(event.expiresAt).toLocaleString()}</p>
    </article>`).join('') : '<div class="empty">No active timed events.</div>';
  return `<h2>Timed drop events</h2>
    <p class="hint">Post an announcement for a shared category. It will automatically be marked ended when its duration expires.</p>
    <section class="section"><h3>Start an event</h3><div class="field-grid">
      <label class="field">Category<select id="event-category">${categoryOptions()}</select></label>
      <label class="field">Configured drop channel<select id="event-channel">${configuredChannelOptions(config.channels[0]?.channelId)}</select></label>
      ${field('Duration in minutes (1–10080)', 60, 'id="event-duration" type="number" min="1" max="10080"')}
    </div>
    <label class="check-row"><input id="event-ping" type="checkbox"> Ping @here once</label>
    <button class="button primary" id="start-event" type="button">Post timed event</button></section>
    <h3>Active events</h3>${activeEvents}`;
}

function renderShop() {
  return `<h2>Tier shop</h2>
    <p class="hint">Publish tier prices, product details, and a product explanation button. Trial buttons can be configured for each tier; a member can claim one trial once per server.</p>
    <section class="section"><label class="field">Post shop in<select id="shop-channel">${channelOptions()}</select></label>
      <button class="button primary" id="publish-shop" type="button">Publish tier shop</button></section>
    <div class="section"><h3>Preview</h3>${TIERS.map((name) => {
      const tier = config.tiers[name] || {};
      return `<p><strong>${escapeHtml(tier.label || name)}</strong> · ${tier.price ? `$${Number(tier.price).toFixed(2)}` : 'Free'} · ${tier.dailyLimit ?? 0}/day · ${tier.cooldownMinutes ?? 0}m cooldown</p>`;
    }).join('')}</div>`;
}

function renderCredits() {
  const settings = config.creditSettings || {};
  const selectedTiers = settings.messageEligibleTiers || TIERS;
  return `<h2>Credits and activity</h2>
    <p class="hint">Wallets and earning rules are isolated to this server. Changing the starting balance only affects members who have not initialized a wallet yet.</p>
    <section class="section"><h3>Credit rules</h3>
      ${field('Starting balance for new wallets', settings.startingBalance ?? 0, 'data-credit="startingBalance" type="number" min="0" max="1000000"')}
      <label class="check-row"><input data-credit="dailyEnabled" type="checkbox" ${settings.dailyEnabled ? 'checked' : ''}> Enable daily rewards</label>
      <div class="field-grid">${TIERS.map((tier) => field(
        `${tier[0].toUpperCase() + tier.slice(1)} daily credits`,
        settings.dailyAmounts?.[tier] ?? 50,
        `data-daily-amount="${tier}" type="number" min="0" max="1000000"`
      )).join('')}
        ${field('Daily cooldown (hours)', settings.dailyCooldownHours ?? 24, 'data-credit="dailyCooldownHours" type="number" min="1" max="720"')}
      </div>
      <label class="check-row"><input data-credit="messageEnabled" type="checkbox" ${settings.messageEnabled ? 'checked' : ''}> Enable message rewards</label>
      <div class="field-grid">
        ${field('Credits per qualifying message', settings.messageCredits ?? 1, 'data-credit="messageCredits" type="number" min="1" max="100000"')}
        ${field('Message reward cooldown (minutes)', settings.messageCooldownMinutes ?? 60, 'data-credit="messageCooldownMinutes" type="number" min="1" max="10080"')}
        ${field('Message reward daily cap', settings.messageDailyCap ?? 10, 'data-credit="messageDailyCap" type="number" min="1" max="1000000"')}
      </div>
      <label class="field">Message reward and AI monitoring channels<select data-credit="messageChannelIds" multiple size="5">${config.availableChannels.map((channel) =>
        `<option value="${escapeHtml(channel.id)}" ${(settings.messageChannelIds || []).includes(channel.id) ? 'selected' : ''}>#${escapeHtml(channel.name)}</option>`
      ).join('')}</select></label>
      <p class="hint">Message content is not saved. AI monitoring counts activity only in these selected channels. Commands and bot accounts do not earn message rewards.</p>
      <div class="field-grid">${TIERS.map((tier) =>
        `<label class="check-row"><input data-credit-tier="${tier}" type="checkbox" ${selectedTiers.includes(tier) ? 'checked' : ''}> ${tier[0].toUpperCase() + tier.slice(1)} message rewards</label>`
      ).join('')}</div>
      <label class="check-row"><input data-credit="aiSafetyEnabled" type="checkbox" ${settings.aiSafetyEnabled ? 'checked' : ''}> Enable Gemini suspicious-activity analysis (advisory only)</label>
      <p class="hint">Analysis uses anonymized aggregate counts, never message text or Discord member IDs. No member is automatically punished.</p>
      <label class="check-row"><input data-credit="invitesEnabled" type="checkbox" ${settings.invitesEnabled ? 'checked' : ''}> Enable verified invite rewards</label>
      <div class="field-grid">
        ${field('Credits per verified invite', settings.inviteCredits ?? 300, 'data-credit="inviteCredits" type="number" min="1" max="1000000"')}
        ${field('Invitee must stay (hours)', settings.inviteMemberAgeHours ?? 1, 'data-credit="inviteMemberAgeHours" type="number" min="1" max="720"')}
      </div>
      <p class="hint">Invite rewards require Manage Server permission for the bot. Members claim only after invitees have stayed for the configured period.</p>
    </section>
    <section class="section"><h3>Wallet and transaction stats</h3>
      <div class="copy-actions">
        <button class="button" id="load-credit-stats" type="button">Refresh stats</button>
        <label class="field">Member Discord user ID<input id="credit-member-id" inputmode="numeric" placeholder="Optional; enter an ID to inspect a wallet"></label>
        <button class="button" id="lookup-credit-member" type="button">Look up wallet</button>
      </div>
      <div id="credit-stats"><p class="hint">Loading credit statistics…</p></div>
    </section>
    <section class="section"><h3>Grant credits</h3>
      <div class="field-grid">
        ${field('Member Discord user ID', '', 'id="credit-grant-user" inputmode="numeric" placeholder="Discord user ID"')}
        ${field('Credits to grant', 1, 'id="credit-grant-amount" type="number" min="1" max="1000000"')}
      </div>
      <label class="field">Reason<input id="credit-grant-reason" maxlength="300" placeholder="Optional audit reason"></label>
      <button class="button primary" id="grant-credits" type="button">Grant credits</button>
      <p class="hint">Every grant is recorded with the administrator ID and reason.</p>
    </section>
    <section class="section"><div class="section-title"><h3>AI suspicious-activity alerts</h3><button class="button" id="refresh-ai-alerts" type="button">Refresh</button></div>
      <p id="credit-ai-status" class="hint">Loading monitoring status…</p><div id="credit-ai-alerts">${renderAiSafetyAlerts()}</div>
    </section>`;
}

function renderAiSafetyAlerts() {
  if (!aiSafetyAlerts.length) return '<div class="empty">No AI alerts have been recorded for this server.</div>';
  return aiSafetyAlerts.map((alert) => `
    <article class="section safety-alert">
      <div class="section-title"><h4 class="${alert.severity === 'high' ? 'danger-text' : ''}">${escapeHtml(alert.severity.toUpperCase())} · ${Math.round(alert.confidence * 100)}% confidence</h4>
        ${alert.status === 'open' ? `<button class="button" type="button" data-dismiss-alert="${escapeHtml(alert.id)}">Dismiss</button>` : '<span>Dismissed</span>'}</div>
      <p>${escapeHtml(alert.summary)}</p>
      <p class="hint">Member ${escapeHtml(alert.userId)} · ${new Date(alert.createdAt).toLocaleString()} · ${alert.evidence.peakMessagesIn15Minutes} messages in 15m · ${alert.evidence.activeWindows} active windows · ${alert.evidence.messageRewards} message rewards · ${alert.evidence.productClaims} product claims · ${escapeHtml(alert.model)}</p>
    </article>`).join('');
}

function renderAiBuilder() {
  const selected = aiConversations.find((conversation) => conversation.id === selectedAiConversationId);
  const conversations = aiConversations.length
    ? aiConversations.map((conversation) => `
      <button class="ai-conversation ${conversation.id === selectedAiConversationId ? 'active' : ''}" type="button" data-ai-conversation="${escapeHtml(conversation.id)}">
        <strong>${escapeHtml(conversation.title)}</strong><small>${escapeHtml(conversation.status)} · ${new Date(conversation.updatedAt).toLocaleString()}</small>
      </button>`).join('')
    : '<div class="empty">No AI conversations yet.</div>';
  const chat = selected
    ? `<div class="ai-messages">${selected.messages.map((message) => `
        <article class="ai-message ${message.role === 'user' ? 'user-message' : 'model-message'}"><strong>${message.role === 'user' ? 'You' : 'Key Drop AI'}</strong><p>${escapeHtml(message.text)}</p></article>`
      ).join('')}</div>
      ${selected.pendingChanges ? `<section class="section"><h3>AI-reviewed proposal · not yet deployed</h3>
        <p class="hint">${escapeHtml(selected.pendingSummary)}</p><pre class="ai-preview">${escapeHtml(JSON.stringify(selected.pendingChanges, null, 2))}</pre>
        <div class="copy-actions"><button class="button primary" id="confirm-ai-deploy" type="button">Confirm and deploy</button><button class="button danger" id="discard-ai-proposal" type="button">Discard proposal</button></div>
      </section>` : ''}
      ${selected.status === 'active' ? `<label class="field">Continue the conversation<textarea id="ai-message" maxlength="2000" placeholder="Describe what to add or change. The AI will ask follow-up questions before proposing settings."></textarea></label>
        <button class="button primary" id="send-ai-message" type="button">Send to Gemini</button>` : `<p class="hint">This conversation is ${escapeHtml(selected.status)}. Start a new conversation to make more changes.</p>`}`
    : '<div class="empty">Start a conversation to describe the bot setup you want. Gemini asks follow-up questions, reviews the proposal, and waits for your confirmation before deployment.</div>';
  const history = aiHistory.length ? aiHistory.map((entry) => `
    <article class="section ai-history-entry"><div class="section-title"><strong>${escapeHtml(entry.status)}</strong>
      ${entry.status === 'applied' ? `<button class="button danger" type="button" data-undo-ai="${escapeHtml(entry.id)}">Undo deployment</button>` : ''}</div>
      <p>${escapeHtml(entry.summary)}</p><p class="hint">${new Date(entry.createdAt).toLocaleString()} · administrator ${escapeHtml(entry.actorId)}</p></article>`).join('')
    : '<div class="empty">No AI deployments to undo.</div>';
  return `<h2>Gemini AI builder</h2>
    <p class="hint">Build supported drop, channel, tier, credit, and embed settings by conversation. Gemini only proposes declarative settings; it cannot edit code, stock, member balances, or global categories. Every proposal receives an AI safety review and requires your confirmation. Deployments can be undone if no later settings changes conflict. Configure GEMINI_API_KEY on the bot host.</p>
    <div class="ai-layout"><aside><button class="button primary" id="new-ai-conversation" type="button">New conversation</button><div class="ai-conversation-list">${conversations}</div></aside><section>${chat}</section></div>
    <section class="section"><div class="section-title"><h3>AI deployment history</h3><button class="button" id="refresh-ai-history" type="button">Refresh history</button></div>${history}</section>
    <section class="section"><div class="section-title"><h3>AI suspicious-activity alerts</h3><button class="button" id="refresh-ai-alerts" type="button">Refresh alerts</button></div>
      <p class="hint">Gemini reviews anonymized aggregate counts only. Alerts are advisory; the bot never automatically punishes members.</p><div id="ai-builder-alerts">${renderAiSafetyAlerts()}</div></section>`;
}

function renderMemberTools() {
  return `<h2>Member tools</h2>
    <p class="hint">Issue a timed tier to a member, or manage cooldowns. Cooldown reset and refresh rewards are restricted to the server owner.</p>
    <section class="section"><h3>Timed tier grant</h3>
      <p class="hint">Adds the configured tier role for a limited duration. Extending an existing timed grant adds time to its current expiry.</p>
      <div class="field-grid">
        ${field('Member user ID', '', 'id="member-tier-user" inputmode="numeric" placeholder="Discord user ID"')}
        <label class="field">Tier<select id="member-tier">${TIERS.filter((tier) => config.tiers[tier]?.roleId).map((tier) =>
          `<option value="${tier}">${escapeHtml(config.tiers[tier].label || tier)}</option>`
        ).join('')}</select></label>
        ${field('Duration in hours (1–8760)', 24, 'id="member-tier-duration" type="number" min="1" max="8760"')}
      </div>
      <button class="button primary" id="grant-tier" type="button" ${TIERS.every((tier) => !config.tiers[tier]?.roleId) ? 'disabled' : ''}>Grant timed tier</button>
    </section>
    <section class="section"><h3>Public tier reward drop</h3>
      <p class="hint">Post a claimable tier reward in a text channel. One winner receives the configured role for the selected duration.</p>
      <div class="field-grid">
        <label class="field">Tier<select id="drop-tier">${TIERS.filter((tier) => config.tiers[tier]?.roleId).map((tier) =>
          `<option value="${tier}">${escapeHtml(config.tiers[tier].label || tier)}</option>`
        ).join('')}</select></label>
        <label class="field">Channel<select id="drop-tier-channel">${channelOptions(config.channels[0]?.channelId)}</select></label>
        ${field('Duration in hours (1–8760)', 24, 'id="drop-tier-duration" type="number" min="1" max="8760"')}
      </div>
      <button class="button primary" id="post-tier-drop" type="button" ${TIERS.every((tier) => !config.tiers[tier]?.roleId) ? 'disabled' : ''}>Post tier reward</button>
    </section>
    <section class="section"><h3>Cooldown tools</h3>
      <label class="field">Member user ID<input id="member-cooldown-user" inputmode="numeric" placeholder="Discord user ID"></label>
      <div class="copy-actions"><button class="button" id="reset-cooldowns" type="button">Reset cooldowns now</button><button class="button" id="send-cooldown-reward" type="button">DM one-use refresh</button></div>
      <p class="hint">Only the server owner can use these buttons. Rewards expire after seven days if unused.</p>
    </section>`;
}

function renderTiers() {
  return `<h2>Tier settings</h2>
    <p class="hint">Role matching, daily usage, cooldowns, shop details, and secure-item behavior.</p>
    ${TIERS.map((name) => {
      const tier = config.tiers[name] || {};
      return `<article class="section tier-card" data-tier="${name}">
        <h3>${escapeHtml(tier.label || name)}</h3>
        <div class="field-grid">
          <label class="field">Discord role<select data-tier-field="roleId">${roleOptions(tier.roleId)}</select></label>
          ${field('Daily limit (0 = no limit)', tier.dailyLimit ?? 0, 'data-tier-field="dailyLimit" type="number" min="0" max="100"')}
          ${field('Cooldown in minutes', tier.cooldownMinutes ?? 0, 'data-tier-field="cooldownMinutes" type="number" min="0" max="10080"')}
          ${field('Shop price', tier.price ?? 0, 'data-tier-field="price" type="number" min="0" step="0.01"')}
          ${field('Secure removals per click (0 = automatic)', tier.secureItemsPerClick ?? 1, 'data-tier-field="secureItemsPerClick" type="number" min="0" max="25"')}
          ${field('Trial duration in hours (1–8760)', tier.trialDurationHours ?? 24, 'data-tier-field="trialDurationHours" type="number" min="1" max="8760"')}
        </div>
        <label class="check-row"><input data-tier-field="trialEnabled" type="checkbox" ${tier.trialEnabled ? 'checked' : ''}> Offer this tier as a one-time shop trial</label>
        <label class="field">Shop description<textarea data-tier-field="description" maxlength="850">${escapeHtml(tier.description || '')}</textarea></label>
      </article>`;
    }).join('')}`;
}

function renderAppearance() {
  const style = config.embedStyle || {};
  return `<h2>Embed appearance</h2><p class="hint">Brand public drop embeds.</p>
    <div class="field-grid">
      ${field('Color', style.color || '#5865F2', 'id="embed-color" type="color"')}
      ${field('Title', style.title || '', 'id="embed-title" maxlength="256"')}
      ${field('Footer', style.footer || '', 'id="embed-footer" maxlength="2048"')}
      ${field('Thumbnail URL (HTTPS)', style.thumbnailUrl || '', 'id="embed-thumbnail" type="url"')}
      ${field('Banner URL (HTTPS)', style.imageUrl || '', 'id="embed-image" type="url"')}
    </div>`;
}

function renderOptions() {
  return `<h2>Default options</h2><p class="hint">These defaults apply to new drops. Members may be able to override CAPTCHA per drop where configured.</p>
    <label class="check-row"><input id="captcha-default" type="checkbox" ${config.quizEnabledByDefault ? 'checked' : ''}> Require CAPTCHA by default</label>
    <label class="check-row"><input id="ai-default" type="checkbox" ${config.aiCategorizationEnabled ? 'checked' : ''}> Enable AI bulk categorization</label>`;
}

function renderCopy() {
  const sourceOptions = guilds.filter((guild) => guild.id !== $('#guild-select').value).map((guild) =>
    `<option value="${escapeHtml(guild.id)}">${escapeHtml(guild.name)}</option>`
  ).join('');
  return `<h2>Copy settings from another server</h2>
    <p class="hint">Only servers where you’re an Administrator and the bot is present are available. Existing values in the selected sections will be replaced. Matching text channels and roles are reused by name; unmatched tier roles are left blank. Credit rules and generator costs are copied, but wallets, transactions, and published message IDs are not. Shared inventory and categories are not changed.</p>
    <label class="field">Source server<select id="copy-source"><option value="">Choose a server</option>${sourceOptions}</select></label>
    ${COPY_SECTIONS.map(([key, label]) => `<label class="check-row"><input type="checkbox" data-copy-section="${key}">${escapeHtml(label)}</label>`).join('')}
    <div class="copy-actions"><button class="button primary" id="copy-settings" type="button">Copy selected settings</button></div>
    <p class="hint">If the source server has several drop channels, matching channels will be created if they don’t exist here.</p>`;
}

function collectConfig() {
  if (activeTab === 'channels') {
    return {
      channels: [...document.querySelectorAll('.channel-row')].map((row) => ({
        channelId: row.querySelector('[data-channel-id]').value,
        prefix: row.querySelector('[data-prefix]').value.trim(),
        tierSettings: Object.fromEntries(TIERS.map((tier) => [tier, {
          challengeEveryClaims: Number(row.querySelector(`[data-challenge="${tier}"]`).value),
          buttonDailyLimit: Number(row.querySelector(`[data-button-daily="${tier}"]`).value),
          buttonCooldownMinutes: Number(row.querySelector(`[data-button-cooldown="${tier}"]`).value),
        }])),
      })),
      logChannelId: $('#log-channel').value,
    };
  }
  if (activeTab === 'products') {
    const channels = config.channels.map((channel) => ({ ...channel }));
    const products = [...document.querySelectorAll('.product-card')].map((card) => {
      const value = (key) => card.querySelector(`[data-product="${key}"]`)?.value ?? '';
      const quantities = Object.fromEntries(TIERS.map((tier) => [tier, Number(card.querySelector(`[data-quantity="${tier}"]`).value)]));
      const cooldowns = Object.fromEntries(TIERS.map((tier) => [tier, card.querySelector(`[data-cooldown="${tier}"]`).value]));
      const product = {
        name: value('name').trim(),
        commandName: value('commandName').trim().toLowerCase(),
        category: value('category'),
        description: value('description').trim(),
        assignedChannelId: value('channelId'),
        embedColor: value('embedColor'),
        dailyLimit: value('dailyLimit') === '' ? null : Number(value('dailyLimit')),
        cooldownMinutes: value('cooldownMinutes') === '' ? null : Number(value('cooldownMinutes')),
        creditCost: Number(value('creditCost')),
        buttonTitle: value('buttonTitle').trim(),
        buttonDescription: value('buttonDescription').trim(),
        buttonLabel: value('buttonLabel').trim() || 'Claim',
        buttonImageUrl: value('buttonImageUrl').trim(),
        quantities,
        cooldowns,
      };
      if (!product.assignedChannelId) throw new Error(`Assign !${product.commandName || 'command'} to a drop channel.`);
      const assigned = channels.find((channel) => channel.channelId === product.assignedChannelId);
      if (!assigned) throw new Error(`Add a drop channel for !${product.commandName}.`);
      if (channels.some((channel) => channel.channelId !== product.assignedChannelId && channel.prefix.toLowerCase() === `!${product.commandName}`)) {
        throw new Error(`The !${product.commandName} command is already assigned to another channel.`);
      }
      assigned.prefix = `!${product.commandName}`;
      return product;
    });
    return {
      channels,
      products: products.map(({ assignedChannelId, ...product }) => product),
    };
  }
  if (activeTab === 'tiers') {
    const tiers = Object.fromEntries(TIERS.map((name) => {
      const card = document.querySelector(`[data-tier="${name}"]`);
      const read = (key) => card.querySelector(`[data-tier-field="${key}"]`).value;
      return [name, {
        roleId: read('roleId'),
        dailyLimit: Number(read('dailyLimit')),
        cooldownMinutes: Number(read('cooldownMinutes')),
        price: Number(read('price')),
        secureItemsPerClick: Number(read('secureItemsPerClick')),
        trialDurationHours: Number(read('trialDurationHours')),
        trialEnabled: card.querySelector('[data-tier-field="trialEnabled"]').checked,
        description: read('description'),
      }];
    }));
    return { tiers };
  }
  if (activeTab === 'appearance') {
    return { embedStyle: {
      color: $('#embed-color').value,
      title: $('#embed-title').value,
      footer: $('#embed-footer').value,
      thumbnailUrl: $('#embed-thumbnail').value,
      imageUrl: $('#embed-image').value,
    } };
  }
  if (activeTab === 'options') {
    return {
      quizEnabledByDefault: $('#captcha-default').checked,
      aiCategorizationEnabled: $('#ai-default').checked,
    };
  }
  if (activeTab === 'credits') {
    return {
      creditSettings: {
        startingBalance: Number(document.querySelector('[data-credit="startingBalance"]').value),
        dailyEnabled: document.querySelector('[data-credit="dailyEnabled"]').checked,
        dailyAmounts: Object.fromEntries(TIERS.map((tier) => [
          tier,
          Number(document.querySelector(`[data-daily-amount="${tier}"]`).value),
        ])),
        dailyCooldownHours: Number(document.querySelector('[data-credit="dailyCooldownHours"]').value),
        messageEnabled: document.querySelector('[data-credit="messageEnabled"]').checked,
        messageCredits: Number(document.querySelector('[data-credit="messageCredits"]').value),
        messageCooldownMinutes: Number(document.querySelector('[data-credit="messageCooldownMinutes"]').value),
        messageDailyCap: Number(document.querySelector('[data-credit="messageDailyCap"]').value),
        messageChannelIds: [...document.querySelector('[data-credit="messageChannelIds"]').selectedOptions].map((option) => option.value),
        messageEligibleTiers: TIERS.filter((tier) => document.querySelector(`[data-credit-tier="${tier}"]`).checked),
        aiSafetyEnabled: document.querySelector('[data-credit="aiSafetyEnabled"]').checked,
        invitesEnabled: document.querySelector('[data-credit="invitesEnabled"]').checked,
        inviteCredits: Number(document.querySelector('[data-credit="inviteCredits"]').value),
        inviteMemberAgeHours: Number(document.querySelector('[data-credit="inviteMemberAgeHours"]').value),
      },
    };
  }
  throw new Error('Use Copy settings to copy configuration from another server.');
}

async function loadInventory(offset = 0) {
  if (!selectedInventoryCategory) {
    inventoryPage = { items: [], offset: 0, limit: 50, total: 0 };
    renderPanel();
    return;
  }
  setStatus('Loading inventory…');
  const guildId = encodeURIComponent($('#guild-select').value);
  const query = new URLSearchParams({
    category: selectedInventoryCategory,
    offset: String(offset),
    limit: String(inventoryPage.limit),
  });
  inventoryPage = await api(`/api/guilds/${guildId}/inventory?${query}`);
  setStatus('');
  renderPanel();
}

async function createCategory() {
  const name = $('#new-category-name').value.trim();
  await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/categories`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      dropType: $('#new-category-type').value,
      description: $('#new-category-description').value,
    }),
  });
  await loadGuild();
  activeTab = 'categories';
  renderPanel();
  setStatus(`Created shared category ${name}.`);
}

async function saveCategory(button) {
  const card = button.closest('.category-card');
  const originalName = card.dataset.originalName;
  const name = card.querySelector('[data-category="name"]').value.trim();
  const result = await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/categories/${encodeURIComponent(originalName)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name,
      dropType: card.querySelector('[data-category="dropType"]').value,
      description: card.querySelector('[data-category="description"]').value,
    }),
  });
  await loadGuild();
  activeTab = 'categories';
  renderPanel();
  setStatus(`Saved category ${result.name}.`);
}

async function deleteCategory(button) {
  const card = button.closest('.category-card');
  const name = card.dataset.originalName;
  if (!window.confirm(`Remove ${name} globally? Its unclaimed stock will be archived and generators using it will be removed from every server.`)) return;
  const result = await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/categories/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  await loadGuild();
  activeTab = 'categories';
  renderPanel();
  setStatus(`Removed ${name}; archived ${result.archivedItems} stock item(s).`);
}

async function addInventory() {
  const values = $('#inventory-values').value;
  if (!selectedInventoryCategory) throw new Error('Choose a category first.');
  const result = await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/inventory`, {
    method: 'POST',
    body: JSON.stringify({
      category: selectedInventoryCategory,
      values,
      useAi: $('#inventory-ai').checked,
    }),
  });
  setStatus(`Added ${result.inserted}; skipped ${result.duplicates} duplicate(s).`);
  await loadGuild();
  activeTab = 'inventory';
  await loadInventory(Math.max(0, inventoryPage.total - inventoryPage.limit));
}

async function removeInventoryItem(button) {
  if (!window.confirm('Permanently remove this unclaimed shared inventory item?')) return;
  await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/inventory/${encodeURIComponent(button.dataset.deleteStock)}`, {
    method: 'DELETE',
  });
  await loadGuild();
  activeTab = 'inventory';
  await loadInventory(inventoryPage.offset);
  setStatus('Inventory item removed.');
}

async function editInventoryItem(button) {
  const item = inventoryPage.items.find((entry) => entry.id === button.dataset.editStock);
  if (!item) throw new Error('Reload inventory and try again.');
  const value = window.prompt('Edit this unclaimed shared inventory item:', item.value);
  if (value === null || value.trim() === item.value) return;
  await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/inventory/${encodeURIComponent(item.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ value }),
  });
  await loadInventory(inventoryPage.offset);
  setStatus('Inventory item updated.');
}

async function startEvent() {
  const category = $('#event-category').value;
  const channelId = $('#event-channel').value;
  const result = await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/events`, {
    method: 'POST',
    body: JSON.stringify({
      category,
      channelId,
      durationMinutes: Number($('#event-duration').value),
      pingHere: $('#event-ping').checked,
    }),
  });
  await loadGuild();
  activeTab = 'events';
  renderPanel();
  setStatus(`Event posted; it ends ${new Date(result.expiresAt).toLocaleString()}.`);
}

async function endEvent(button) {
  const eventRow = button.closest('[data-event-id]');
  await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/events/${encodeURIComponent(eventRow.dataset.eventId)}`, {
    method: 'DELETE',
  });
  await loadGuild();
  activeTab = 'events';
  renderPanel();
  setStatus('Event ended.');
}

async function publishShop() {
  const result = await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/shop`, {
    method: 'POST',
    body: JSON.stringify({ channelId: $('#shop-channel').value }),
  });
  setStatus(`Shop published in <#${result.channelId}>.`);
}

async function publishGeneratorButton(button) {
  const card = button.closest('.product-card');
  const index = Number(card.dataset.productIndex);
  const product = config.products[index];
  const read = (key) => card.querySelector(`[data-product="${key}"]`).value.trim();
  const channelId = read('buttonChannelId');
  if (!channelId) throw new Error('Choose a channel for this claim embed.');
  const result = await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/products/${encodeURIComponent(product.commandName)}/button-drop`, {
    method: 'POST',
    body: JSON.stringify({
      channelId,
      title: read('buttonTitle'),
      description: read('buttonDescription'),
      label: read('buttonLabel'),
      imageUrl: read('buttonImageUrl'),
    }),
  });
  await loadGuild();
  activeTab = 'products';
  renderPanel();
  setStatus(`Claim embed published in <#${result.channelId}>.`);
}

async function postTierDrop() {
  const result = await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/tier-drops`, {
    method: 'POST',
    body: JSON.stringify({
      tierName: $('#drop-tier').value,
      durationHours: Number($('#drop-tier-duration').value),
      channelId: $('#drop-tier-channel').value,
    }),
  });
  setStatus(`Tier reward posted in <#${result.channelId}>.`);
}

async function submitMemberTool(action, userId, extras = {}) {
  if (!userId) throw new Error('Enter a member user ID.');
  const result = await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/member-tools`, {
    method: 'POST',
    body: JSON.stringify({ action, userId, ...extras }),
  });
  if (action === 'timed-tier') {
    setStatus(`Tier granted until ${new Date(result.expiresAt).toLocaleString()}.`);
  } else if (action === 'cooldown-reward') {
    setStatus(`One-use refresh sent; it expires ${new Date(result.expiresAt).toLocaleString()}.`);
  } else {
    setStatus('Member cooldowns reset.');
  }
}

function runAction(action) {
  action().catch((error) => {
    console.error('Dashboard action failed', error);
    setStatus(error.message || 'The action failed.', true);
  });
}

function addChannelRow() {
  const list = $('#channels-list');
  if (list.querySelectorAll('.channel-row').length >= 10) return;
  if (list.querySelector('.empty')) list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', `<div class="row channel-row">
    <label class="field">Drop channel<select data-channel-id>${channelOptions()}</select></label>
    <label class="field">Command prefix<input data-prefix value="!drop" maxlength="33"></label>
    <button class="button danger" data-remove-channel type="button">Remove</button>
    <div class="channel-details"><details><summary>Button caps, cooldowns, and CAPTCHA by tier</summary>
      <div class="field-grid">${TIERS.map((tier) => `
        ${field(tier[0].toUpperCase() + tier.slice(1) + ' — CAPTCHA every N claims', 3,
          `data-challenge="${tier}" type="number" min="1" max="20"`)}
        ${field(tier[0].toUpperCase() + tier.slice(1) + ' — button claims per day', 4,
          `data-button-daily="${tier}" type="number" min="1" max="1000"`)}
        ${field(tier[0].toUpperCase() + tier.slice(1) + ' — button cooldown (minutes)', 0,
          `data-button-cooldown="${tier}" type="number" min="0" max="10080"`)}
      `).join('')}</div>
    </details></div>
  </div>`);
}

function addProductCard() {
  if (config.products.length >= 10) return;
  const colors = ['#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#1ABC9C', '#E67E22', '#9B59B6', '#3498DB', '#95A5A6'];
  const used = new Set(config.products.map((product) => product.embedColor?.toUpperCase()));
  const nextColor = colors.find((color) => !used.has(color.toUpperCase()));
  config.products.push({
    name: 'New generator',
    commandName: 'new-generator',
    category: config.categories[0]?.name || '',
    description: '',
    embedColor: nextColor || '#5865F2',
    quantities: Object.fromEntries(TIERS.map((tier) => [tier, 1])),
    cooldowns: {},
  });
  renderPanel();
}

async function saveSettings() {
  try {
    if (!config) return;
    setStatus('Saving…');
    const body = collectConfig();
    await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    await loadGuild();
    if (activeTab === 'credits') await loadCreditStats();
    setStatus('Saved.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function copySettings() {
  try {
    const sourceGuildId = $('#copy-source').value;
    const sections = [...document.querySelectorAll('[data-copy-section]:checked')].map((checkbox) => checkbox.dataset.copySection);
    if (!sourceGuildId) throw new Error('Choose a source server.');
    if (!sections.length) throw new Error('Select at least one section to copy.');
    setStatus('Copying…');
    const result = await api(`/api/guilds/${encodeURIComponent($('#guild-select').value)}/copy`, {
      method: 'POST',
      body: JSON.stringify({ sourceGuildId, sections }),
    });
    await loadGuild();
    setStatus(`Copied settings from ${result.sourceName}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

document.addEventListener('change', (event) => {
  if (event.target.id === 'inventory-category') {
    selectedInventoryCategory = event.target.value;
    return runAction(() => loadInventory(0));
  }
});

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    activeTab = tab.dataset.tab;
    renderPanel();
    if (activeTab === 'inventory') runAction(() => loadInventory(0));
    if (activeTab === 'credits') runAction(async () => {
      await loadCreditStats();
      await loadAiSafetyAlerts();
    });
    if (activeTab === 'ai-builder') runAction(loadAiBuilder);
    return;
  }
  if (event.target.id === 'save') return runAction(saveSettings);
  if (event.target.id === 'reload-settings') return runAction(async () => {
    if (!window.confirm('Discard unsaved changes and reload the saved settings from the bot?')) return;
    await loadGuild();
    setStatus('Loaded saved settings from the bot.');
  });
  if (event.target.id === 'add-channel') return addChannelRow();
  if (event.target.id === 'add-product') return addProductCard();
  if (event.target.id === 'copy-settings') return runAction(copySettings);
  if (event.target.id === 'create-category') return runAction(createCategory);
  if (event.target.matches('[data-save-category]')) return runAction(() => saveCategory(event.target));
  if (event.target.matches('[data-delete-category]')) return runAction(() => deleteCategory(event.target));
  if (event.target.id === 'add-stock') return runAction(addInventory);
  if (event.target.id === 'refresh-stock') return runAction(() => loadInventory(inventoryPage.offset));
  if (event.target.id === 'stock-previous') return runAction(() => loadInventory(Math.max(0, inventoryPage.offset - inventoryPage.limit)));
  if (event.target.id === 'stock-next') return runAction(() => loadInventory(inventoryPage.offset + inventoryPage.limit));
  if (event.target.matches('[data-delete-stock]')) return runAction(() => removeInventoryItem(event.target));
  if (event.target.matches('[data-edit-stock]')) return runAction(() => editInventoryItem(event.target));
  if (event.target.id === 'start-event') return runAction(startEvent);
  if (event.target.matches('[data-end-event]')) return runAction(() => endEvent(event.target));
  if (event.target.id === 'publish-shop') return runAction(publishShop);
  if (event.target.id === 'load-credit-stats') return runAction(() => loadCreditStats());
  if (event.target.id === 'lookup-credit-member') return runAction(() => {
    const userId = $('#credit-member-id').value.trim();
    if (userId && !/^\d{17,20}$/.test(userId)) throw new Error('Enter a valid Discord user ID.');
    return loadCreditStats(userId);
  });
  if (event.target.id === 'grant-credits') return runAction(grantMemberCredits);
  if (event.target.id === 'refresh-ai-alerts') return runAction(loadAiSafetyAlerts);
  if (event.target.id === 'new-ai-conversation') return runAction(createAiConversation);
  if (event.target.id === 'send-ai-message') return runAction(sendAiMessage);
  if (event.target.id === 'confirm-ai-deploy') return runAction(confirmAiDeployment);
  if (event.target.id === 'discard-ai-proposal') return runAction(discardAiProposal);
  if (event.target.id === 'refresh-ai-history') return runAction(loadAiBuilder);
  if (event.target.matches('[data-undo-ai]')) return runAction(() => undoAiDeployment(event.target));
  if (event.target.matches('[data-dismiss-alert]')) return runAction(() => dismissAiAlert(event.target));
  const conversationButton = event.target.closest('[data-ai-conversation]');
  if (conversationButton) {
    selectedAiConversationId = conversationButton.dataset.aiConversation;
    return renderPanel();
  }
  if (event.target.id === 'post-tier-drop') return runAction(postTierDrop);
  if (event.target.id === 'grant-tier') return runAction(() => submitMemberTool('timed-tier', $('#member-tier-user').value.trim(), {
    tierName: $('#member-tier').value,
    durationHours: Number($('#member-tier-duration').value),
  }));
  if (event.target.id === 'reset-cooldowns' || event.target.id === 'send-cooldown-reward') {
    const actionName = event.target.id === 'reset-cooldowns' ? 'reset-cooldowns' : 'cooldown-reward';
    return runAction(() => submitMemberTool(actionName, $('#member-cooldown-user').value.trim()));
  }
  if (event.target.id === 'retry-load') return runAction(async () => {
    await loadGuild();
    if (activeTab === 'inventory') await loadInventory(0);
  });
  if (event.target.matches('[data-remove-channel]')) {
    event.target.closest('.channel-row').remove();
    return;
  }
  if (event.target.matches('[data-remove-product]')) {
    const index = Number(event.target.closest('.product-card').dataset.productIndex);
    config.products.splice(index, 1);
    return renderPanel();
  }
  if (event.target.matches('[data-publish-button]')) return runAction(() => publishGeneratorButton(event.target));
  if (event.target.id === 'logout') {
    return runAction(async () => {
      await api('/auth/logout', { method: 'POST' });
      showSignIn();
    });
  }
});

$('#guild-select').addEventListener('change', () => runAction(async () => {
  await loadGuild();
  if (activeTab === 'inventory') await loadInventory(0);
  if (activeTab === 'credits') {
    await loadCreditStats();
    await loadAiSafetyAlerts();
  }
  if (activeTab === 'ai-builder') await loadAiBuilder();
}));
window.addEventListener('error', (event) => {
  console.error('Dashboard page error', event.error);
  setStatus('A dashboard control failed. Reload this page and try again.', true);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('Dashboard request failed', event.reason);
  setStatus(event.reason?.message || 'A dashboard request failed.', true);
});
start();
