// Company View JS for Fiducia Exchange
(function () {
  'use strict';

  const ticker = new URLSearchParams(location.search).get('ticker');
  if (!ticker) { document.getElementById('app').innerHTML = '<p class="empty-state">No ticker specified.</p>'; return; }

  let company = null;
  let chartInterval = '1h';
  let candles = [];
  let me = null;

  function formatNum(n) { return n != null ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'; }
  function esc(s) { return (s || '').replace(/[<>&\"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  async function api(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(r.status); return r.json(); }

  async function init() {
    try { me = await api('/api/auth/me'); } catch(e) {}
    await loadCompany();
    await loadCandles();
    await loadOrderBook();
    await loadTrades();
    await loadShareholders();
    await loadMyPosition();
  }

  async function loadCompany() {
    try {
      company = await api('/api/exchange/companies/' + ticker);
      renderCompanyHeader();
      renderKeyStats();
    } catch(e) {
      document.getElementById('app').innerHTML = '<p class="empty-state">Company not found.</p>';
    }
  }

  function renderCompanyHeader() {
    const c = company;
    const change = c.change || 0;
    const changePct = c.changePct || 0;
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '';

    document.getElementById('app').innerHTML = `
      <div class="co-header">
        <div class="co-logo">${c.logo_emoji || '🏢'}</div>
        <div>
          <div class="co-name">${esc(c.name)}</div>
          <span class="co-ticker">${c.ticker}</span>
          <span class="co-sector">${c.sector}</span>
        </div>
      </div>

      <div class="company-layout">
        <div class="co-main">
          <div class="co-price-block">
            <div>
              <div class="co-price-big">${formatNum(c.current_price)}</div>
              <div class="co-price-change ${change >= 0 ? 'up' : 'down'}">${arrow} ${formatNum(Math.abs(change))} (${formatNum(Math.abs(changePct))}%)</div>
            </div>
            <div class="co-price-stats">
              <div>Day High <span>${formatNum(c.day_high)}</span></div>
              <div>Day Low <span>${formatNum(c.day_low)}</span></div>
              <div>Volume <span>${formatNum(c.day_volume)}</span></div>
            </div>
          </div>

          <div class="co-chart">
            <div class="co-chart__tabs" id="chart-tabs">
              <button class="co-chart__tab ${chartInterval === '5m' ? 'active' : ''}" data-interval="5m">5M</button>
              <button class="co-chart__tab ${chartInterval === '1h' ? 'active' : ''}" data-interval="1h">1H</button>
              <button class="co-chart__tab ${chartInterval === '1d' ? 'active' : ''}" data-interval="1d">1D</button>
            </div>
            <svg class="co-chart__svg" id="chart-svg" viewBox="0 0 600 260"></svg>
          </div>

          <div class="recent-trades" id="recent-trades-section">
            <h3>Recent Trades</h3>
            <div id="recent-trades-list"></div>
          </div>
        </div>

        <div class="co-sidebar">
          ${me ? `
          <div class="order-form" id="order-form">
            <h3>Place Order</h3>
            <div class="order-form__tabs">
              <button class="order-form__tab active buy" data-side="BUY">BUY</button>
              <button class="order-form__tab sell" data-side="SELL">SELL</button>
            </div>
            <div class="order-form__field">
              <label>Type</label>
              <select id="order-type">
                <option value="LIMIT">Limit</option>
                <option value="MARKET">Market</option>
                <option value="STOP_LOSS">Stop Loss</option>
                <option value="STOP_LIMIT">Stop Limit</option>
              </select>
            </div>
            <div class="order-form__field" id="limit-price-field">
              <label>Price per Share</label>
              <input id="limit-price" type="number" step="0.01" min="0.01" placeholder="${company.current_price || ''}" />
            </div>
            <div class="order-form__field" id="stop-price-field" style="display:none;">
              <label>Stop Price</label>
              <input id="stop-price" type="number" step="0.01" min="0.01" placeholder="Stop trigger..." />
            </div>
            <div class="order-form__field">
              <label>Quantity</label>
              <input id="order-qty" type="number" min="1" step="1" placeholder="Number of shares" />
            </div>
            <div class="order-form__estimate" id="order-estimate"></div>
            <button class="order-form__submit buy" id="order-submit">Place Buy Order</button>
            <p class="order-form__msg" id="order-msg"></p>
          </div>
          ` : '<div class="auth-notice">Sign in to trade. <a href="../../admin/">Go to admin panel</a> to log in.</div>'}

          <div class="orderbook" id="orderbook-section">
            <h3>Order Book</h3>
            <div id="orderbook-content"><div class="loading">Loading…</div></div>
          </div>

          <div class="key-stats" id="key-stats-section"></div>

          <div id="my-position-section"></div>

          <div class="key-stats" id="shareholders-section">
            <h3>Top Shareholders</h3>
            <div id="shareholders-list"><div class="loading">Loading…</div></div>
          </div>
        </div>
      </div>
    `;

    attachEventListeners();
  }

  function renderKeyStats() {
    const c = company;
    const eps = c.total_shares > 0 ? c.fundamental_earnings / c.total_shares : 0;
    const peRatio = eps > 0 ? c.current_price / eps : null;

    document.getElementById('key-stats-section').innerHTML = `
      <h3>Key Statistics</h3>
      <div class="key-stats__row"><span class="label">Market Cap</span><span class="value">${formatNum(c.market_cap)}</span></div>
      <div class="key-stats__row"><span class="label">Shares Outstanding</span><span class="value">${formatNum(c.total_shares)}</span></div>
      <div class="key-stats__row"><span class="label">Public Float</span><span class="value">${formatNum(c.shares_in_float)}</span></div>
      <div class="key-stats__row"><span class="label">P/E Ratio</span><span class="value">${peRatio ? formatNum(peRatio) : 'N/A'}</span></div>
      <div class="key-stats__row"><span class="label">52-Week High</span><span class="value">${formatNum(c.high52w)}</span></div>
      <div class="key-stats__row"><span class="label">52-Week Low</span><span class="value">${formatNum(c.low52w)}</span></div>
      <div class="key-stats__row"><span class="label">Beta</span><span class="value">${formatNum(c.fundamental_beta)}</span></div>
    `;
  }

  async function loadCandles() {
    try {
      candles = await api('/api/exchange/companies/' + ticker + '/candles?interval=' + chartInterval + '&limit=100');
      drawChart();
    } catch(e) {}
  }

  function drawChart() {
    const svg = document.getElementById('chart-svg');
    if (!svg || !candles.length) return;

    const w = 600, h = 260, pad = { top: 20, right: 12, bottom: 30, left: 52 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;

    // Use OHLC for range
    const highs = candles.map(c => c.high ?? c.close);
    const lows  = candles.map(c => c.low ?? c.close);
    const min = Math.min(...lows) * 0.999;
    const max = Math.max(...highs) * 1.001;
    const range = max - min || 1;

    const yFor = v => pad.top + ph - ((v - min) / range) * ph;

    // Grid lines + labels
    let gridLines = '';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ph * i / 4);
      const val = max - ((range * i) / 4);
      gridLines += `<line x1="${pad.left}" y1="${y}" x2="${w - pad.right}" y2="${y}" stroke="var(--slate-line)" stroke-width="0.5"/>`;
      gridLines += `<text x="${pad.left - 6}" y="${y + 4}" text-anchor="end" font-family="var(--font-mono)" font-size="9" fill="var(--slate-soft)">${val.toFixed(2)}</text>`;
    }

    // Candle geometry
    const slotW = pw / (candles.length + 1);
    const bodyW = Math.max(slotW * 0.6, 1.5);
    const tooltipW = 130, tooltipH = 60;

    let candleEls = '';
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const open  = c.open  ?? c.close;
      const high  = c.high  ?? c.close;
      const low   = c.low   ?? c.close;
      const close = c.close;
      const bullish = close >= open;
      const color = bullish ? '#2e8e96' : '#b04040'; // teal-bright / crimson-bright

      const cx = pad.left + slotW * (i + 0.5);
      const yOpen  = yFor(open);
      const yClose = yFor(close);
      const yHigh  = yFor(high);
      const yLow   = yFor(low);
      const bodyTop = Math.min(yOpen, yClose);
      const bodyH = Math.max(Math.abs(yOpen - yClose), 0.5);

      // Wick
      candleEls += `<line x1="${cx}" y1="${yHigh}" x2="${cx}" y2="${yLow}" stroke="${color}" stroke-width="1" opacity="0.7"/>`;
      // Body
      candleEls += `<rect x="${cx - bodyW/2}" y="${bodyTop}" width="${bodyW}" height="${bodyH}" fill="${color}" stroke="${color}" stroke-width="0.5"/>`;

      // Tooltip trigger (invisible overlay)
      const tooltipY = Math.max(yHigh - tooltipH - 8, 2);
      const tooltipX = Math.min(Math.max(cx - tooltipW/2, 2), w - tooltipW - 2);
      candleEls += `<g class="candle-tip" style="pointer-events:none;opacity:0;transition:opacity 0.12s;">
        <rect x="${tooltipX}" y="${tooltipY}" width="${tooltipW}" height="${tooltipH}" rx="6" fill="var(--ink)" stroke="var(--slate-line)" stroke-width="1"/>
        <text x="${tooltipX + 8}" y="${tooltipY + 16}" font-family="var(--font-mono)" font-size="9.5" fill="var(--slate-soft)">O ${formatNum(open)}  H ${formatNum(high)}</text>
        <text x="${tooltipX + 8}" y="${tooltipY + 34}" font-family="var(--font-mono)" font-size="9.5" fill="var(--slate-soft)">L ${formatNum(low)}  C ${formatNum(close)}</text>
        <text x="${tooltipX + 8}" y="${tooltipY + 50}" font-family="var(--font-mono)" font-size="9" fill="${color}">Vol ${formatNum(c.volume)}</text>
      </g>`;
      // Invisible wider hit area for hover
      candleEls += `<rect x="${cx - slotW/2}" y="${yHigh}" width="${slotW}" height="${yLow - yHigh}" fill="transparent"
        onmouseenter="this.previousElementSibling.style.opacity='1'"
        onmouseleave="this.previousElementSibling.style.opacity='0'"/>`;
    }

    // Moving average overlay (5-period)
    let maPoints = '';
    for (let i = 4; i < candles.length; i++) {
      const sum = candles.slice(i - 4, i + 1).reduce((s, c) => s + (c.close || 0), 0);
      const avg = sum / 5;
      const cx = pad.left + slotW * (i + 0.5);
      const cy = yFor(avg);
      maPoints += `${cx},${cy} `;
    }
    if (maPoints.trim()) {
      maPoints = `<polyline points="${maPoints.trim()}" fill="none" stroke="var(--gold-dim)" stroke-width="1.2" stroke-dasharray="4,3" stroke-linejoin="round" stroke-linecap="round" opacity="0.6"/>`;
    }

    svg.innerHTML = `
      <rect x="0" y="0" width="600" height="260" fill="none" />
      ${gridLines}
      ${maPoints}
      ${candleEls}
    `;
  }

  async function loadOrderBook() {
    try {
      const book = await api('/api/exchange/companies/' + ticker + '/orderbook');
      const asks = (book.asks || []).sort((a, b) => b.limit_price - a.limit_price);
      const bids = (book.bids || []).sort((a, b) => a.limit_price - b.limit_price);

      const el = document.getElementById('orderbook-content');
      let html = asks.map(r => `<div class="orderbook__row ask"><span>${formatNum(r.limit_price)}</span><span>${r.total_qty}</span></div>`).join('');
      html += `<div class="orderbook__separator">${formatNum(company.current_price || '—')}</div>`;
      html += bids.map(r => `<div class="orderbook__row bid"><span>${formatNum(r.limit_price)}</span><span>${r.total_qty}</span></div>`).join('');
      if (!html.trim()) html = '<div class="empty-state">No orders yet</div>';
      el.innerHTML = html;
    } catch(e) {}
  }

  async function loadTrades() {
    try {
      const trades = await api('/api/exchange/companies/' + ticker + '/trades');
      const el = document.getElementById('recent-trades-list');
      el.innerHTML = trades.length ? trades.slice(0, 15).map(t => `
        <div class="recent-trades__row">
          <span>${formatNum(t.quantity)} @ ${formatNum(t.price)}</span>
          <span style="font-size:10px;color:var(--slate-soft);">${new Date(t.executed_at).toLocaleTimeString()}</span>
        </div>
      `).join('') : '<div class="empty-state">No trades recorded</div>';
    } catch(e) {}
  }

  async function loadShareholders() {
    try {
      const holders = await api('/api/exchange/companies/' + ticker + '/shareholders');
      const el = document.getElementById('shareholders-list');
      el.innerHTML = holders.length ? holders.slice(0, 10).map(h => `
        <div class="key-stats__row">
          <span class="label">${esc(h.account_id)}</span>
          <span class="value">${formatNum(h.quantity)} (${h.pct_owned}%)</span>
        </div>
      `).join('') : '<div class="empty-state">No shareholders</div>';
    } catch(e) {}
  }

  async function loadMyPosition() {
    if (!me) return;
    try {
      const data = await api('/api/exchange/portfolio');
      const holding = (data.holdings || []).find(h => h.ticker === ticker);
      const el = document.getElementById('my-position-section');
      if (holding) {
        el.innerHTML = `
          <div class="my-position">
            <h3>My Position</h3>
            <div class="key-stats__row"><span class="label">Shares</span><span class="value">${formatNum(holding.quantity)}</span></div>
            <div class="key-stats__row"><span class="label">Avg Cost</span><span class="value">${formatNum(holding.average_cost)}</span></div>
            <div class="key-stats__row"><span class="label">Market Value</span><span class="value">${formatNum(holding.currentValue)}</span></div>
            <div class="key-stats__row"><span class="label" style="color:${holding.unrealizedPnl >= 0 ? 'var(--teal-bright)' : 'var(--crimson-bright)'}">P/L</span>
              <span class="value" style="color:${holding.unrealizedPnl >= 0 ? 'var(--teal-bright)' : 'var(--crimson-bright)'}">${formatNum(holding.unrealizedPnl)} (${holding.unrealizedPnlPct}%)</span></div>
          </div>
        `;
      }
    } catch(e) {}
  }

  function attachEventListeners() {
    // Chart interval tabs
    document.querySelectorAll('.co-chart__tab').forEach(btn => {
      btn.addEventListener('click', async () => {
        chartInterval = btn.dataset.interval;
        document.querySelectorAll('.co-chart__tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        await loadCandles();
      });
    });

    if (!me) return;

    // Order form tabs
    document.querySelectorAll('.order-form__tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.order-form__tab').forEach(b => {
          b.classList.remove('active', 'buy', 'sell');
        });
        btn.classList.add('active', btn.dataset.side === 'BUY' ? 'buy' : 'sell');
        updateOrderButton();
      });
    });

    // Order type change
    document.getElementById('order-type').addEventListener('change', () => {
      const type = document.getElementById('order-type').value;
      document.getElementById('limit-price-field').style.display = (type === 'MARKET') ? 'none' : '';
      document.getElementById('stop-price-field').style.display = (type === 'STOP_LOSS' || type === 'STOP_LIMIT') ? '' : 'none';
    });

    // Quantity change -> estimate
    ['limit-price', 'order-qty', 'stop-price'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', updateEstimate);
    });

    // Submit
    document.getElementById('order-submit').addEventListener('click', submitOrder);
  }

  function getSide() {
    return document.querySelector('.order-form__tab.active')?.dataset?.side || 'BUY';
  }

  function updateOrderButton() {
    const btn = document.getElementById('order-submit');
    const side = getSide();
    btn.textContent = 'Place ' + side + ' Order';
    btn.className = 'order-form__submit ' + (side === 'BUY' ? 'buy' : 'sell');
  }

  function updateEstimate() {
    const price = parseFloat(document.getElementById('limit-price').value) || (company.current_price || 0);
    const qty = parseInt(document.getElementById('order-qty').value) || 0;
    const feeRate = 0.005;
    const total = price * qty;
    const fee = total * feeRate;

    document.getElementById('order-estimate').innerHTML = total > 0
      ? `Est. Cost: <span>${formatNum(total + fee)}</span> (${formatNum(qty)} × ${formatNum(price)} + ${formatNum(fee)} fee)`
      : 'Enter quantity and price to see estimate';
  }

  async function submitOrder() {
    const msg = document.getElementById('order-msg');
    msg.style.display = 'none';

    const side = getSide();
    const orderType = document.getElementById('order-type').value;
    const limitPrice = orderType !== 'MARKET' ? parseFloat(document.getElementById('limit-price').value) || null : null;
    const stopPrice = (orderType === 'STOP_LOSS' || orderType === 'STOP_LIMIT') ? parseFloat(document.getElementById('stop-price').value) || null : null;
    const qty = parseInt(document.getElementById('order-qty').value);

    if (!qty || qty <= 0) {
      msg.textContent = 'Enter a valid quantity.'; msg.style.display = 'block'; return;
    }

    try {
      const body = { ticker, side, order_type: orderType, quantity: qty, limit_price: limitPrice, stop_price: stopPrice };
      const r = await fetch('/api/exchange/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      msg.style.display = 'block';
      if (r.ok) {
        msg.style.color = 'var(--teal-bright)';
        msg.textContent = 'Order placed! ID #' + data.id + ' — ' + data.status;
        loadOrderBook();
        loadMyPosition();
      } else {
        msg.style.color = '#e3a3a3';
        msg.textContent = data.error || 'Order failed.';
      }
    } catch(e) {
      msg.style.display = 'block';
      msg.style.color = '#e3a3a3';
      msg.textContent = 'Network error.';
    }
  }

  init();
})();
