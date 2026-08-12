// IPO JS for Fiducia Exchange
(function () {
  'use strict';

  let me = null;
  let mySubs = [];

  function formatNum(n) { return n != null ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'; }
  function esc(s) { return (s || '').replace(/[<>&\"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  async function api(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(r.status); return r.json(); }

  async function init() {
    try { me = await api('/api/auth/me'); } catch(e) { me = null; }
    try { mySubs = await api('/api/exchange/ipo/my'); } catch(e) { mySubs = []; }
    await loadIpos();
  }

  async function loadIpos() {
    try {
      const data = await api('/api/exchange/ipo');
      const active = data.active || [];
      const past = data.past || [];
      render(active, past);
    } catch(e) {
      document.getElementById('app').innerHTML = '<div class="exchange-header"><h1 class="exchange-title">IPOs</h1></div><div class="empty-state">Could not load IPOs.</div>';
    }
  }

  function render(active, past) {
    document.getElementById('app').innerHTML = `
      <div class="exchange-header">
        <div>
          <h1 class="exchange-title">Initial Public Offerings</h1>
          <p class="exchange-subtitle">Subscribe to upcoming companies before they list</p>
        </div>
      </div>

      ${!me ? '<div class="auth-notice">Sign in to subscribe to IPOs. <a href="../../admin/">Go to admin panel</a> to log in.</div>' : ''}

      <h2 style="font-family:var(--font-display);font-size:20px;font-weight:600;color:var(--parchment);margin-bottom:14px;">Active IPOs</h2>
      ${active.length ? active.map(ipo => renderIpoCard(ipo)).join('') : '<div class="empty-state">No active IPOs at this time.</div>'}

      <h2 style="font-family:var(--font-display);font-size:20px;font-weight:600;color:var(--parchment);margin:32px 0 14px;">Past IPOs</h2>
      ${past.length ? `
      <div class="ex-table-wrap">
        <table class="ex-table">
          <thead><tr><th>Ticker</th><th>Name</th><th>IPO Price</th><th>Current</th><th>Return</th><th>Status</th></tr></thead>
          <tbody>
            ${past.map(ipo => {
              const retClass = (ipo.returnPct || 0) >= 0 ? 'up' : 'down';
              const arrow = (ipo.returnPct || 0) >= 0 ? '▲' : '▼';
              return `<tr onclick="location.href='../company/view.html?ticker=${ipo.ticker}'" style="cursor:pointer;">
                <td class="td-ticker">${ipo.ticker}</td>
                <td>${esc(ipo.name)}</td>
                <td>${formatNum(ipo.ipo_price)}</td>
                <td>${formatNum(ipo.current_price)}</td>
                <td class="td-change ${retClass}">${arrow} ${ipo.returnPct != null ? formatNum(Math.abs(ipo.returnPct)) + '%' : '—'}</td>
                <td><span class="status-badge ${ipo.status}">${ipo.status}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ` : '<div class="empty-state">No past IPOs.</div>'}
    `;

    attachHandlers();
  }

  function renderIpoCard(ipo) {
    const mySub = mySubs.find(s => s.company_id === ipo.id);
    const fillPct = ipo.shares_in_float > 0 ? Math.min(100, (ipo.total_subscribed / ipo.shares_in_float) * 100) : 0;
    const overClass = fillPct >= 100 ? 'over' : '';

    return `
      <div class="ipo-card">
        <div class="ipo-card__info">
          <div class="ipo-card__ticker">${ipo.ticker}</div>
          <div class="ipo-card__name">${esc(ipo.name)} <span style="font-size:11px;color:var(--slate-soft);">${ipo.sector}</span></div>
          <div class="ipo-card__meta">
            IPO Price: <span>${formatNum(ipo.ipo_price)}</span> &nbsp;|&nbsp;
            Shares Offered: <span>${formatNum(ipo.shares_in_float)}</span> &nbsp;|&nbsp;
            Subscribed: <span>${formatNum(ipo.total_subscribed)}</span>
            ${ipo.oversubscription ? `<span class="ipo-oversub"> (${ipo.oversubscription}x oversubscribed!)</span>` : ''}
          </div>
          <div class="ipo-progress">
            <div class="ipo-progress__bar ${overClass}" style="width:${fillPct}%;"></div>
          </div>
          ${mySub ? `<div class="ipo-my-sub">Your subscription: ${mySub.quantity} shares</div>` : ''}
        </div>
        <div class="ipo-card__action">
          ${me ? `
            <div class="ipo-sub-form">
              <input id="sub-qty-${ipo.id}" type="number" min="1" placeholder="Qty" value="${mySub ? mySub.quantity : ''}" />
              <button class="ipo-sub-btn" data-sub-ipo="${ipo.id}" data-ipo-price="${ipo.ipo_price}" data-ipo-ticker="${ipo.ticker}">
                ${mySub ? 'Update' : 'Subscribe'}
              </button>
            </div>
            <div id="sub-msg-${ipo.id}" style="font-family:var(--font-mono);font-size:10px;margin-top:4px;"></div>
            ${mySub ? `<button class="ipo-cancel-btn" data-cancel-ipo="${ipo.id}">Cancel Subscription</button>` : ''}
            <div style="font-family:var(--font-mono);font-size:10px;color:var(--slate-soft);">
              Est. cost: ${formatNum(ipo.ipo_price * (mySub ? mySub.quantity : 0))}
            </div>
          ` : '<div style="font-family:var(--font-mono);font-size:11px;color:var(--slate-soft);">Sign in to subscribe</div>'}
        </div>
      </div>
    `;
  }

  function attachHandlers() {
    document.querySelectorAll('[data-sub-ipo]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.subIpo;
        const qtyEl = document.getElementById('sub-qty-' + id);
        const qty = parseInt(qtyEl.value);
        const msgEl = document.getElementById('sub-msg-' + id);
        const ticker = btn.dataset.ipoTicker;

        if (!qty || qty <= 0) { msgEl.textContent = 'Enter a quantity.'; msgEl.style.color = '#e3a3a3'; return; }

        try {
          const r = await fetch('/api/exchange/ipo/' + id + '/subscribe', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity: qty }),
          });
          const d = await r.json();
          if (r.ok) {
            msgEl.textContent = `Subscribed ${qty} shares of ${ticker}!`;
            msgEl.style.color = 'var(--teal-bright)';
            mySubs = await api('/api/exchange/ipo/my');
            loadIpos();
          } else {
            msgEl.textContent = d.error;
            msgEl.style.color = '#e3a3a3';
          }
        } catch(e) { msgEl.textContent = 'Network error.'; msgEl.style.color = '#e3a3a3'; }
      });
    });

    document.querySelectorAll('[data-cancel-ipo]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.cancelIpo;
        try {
          await fetch('/api/exchange/ipo/' + id + '/subscribe', { method: 'DELETE' });
          mySubs = await api('/api/exchange/ipo/my');
          loadIpos();
        } catch(e) { /* ignore */ }
      });
    });
  }

  init();
})();
