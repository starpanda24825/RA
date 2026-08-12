// Fiducia Exchange — Market Overview JS
(function () {
  'use strict';

  let companies = [];
  let sortKey = 'market_cap';
  let sortDir = 'desc';

  async function api(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  async function fetchMe() {
    try {
      const r = await fetch('/api/auth/me');
      if (r.ok) return r.json();
    } catch (e) {}
    return null;
  }

  function formatNum(n) { return n != null ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'; }
  function formatChange(c, p) {
    if (p == null || p === 0) return '<span class="td-change flat">0.00</span>';
    const cl = c > 0 ? 'up' : c < 0 ? 'down' : 'flat';
    const arrow = c > 0 ? '▲' : c < 0 ? '▼' : '';
    return `<span class="td-change ${cl}">${arrow} ${c.toFixed(2)} (${p.toFixed(2)}%)</span>`;
  }

  function statusBadge(status) {
    return `<span class="status-badge ${status}">${status}</span>`;
  }

  let idxCache = null;

  // Index banner + sparkline (single API call)
  async function loadIndex() {
    try {
      idxCache = await api('/api/exchange/index?limit=72');
      const data = idxCache;
      const idx = data.current || {};
      const change = data.history && data.history.length >= 2
        ? idx.index_value - data.history[data.history.length - 2].index_value
        : 0;
      const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
      const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '';

      document.getElementById('idx-value').textContent = formatNum(idx.index_value);
      document.getElementById('idx-change').innerHTML = `<span class="idx-banner__change ${changeClass}">${arrow} ${change.toFixed(2)}</span>`;
      document.getElementById('idx-advancing').textContent = idx.advancing || 0;
      document.getElementById('idx-declining').textContent = idx.declining || 0;

      drawSparkline(data.history);
    } catch (e) { console.error('Index error:', e); }
  }

  function drawSparkline(history) {
    const svg = document.getElementById('idx-sparkline');
    if (!svg || !history || history.length < 2) return;

    const values = history.map(h => h.index_value);
    const min = Math.min(...values) * 0.998;
    const max = Math.max(...values) * 1.002;
    const range = max - min || 1;
    const w = 260, h2 = 48, padR = 4;

    const points = values.map((v, i) =>
      `${(i / (values.length - 1)) * (w - padR)},${h2 - ((v - min) / range) * h2}`
    ).join(' ');

    const trend = values[values.length - 1] >= values[0] ? 'var(--teal-bright)' : 'var(--crimson-bright)';

    svg.innerHTML = `
      <polyline points="${points}" fill="none" stroke="${trend}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      <polygon points="${points} ${w - padR},${h2} 0,${h2}" fill="${trend}" opacity="0.08"/>
    `;
  }

  // Market table
  async function loadMarket() {
    try {
      companies = await api('/api/exchange/market');
      sortAndRender();
    } catch (e) { console.error('Market error:', e); }
  }

  function sortAndRender() {
    companies.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'string') va = va.toLowerCase(), vb = (vb || '').toLowerCase();
      if (va == null) va = 0;
      if (vb == null) vb = 0;
      if (sortDir === 'asc') return va > vb ? 1 : va < vb ? -1 : 0;
      return va < vb ? 1 : va > vb ? -1 : 0;
    });

    const tbody = document.getElementById('market-tbody');
    tbody.innerHTML = companies.map(c => `
      <tr onclick="location.href='company/view.html?ticker=${c.ticker}'">
        <td><span class="td-ticker">${c.ticker}</span></td>
        <td>${esc(c.name)}</td>
        <td>${c.sector}</td>
        <td class="td-price">${formatNum(c.current_price)}</td>
        <td>${formatChange(c.change, c.changePct)}</td>
        <td>${formatNum(c.day_volume)}</td>
        <td>${formatNum(c.market_cap)}</td>
        <td>${statusBadge(c.status)}</td>
      </tr>
    `).join('');

    // Update sort indicator on headers
    document.querySelectorAll('.ex-table th').forEach(th => {
      th.classList.toggle('sorted', th.dataset.sort === sortKey);
    });
  }

  function esc(s) { return (s || '').replace(/[<>&\"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  // Sector heatmap (improved: color-coded by mcap, performance indicator)
  async function loadSectors() {
    try {
      const sectors = await api('/api/exchange/sectors');
      if (!sectors || !sectors.length) return;
      const maxCap = Math.max(...sectors.map(s => s.total_market_cap || 0), 1);
      const grid = document.getElementById('sector-grid');
      grid.innerHTML = sectors.map(s => {
        const intensity = Math.round(((s.total_market_cap || 0) / maxCap) * 100);
        const perf = s.avg_change_pct;
        const hasPerf = perf != null && !isNaN(perf);
        const perfArrow = hasPerf ? (perf > 1 ? '▲' : perf < -1 ? '▼' : '') : '';
        const perfClass = hasPerf ? (perf > 1 ? 'up' : perf < -1 ? 'down' : 'flat') : '';
        const perfText = hasPerf ? `${perfArrow} ${Math.abs(perf).toFixed(1)}%` : '—';
        const color = s.sector_color || getSectorColor(s.sector);
        return `
        <div class="sector-card" style="border-left: 3px solid ${color}; background: linear-gradient(135deg, var(--ink-elevated) ${100-intensity}%, ${color}11 ${intensity}%);">
          <div class="sector-card__name">${s.sector}</div>
          <div class="sector-card__count">${s.count} listings</div>
          <div class="sector-card__cap">${formatNum(s.total_market_cap)}</div>
          <div class="sector-card__perf ${perfClass}">${perfText}</div>
          <div class="sector-card__bar"><div class="sector-card__bar-fill" style="width:${intensity}%;background:${color}"></div></div>
        </div>`;
      }).join('');
    } catch (e) { console.error('Sectors error:', e); }
  }

  function getSectorColor(sector) {
    const colors = { BANKING:'#2e8e96', TRADE:'#c0843a', MINING:'#8e6b4f', AGRICULTURE:'#5a8e3a', SERVICES:'#6b4eaa', MILITARY:'#b04040' };
    return colors[sector] || '#888';
  }

  // Recent trades
  async function loadRecentTrades() {
    try {
      // Fetch global recent trades from the most active company (don't mutate sort order)
      if (companies.length > 0) {
        const top = [...companies].sort((a,b) => (b.day_volume||0) - (a.day_volume||0))[0];
        if (top) {
          const trades = await api('/api/exchange/companies/' + top.ticker + '/trades');
          const el = document.getElementById('recent-trades-list');
          el.innerHTML = (trades && trades.length) ? trades.slice(0, 10).map(t => `
            <div class="recent-trades__row">
              <span class="rt-ticker">${esc(t.ticker || top.ticker)}</span>
              <span class="rt-qty">${formatNum(t.quantity)} @ ${formatNum(t.price)}</span>
              <span class="rt-time">${new Date(t.executed_at).toLocaleTimeString()}</span>
            </div>
          `).join('') : '<div class="empty-state">Trades appear here as the market ticks</div>';
          return;
        }
      }
    } catch (e) { /* okay */ }
    document.getElementById('recent-trades-list').innerHTML =
      '<div class="empty-state">Trades appear here as the market ticks</div>';
  }

  // Sort handlers
  document.getElementById('market-table').addEventListener('click', function (e) {
    const th = e.target.closest('th');
    if (!th || !th.dataset.sort) return;
    if (sortKey === th.dataset.sort) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = th.dataset.sort;
      sortDir = 'desc';
    }
    sortAndRender();
  });

  // Init
  async function init() {
    loadIndex();
    loadMarket();
    loadSectors();
    loadRecentTrades();

    // Auto-refresh every 30s
    setInterval(() => {
      loadIndex();
      loadMarket();
      loadSectors();
    }, 30000);
  }

  init();
})();
