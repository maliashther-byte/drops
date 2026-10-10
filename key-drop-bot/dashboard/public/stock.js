'use strict';

const $ = (selector) => document.querySelector(selector);
let refreshing = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

async function refreshStock() {
  if (refreshing) return;
  refreshing = true;
  $('#refresh').disabled = true;
  $('#status').textContent = 'Refreshing…';

  try {
    const response = await fetch('/api/public/stock', { cache: 'no-store' });
    if (!response.ok) throw new Error('Stock counts could not be loaded.');
    const stock = await response.json();
    $('#available-total').textContent = stock.totals.available.toLocaleString();
    $('#claimed-total').textContent = stock.totals.claimed.toLocaleString();
    $('#category-total').textContent = `${stock.categories.length} ${stock.categories.length === 1 ? 'category' : 'categories'}`;
    $('#stock-rows').innerHTML = stock.categories.length
      ? stock.categories.map((category) => `<tr>
          <td>${escapeHtml(category.name)}</td>
          <td class="type">${escapeHtml(category.dropType)}</td>
          <td class="count">${category.available.toLocaleString()}</td>
          <td>${category.claimed.toLocaleString()}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="empty">No shared categories are configured.</td></tr>';
    const updatedAt = new Date(stock.updatedAt);
    $('#status').textContent = `Updated ${updatedAt.toLocaleTimeString()}`;
  } catch (error) {
    $('#status').textContent = error.message || 'Could not refresh stock.';
  } finally {
    refreshing = false;
    $('#refresh').disabled = false;
  }
}

$('#refresh').addEventListener('click', refreshStock);
refreshStock();
setInterval(refreshStock, 10_000);