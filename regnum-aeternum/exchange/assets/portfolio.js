// Portfolio JS for Fiducia Exchange
(function () {
  'use strict';

  let portfolio = null;
  let myAccountId = null;
  let openOrders = [];
  let trades = [];
  let watchlist = [];

  function formatNum(n) { return n != null ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'; }
  function esc(s) { return (s || '').replace(/[<>&\"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  async function api(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(r.status); return r.json(); }

  function statusBadge(s) { return `<span class="status-badge ${s}">${s}</span>`; }

  async function init() {
    try {
      await api('/api/auth/me');
    } catch(e) {
      document.getElementById('app').innerHTML =
        '<div class="exchange-wrap"><div class="auth-notice">Sign in to view your portfolio. <a href="../../admin/">Go to admin panel</a> to log in.</div></div>';
      return;
    }

    await loadMe();
    await Promise.all([loadPortfolio(), loadOrders(), loadTrades(), loadWatchlist()]);
    render();
  }

  async function loadMe() {
    try {
      const banking = await api('/api/banking/me');
      myAccountId = banking.key;
    } catch(e) {}
  }

  async function loadPortfolio() {
    try {
      portfolio = await api('/api/exchange/portfolio');
      // Fallback: get account_id from first holding if not set yet
      if (!myAccountId && portfolio.holdings && portfolio.holdings.length > 0) {
        myAccountId = portfolio.holdings[0].account_id;
      }
    } catch(e) { portfolio = { holdings: [], summary: {} }; }
  }

  async function loadOrders() {
    try { openOrders = await api('/api/exchange/orders'); } catch(e) { openOrders = []; }
  }

  async function loadTrades() {
    try { trades = await api('/api/exchange/trades'); } catch(e) { trades = []; }
  }

  async function loadWatchlist() {
    try { watchlist = await api('/api/exchange/watchlist'); } catch(e) { watchlist = []; }
  }

  function render() {
    const s = portfolio.summary || {};
    const pnlClass = s.totalPnl >= 0 ? 'up' : 'down';

    document.getElementById('app').innerHTML = `
      <div class="exchange-header">
        <div>
          <h1 class="exchange-title">My Portfolio</h1>
          <p class="exchange-subtitle">Holdings, Orders & Watchlist</p>
        </div>
      </div>

      <div class="portfolio-summary">
        <div class="portfolio-summary__card">
          <label>Portfolio Value</label>
          <div class="big">${formatNum(s.totalValue)}</div>
        </div>
        <div class="portfolio-summary__card">
          <label>Total Invested</label>
          <div class="big">${formatNum(s.totalInvested)}</div>
        </div>
        <div class="portfolio-summary__card">
          <label>Total P/L</label>
          <div class="big ${pnlClass}">${s.totalPnl >= 0 ? '+' : ''}${formatNum(s.totalPnl)} (${formatNum(s.totalPnlPct)}%)</div>
        </div>
      </div>

      <div class="portfolio-section">
        <h3>Holdings</h3>
        ${(portfolio.holdings || []).length ? `
        <table class="ex-table">
          <thead><tr><th>Ticker</th><th>Company</th><th>Qty</th><th>Avg Cost</th><th>Price</th><th>Value</th><th>P/L</th><th>P/L%</th></tr></thead>
          <tbody>
            ${portfolio.holdings.map(h => {
              const pnlClass = h.unrealizedPnl >= 0 ? 'up' : 'down';
              const arrow = h.unrealizedPnl >= 0 ? '▲' : '▼';
              return `<tr onclick="location.href='../company/view.html?ticker=${h.ticker}'">
                <td class="td-ticker">${h.ticker}</td>
                <td>${esc(h.company_name)}</td>
                <td>${formatNum(h.quantity)}</td>
                <td>${formatNum(h.average_cost)}</td>
                <td>${formatNum(h.current_price)}</td>
                <td>${formatNum(h.currentValue)}</td>
                <td class="td-change ${pnlClass}">${arrow} ${formatNum(Math.abs(h.unrealizedPnl))}</td>
                <td class="td-change ${pnlClass}">${h.unrealizedPnlPct >= 0 ? '+' : ''}${formatNum(h.unrealizedPnlPct)}%</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        ` : '<div class="empty-state">No holdings yet. <a href="../">Browse the market</a> to start investing.</div>'}
      </div>

      <div class="portfolio-section">
        <h3>Open Orders</h3>
        ${openOrders.length ? `
        <table class="ex-table">
          <thead><tr><th>Ticker</th><th>Side</th><th>Type</th><th>Qty/Filled</th><th>Price</th><th>Status</th><th>Placed</th><th></th></tr></thead>
          <tbody>
            ${openOrders.map(o => `
              <tr>
                <td class="td-ticker">${o.ticker}</td>
                <td style="color:${o.side === 'BUY' ? 'var(--teal-bright)' : 'var(--crimson-bright)'}">${o.side}</td>
                <td>${o.order_type}</td>
                <td>${o.quantity_filled}/${o.quantity}</td>
                <td>${formatNum(o.limit_price) || 'MKT'}</td>
                <td>${statusBadge(o.status)}</td>
                <td style="font-size:10px;color:var(--slate-soft);">${new Date(o.placed_at).toLocaleString()}</td>
                <td>${(o.status === 'open' || o.status === 'partial') ? `<button class="cancel-btn" data-cancel="${o.id}">Cancel</button>` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ` : '<div class="empty-state">No open orders.</div>'}
      </div>

      <div class="portfolio-section">
        <h3>Order History</h3>
        ${trades.length ? `
        <table class="ex-table">
          <thead><tr><th>Ticker</th><th>Side</th><th>Qty</th><th>Price</th><th>Total</th><th>Fee</th><th>Time</th></tr></thead>
          <tbody>
            ${trades.map(t => {
              return `<tr>
                <td class="td-ticker">${t.ticker}</td>
                <td style="color:${t.buyer_account === myAccountId ? 'var(--teal-bright)' : 'var(--crimson-bright)'}">${t.buyer_account === myAccountId ? 'BUY' : 'SELL'}</td>
                <td>${formatNum(t.quantity)}</td>
                <td>${formatNum(t.price)}</td>
                <td>${formatNum(t.total_value)}</td>
                <td>${formatNum(t.exchange_fee)}</td>
                <td style="font-size:10px;color:var(--slate-soft);">${new Date(t.executed_at).toLocaleString()}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        ` : '<div class="empty-state">No trade history.</div>'}
      </div>

      <div class="portfolio-section">
        <h3>Watchlist</h3>
        ${watchlist.length ? `
        <table class="ex-table">
          <thead><tr><th>Ticker</th><th>Company</th><th>Price</th><th>Change</th><th>Actions</th></tr></thead>
          <tbody>
            ${watchlist.map(w => {
              const change = w.change || 0;
              const pct = w.changePct || 0;
              const changeClass = change >= 0 ? 'up' : 'down';
              const arrow = change >= 0 ? '▲' : '▼';
              return `<tr onclick="location.href='../company/view.html?ticker=${w.ticker}'">
                <td class="td-ticker">${w.ticker}</td>
                <td>${esc(w.name)}</td>
                <td>${formatNum(w.current_price)}</td>
                <td class="td-change ${changeClass}">${arrow} ${formatNum(Math.abs(change))} (${formatNum(Math.abs(pct))}%)</td>
                <td><button class="cancel-btn" data-remove-watch="${w.ticker}" onclick="event.stopPropagation()">Remove</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        ` : '<div class="empty-state">No stocks on your watchlist. Add from a company page.</div>'}
      </div>
    `;

    // Cancel order handlers
    document.querySelectorAll('[data-cancel]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await fetch('/api/exchange/orders/' + btn.dataset.cancel, { method: 'DELETE' });
          await loadOrders();
          render();
        } catch(err) { alert('Failed to cancel order.'); }
      });
    });

    // Remove watchlist handlers
    document.querySelectorAll('[data-remove-watch]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await fetch('/api/exchange/watchlist/' + btn.dataset.removeWatch, { method: 'DELETE' });
          await loadWatchlist();
          render();
        } catch(err) { /* ignore */ }
      });
    });
  }

  init();
})();
