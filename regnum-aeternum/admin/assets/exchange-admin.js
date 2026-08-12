// Fiducia Exchange — Admin Panel JS
window.ExchangeAdmin = (function () {
  'use strict';

  let me = null;
  let isAdmin = false;
  let companiesCache = [];
  let hasBanker = false;

  function formatNum(n) { return n != null ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'; }
  function esc(s) { return (s || '').replace(/[<>&\"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  function statusBadge(s) {
    const label = s === 'ipo' ? 'offering' : s;
    return `<span class="status-badge ${s}">${label}</span>`;
  }

  async function init(user) {
    me = user;
    isAdmin = (me.role || '').split(',').map(r => r.trim()).includes('admin');
    hasBanker = (me.role || '').split(',').map(r => r.trim()).includes('banker');

    // Show/hide admin-only elements
    document.getElementById('exp-nav-settings').style.display = isAdmin ? '' : 'none';
    document.getElementById('exp-nav-reports').style.display = isAdmin ? '' : 'none';
    document.getElementById('exp-nav-oversight').style.display = isAdmin ? '' : 'none';
    document.getElementById('exp-nav-ipo').style.display = (isAdmin || hasBanker) ? '' : 'none';

    // Sub-tab switching
    document.querySelectorAll('[data-exp]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.banking-subnav__btn[data-exp]').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('#panel-exchange .banking-subpanel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('exp-' + btn.dataset.exp).classList.add('active');
        if (btn.dataset.exp === 'reports') loadReports();
        if (btn.dataset.exp === 'ipo') loadIpos();
      });
    });

    loadCompanies();
    loadDividends();
    loadHalts();
    loadAudit();
    if (isAdmin) loadSettings();

    // Basic handlers
    document.getElementById('exp-new-company-btn').addEventListener('click', openNewCompanyForm);
    document.getElementById('exp-div-declare').addEventListener('click', declareDividend);
    document.getElementById('exp-global-halt').addEventListener('click', globalHalt);
    document.getElementById('exp-global-resume').addEventListener('click', globalResume);
    if (isAdmin) document.getElementById('exp-settings-save').addEventListener('click', saveSettings);

    // Stock split handlers
    document.getElementById('exp-split-execute').addEventListener('click', executeSplit);
    document.getElementById('exp-split-cancel').addEventListener('click', () => {
      document.getElementById('exp-split-card').classList.remove('active');
    });

    // Delist handlers
    document.getElementById('exp-delist-execute').addEventListener('click', executeDelist);
    document.getElementById('exp-delist-cancel').addEventListener('click', () => {
      document.getElementById('exp-delist-card').classList.remove('active');
    });

    // Buyback handlers
    document.getElementById('exp-bb-count').addEventListener('input', updateBuybackEstimate);
    document.getElementById('exp-bb-execute').addEventListener('click', executeBuyback);
    document.getElementById('exp-bb-cancel').addEventListener('click', () => {
      document.getElementById('exp-buyback-card').classList.remove('active');
    });

    // Report handlers
    document.getElementById('exp-rep-submit').addEventListener('click', fileReport);

    // Offering handlers
    document.getElementById('exp-ipo-create').addEventListener('click', createIpo);
    document.getElementById('exp-ipo-allocate').addEventListener('click', allocateIpo);
    document.getElementById('exp-ipo-cancel').addEventListener('click', cancelIpo);
    document.getElementById('exp-ipo-subs-close').addEventListener('click', () => {
      document.getElementById('exp-ipo-subs-card').classList.remove('active');
    });
  }

  // ── Companies ──────────────────────────────────────────────────

  async function loadCompanies() {
    try {
      companiesCache = await (await fetch('/api/exchange/admin/companies')).json();
      document.getElementById('exp-companies-tbody').innerHTML = companiesCache.map(c => `
        <tr>
          <td><span style="font-family:var(--font-mono);color:var(--gold-bright);font-weight:600;">${c.ticker}</span></td>
          <td>${esc(c.name)}</td>
          <td>${c.sector}</td>
          <td>${formatNum(c.current_price)}</td>
          <td>${statusBadge(c.status)}</td>
          <td>
            <button class="a-btn" data-edit-co="${c.id}">Edit</button>
            ${c.status === 'active' ? `<button class="a-btn" data-halt-co="${c.id}">Halt</button>` : ''}
            ${c.status === 'halted' ? `<button class="a-btn primary" data-resume-co="${c.id}">Resume</button>` : ''}
            <button class="a-btn" data-issue-co="${c.id}">+Shares</button>
            <button class="a-btn" data-split-co="${c.id}" data-split-ticker="${c.ticker}">Split</button>
            <button class="a-btn" data-bb-co="${c.id}" data-bb-ticker="${c.ticker}" data-bb-price="${c.current_price}" data-bb-float="${c.shares_in_float}">Buyback</button>
            ${c.status !== 'delisted' ? `<button class="a-btn danger" data-delist-co="${c.id}" data-delist-ticker="${c.ticker}">Delist</button>` : ''}
          </td>
        </tr>
      `).join('');

      document.querySelectorAll('[data-halt-co]').forEach(b => b.addEventListener('click', () => haltCompany(b.dataset.haltCo)));
      document.querySelectorAll('[data-resume-co]').forEach(b => b.addEventListener('click', () => resumeCompany(b.dataset.resumeCo)));
      document.querySelectorAll('[data-edit-co]').forEach(b => b.addEventListener('click', () => openEditCompanyForm(b.dataset.editCo)));
      document.querySelectorAll('[data-split-co]').forEach(b => b.addEventListener('click', () => openSplitForm(b.dataset.splitCo, b.dataset.splitTicker)));
      document.querySelectorAll('[data-delist-co]').forEach(b => b.addEventListener('click', () => openDelistForm(b.dataset.delistCo, b.dataset.delistTicker)));
      document.querySelectorAll('[data-bb-co]').forEach(b => b.addEventListener('click', () => openBuybackForm(b.dataset.bbCo, b.dataset.bbTicker, b.dataset.bbPrice, b.dataset.bbFloat)));
      document.querySelectorAll('[data-issue-co]').forEach(b => b.addEventListener('click', () => {
        const count = prompt('How many shares to issue?');
        if (count) issueShares(b.dataset.issueCo, parseInt(count));
      }));
    } catch(e) { console.error('loadCompanies:', e); }
  }

  async function issueShares(id, count) {
    if (!count || count <= 0) return;
    try {
      const r = await fetch('/api/exchange/admin/companies/' + id + '/shares/issue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
      });
      if (r.ok) { loadCompanies(); }
      else { const d = await r.json(); alert(d.error); }
    } catch(e) { alert('Error issuing shares.'); }
  }

  function openNewCompanyForm() {
    const ticker = prompt('Ticker symbol (1-4 uppercase letters):');
    if (!ticker || !/^[A-Z]{1,4}$/.test(ticker.toUpperCase())) return alert('Invalid ticker.');
    const name = prompt('Company name:');
    if (!name) return;
    const sector = prompt('Sector (BANKING, TRADE, MINING, AGRICULTURE, SERVICES, MILITARY):');
    if (!sector) return;
    const ipoPrice = parseFloat(prompt('Offering price:') || '');
    if (!ipoPrice || ipoPrice <= 0) return alert('Invalid offering price.');

    createCompany(ticker.toUpperCase(), name, sector, ipoPrice);
  }

  async function createCompany(ticker, name, sector, ipoPrice) {
    try {
      const r = await fetch('/api/exchange/admin/companies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, name, sector, ipo_price: ipoPrice, total_shares: 1000000, shares_in_float: 750000 }),
      });
      if (!r.ok) { const d = await r.json(); alert(d.error); return; }
      loadCompanies();
    } catch(e) { alert('Error creating company.'); }
  }

  async function haltCompany(id) {
    const reason = prompt('Halt reason:') || 'Administrative halt';
    await fetch('/api/exchange/admin/companies/' + id + '/halt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    loadCompanies();
    loadHalts();
  }

  async function resumeCompany(id) {
    await fetch('/api/exchange/admin/companies/' + id + '/resume', { method: 'POST' });
    loadCompanies();
  }

  // ── Stock Split ────────────────────────────────────────────────

  function openSplitForm(id, ticker) {
    document.getElementById('exp-split-card').classList.add('active');
    document.getElementById('exp-split-heading').textContent = 'Stock Split — ' + ticker;
    document.getElementById('exp-split-ticker').value = ticker;
    document.getElementById('exp-split-num').value = '';
    document.getElementById('exp-split-den').value = '';
    document.getElementById('exp-split-msg').style.display = 'none';
    document.getElementById('exp-split-card').dataset.companyId = id;
    document.getElementById('exp-split-card').scrollIntoView({ behavior: 'smooth' });
  }

  async function executeSplit() {
    const id = document.getElementById('exp-split-card').dataset.companyId;
    const num = parseInt(document.getElementById('exp-split-num').value);
    const den = parseInt(document.getElementById('exp-split-den').value);
    const msg = document.getElementById('exp-split-msg');

    if (!num || !den || num <= 0 || den <= 0) {
      msg.textContent = 'Enter valid positive numbers for numerator and denominator.'; msg.className = 'a-msg error'; msg.style.display = 'block'; return;
    }
    if (num === den) { msg.textContent = 'Ratio cannot be 1:1.'; msg.className = 'a-msg error'; msg.style.display = 'block'; return; }

    try {
      const r = await fetch('/api/exchange/admin/companies/' + id + '/split', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratio_numerator: num, ratio_denominator: den }),
      });
      const d = await r.json();
      msg.style.display = 'block';
      if (r.ok) {
        msg.className = 'a-msg success';
        const dir = num > den ? 'forward' : 'reverse';
        msg.textContent = `${num}:${den} ${dir} split executed. New price: ${formatNum(d.current_price)}, Shares: ${formatNum(d.total_shares)}.`;
        loadCompanies();
      } else {
        msg.className = 'a-msg error'; msg.textContent = d.error;
      }
    } catch(e) { msg.className = 'a-msg error'; msg.textContent = 'Network error.'; msg.style.display = 'block'; }
  }

  // ── Delist ─────────────────────────────────────────────────────

  function openDelistForm(id, ticker) {
    document.getElementById('exp-delist-card').classList.add('active');
    document.getElementById('exp-delist-ticker').value = ticker;
    document.getElementById('exp-delist-reason').value = '';
    document.getElementById('exp-delist-msg').style.display = 'none';
    document.getElementById('exp-delist-card').dataset.companyId = id;
    document.getElementById('exp-delist-card').scrollIntoView({ behavior: 'smooth' });
  }

  async function executeDelist() {
    const id = document.getElementById('exp-delist-card').dataset.companyId;
    const reason = document.getElementById('exp-delist-reason').value || 'Voluntarily delisted';
    const msg = document.getElementById('exp-delist-msg');

    if (!confirm(`Are you sure you want to delist this company? All open orders will be cancelled.`)) return;

    try {
      const r = await fetch('/api/exchange/admin/companies/' + id + '/delist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      msg.style.display = 'block';
      if (r.ok) {
        msg.className = 'a-msg success'; msg.textContent = 'Company delisted.';
        document.getElementById('exp-delist-card').classList.remove('active');
        loadCompanies();
        loadHalts();
      } else {
        const d = await r.json();
        msg.className = 'a-msg error'; msg.textContent = d.error;
      }
    } catch(e) { msg.className = 'a-msg error'; msg.textContent = 'Network error.'; msg.style.display = 'block'; }
  }

  // ── Buyback ────────────────────────────────────────────────────

  function openBuybackForm(id, ticker, price, float) {
    document.getElementById('exp-buyback-card').classList.add('active');
    document.getElementById('exp-bb-ticker').value = ticker;
    document.getElementById('exp-bb-count').value = '';
    document.getElementById('exp-bb-estimate').textContent = '—';
    document.getElementById('exp-bb-msg').style.display = 'none';
    document.getElementById('exp-buyback-card').dataset.companyId = id;
    document.getElementById('exp-buyback-card').dataset.companyPrice = price;
    document.getElementById('exp-buyback-card').dataset.companyFloat = float;
    document.getElementById('exp-buyback-card').scrollIntoView({ behavior: 'smooth' });
  }

  function updateBuybackEstimate() {
    const price = parseFloat(document.getElementById('exp-buyback-card').dataset.companyPrice) || 0;
    const count = parseInt(document.getElementById('exp-bb-count').value) || 0;
    document.getElementById('exp-bb-estimate').textContent = count > 0 ? formatNum(price * count) : '—';
  }

  async function executeBuyback() {
    const id = document.getElementById('exp-buyback-card').dataset.companyId;
    const count = parseInt(document.getElementById('exp-bb-count').value);
    const msg = document.getElementById('exp-bb-msg');

    if (!count || count <= 0) {
      msg.textContent = 'Enter a positive number of shares.'; msg.className = 'a-msg error'; msg.style.display = 'block'; return;
    }

    try {
      const r = await fetch('/api/exchange/admin/companies/' + id + '/shares/buyback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
      });
      const d = await r.json();
      msg.style.display = 'block';
      if (r.ok) {
        msg.className = 'a-msg success';
        msg.textContent = `${count} shares bought back. Cost: ${formatNum(d.cost)}. Remaining float: ${formatNum(d.shares_in_float)}.`;
        document.getElementById('exp-buyback-card').classList.remove('active');
        loadCompanies();
      } else {
        msg.className = 'a-msg error'; msg.textContent = d.error;
      }
    } catch(e) { msg.className = 'a-msg error'; msg.textContent = 'Network error.'; msg.style.display = 'block'; }
  }

  // ── Dividends ──────────────────────────────────────────────────

  async function loadDividends() {
    try {
      const divs = await (await fetch('/api/exchange/admin/dividends?status=pending')).json();
      document.getElementById('exp-dividends-tbody').innerHTML = divs.length ? divs.map(d => `
        <tr>
          <td style="font-family:var(--font-mono);color:var(--gold-bright);">${d.ticker}</td>
          <td>${formatNum(d.dividend_per_share)}</td>
          <td>${d.pay_date}</td>
          <td>${statusBadge(d.status)}</td>
          <td><button class="a-btn danger" data-cancel-div="${d.id}">Cancel</button></td>
        </tr>
      `).join('') : '<tr><td colspan="5" style="color:var(--slate-soft);">No pending dividends.</td></tr>';

      document.querySelectorAll('[data-cancel-div]').forEach(b => b.addEventListener('click', async () => {
        await fetch('/api/exchange/admin/dividends/' + b.dataset.cancelDiv, { method: 'DELETE' });
        loadDividends();
      }));
    } catch(e) {}
  }

  async function declareDividend() {
    const ticker = document.getElementById('exp-div-ticker').value.toUpperCase();
    const amount = parseFloat(document.getElementById('exp-div-amount').value);
    const payDate = document.getElementById('exp-div-paydate').value;
    const msg = document.getElementById('exp-div-msg');

    if (!ticker || !amount || !payDate) {
      msg.textContent = 'All fields required.'; msg.className = 'a-msg error'; msg.style.display = 'block'; return;
    }

    try {
      const r = await fetch('/api/exchange/admin/dividends', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, dividend_per_share: amount, pay_date: payDate }),
      });
      if (r.ok) {
        msg.textContent = 'Dividend declared.'; msg.className = 'a-msg success'; msg.style.display = 'block';
        document.getElementById('exp-div-ticker').value = '';
        document.getElementById('exp-div-amount').value = '';
        document.getElementById('exp-div-paydate').value = '';
        loadDividends();
      } else {
        const d = await r.json();
        msg.textContent = d.error; msg.className = 'a-msg error'; msg.style.display = 'block';
      }
    } catch(e) {}
  }

  // ── Oversight ──────────────────────────────────────────────────

  async function loadHalts() {
    try {
      const halts = await (await fetch('/api/exchange/admin/halts')).json();
      document.getElementById('exp-halts-tbody').innerHTML = halts.length ? halts.map(h => `
        <tr>
          <td>${h.ticker || '—'}</td>
          <td>${h.halt_type}</td>
          <td>${esc(h.reason || '')}</td>
          <td style="font-size:10px;">${new Date(h.halted_at).toLocaleString()}</td>
        </tr>
      `).join('') : '<tr><td colspan="4" style="color:var(--slate-soft);">No halts recorded.</td></tr>';

      // Also load flagged orders
      const flagged = await (await fetch('/api/exchange/admin/flagged/orders')).json();
      const fel = document.getElementById('exp-flagged-orders');
      fel.innerHTML = flagged.length ? `<table class="a-table"><thead><tr><th>ID</th><th>Ticker</th><th>Account</th><th>Side</th><th>Reason</th><th></th></tr></thead><tbody>
        ${flagged.map(o => `<tr>
          <td>${o.id}</td><td>${o.ticker}</td><td>${esc(o.player_name)}</td><td>${o.side}</td><td style="color:var(--crimson-bright);">${esc(o.flag_reason || '')}</td>
          <td><button class="a-btn" data-dismiss-flag="${o.id}">Dismiss</button></td>
        </tr>`).join('')}
      </tbody></table>` : '<p style="color:var(--slate-soft);font-size:13px;">No flagged orders.</p>';

      document.querySelectorAll('[data-dismiss-flag]').forEach(b => b.addEventListener('click', async () => {
        await fetch('/api/exchange/admin/flagged/orders/' + b.dataset.dismissFlag + '/dismiss', { method: 'POST' });
        loadHalts();
      }));
    } catch(e) {}
  }

  async function globalHalt() {
    const reason = prompt('Reason for global halt:') || 'Administrative halt';
    await fetch('/api/exchange/admin/halt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    loadCompanies();
    loadHalts();
  }

  async function globalResume() {
    await fetch('/api/exchange/admin/resume', { method: 'POST' });
    loadCompanies();
    loadHalts();
  }

  // ── Reports ────────────────────────────────────────────────────

  async function loadReports() {
    try {
      const reports = await (await fetch('/api/exchange/admin/reports')).json();
      document.getElementById('exp-reports-tbody').innerHTML = reports.length ? reports.map(r => `
        <tr>
          <td style="font-family:var(--font-mono);color:var(--gold-bright);">${r.ticker}</td>
          <td>${r.report_type}</td>
          <td>${esc(r.headline)}</td>
          <td>${esc(r.filed_by)}</td>
          <td style="font-size:10px;">${new Date(r.filed_at).toLocaleDateString()}</td>
          <td>
            <button class="a-btn" data-toggle-rep="${r.id}">View</button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="6" style="color:var(--slate-soft);">No reports filed.</td></tr>';

      document.querySelectorAll('[data-toggle-rep]').forEach(b => {
        b.addEventListener('click', () => {
          const rep = reports.find(r => r.id == b.dataset.toggleRep);
          if (rep) alert('Report: ' + rep.headline + '\n\n' + (rep.body || '(no body)'));
        });
      });
    } catch(e) { console.error('loadReports:', e); }
  }

  async function fileReport() {
    const ticker = document.getElementById('exp-rep-ticker').value.toUpperCase();
    const reportType = document.getElementById('exp-rep-type').value;
    const period = document.getElementById('exp-rep-period').value;
    const headline = document.getElementById('exp-rep-headline').value;
    const bodyText = document.getElementById('exp-rep-body').value;
    const earningsChange = parseFloat(document.getElementById('exp-rep-earnings').value) || null;
    const revenueChange = parseFloat(document.getElementById('exp-rep-revenue').value) || null;
    const assetsChange = parseFloat(document.getElementById('exp-rep-assets').value) || null;
    const msg = document.getElementById('exp-rep-msg');

    if (!ticker || !headline) {
      msg.textContent = 'Ticker and headline are required.'; msg.className = 'a-msg error'; msg.style.display = 'block'; return;
    }

    try {
      const r = await fetch('/api/exchange/admin/reports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, report_type: reportType, period_label: period, headline, body_text: bodyText, earnings_change: earningsChange, revenue_change: revenueChange, assets_change: assetsChange }),
      });
      msg.style.display = 'block';
      if (r.ok) {
        msg.className = 'a-msg success'; msg.textContent = 'Report filed.';
        document.getElementById('exp-rep-ticker').value = '';
        document.getElementById('exp-rep-headline').value = '';
        document.getElementById('exp-rep-body').value = '';
        loadReports();
      } else {
        const d = await r.json();
        msg.className = 'a-msg error'; msg.textContent = d.error;
      }
    } catch(e) { msg.className = 'a-msg error'; msg.textContent = 'Network error.'; msg.style.display = 'block'; }
  }

  // ── Audit Log ──────────────────────────────────────────────────

  async function loadAudit() {
    try {
      const log = await (await fetch('/api/exchange/admin/audit?limit=100')).json();
      document.getElementById('exp-audit-tbody').innerHTML = log.map(l => `
        <tr>
          <td>${esc(l.actor)}</td>
          <td>${l.action}</td>
          <td>${l.entity_type || ''} ${l.entity_id || ''}</td>
          <td style="font-size:10px;">${new Date(l.performed_at).toLocaleString()}</td>
        </tr>
      `).join('');
    } catch(e) {}
  }

  // ── Settings ───────────────────────────────────────────────────

  async function loadSettings() {
    try {
      const settings = await (await fetch('/api/exchange/admin/settings')).json();
      const form = document.getElementById('exp-settings-form');
      form.innerHTML = Object.entries(settings).map(([k, v]) => `
        <div class="a-field"><label>${k}</label><input class="a-input exp-setting-input" data-key="${k}" value="${esc(String(v))}" style="width:100%;"/></div>
      `).join('');
    } catch(e) {}
  }

  async function saveSettings() {
    const inputs = document.querySelectorAll('.exp-setting-input');
    const body = {};
    inputs.forEach(inp => { body[inp.dataset.key] = inp.value; });

    try {
      const r = await fetch('/api/exchange/admin/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const msg = document.getElementById('exp-settings-msg');
      msg.style.display = 'block';
      if (r.ok) { msg.className = 'a-msg success'; msg.textContent = 'Settings saved.'; }
      else { msg.className = 'a-msg error'; msg.textContent = 'Failed to save.'; }
    } catch(e) {}
  }

  // ── Offerings ───────────────────────────────────────────────────────

  async function loadIpos() {
    try {
      const data = await (await fetch('/api/exchange/ipo')).json();
      const active = data.active || [];
      const past = data.past || [];

      document.getElementById('exp-ipo-tbody').innerHTML = active.length ? active.map(ipo => `
        <tr>
          <td style="font-family:var(--font-mono);color:var(--gold-bright);font-weight:600;">${ipo.ticker}</td>
          <td>${esc(ipo.name)}</td>
          <td>${formatNum(ipo.ipo_price)}</td>
          <td>${formatNum(ipo.shares_in_float)}</td>
          <td>${formatNum(ipo.total_subscribed)} ${ipo.oversubscription ? `<span style="color:var(--crimson-bright);">(${formatNum(ipo.oversubscription)}x)</span>` : ''}</td>
          <td>${statusBadge(ipo.status)}</td>
          <td>
            <button class="a-btn primary" data-view-ipo="${ipo.id}" data-ipo-ticker="${ipo.ticker}">Manage</button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="7" style="color:var(--slate-soft);">No active offerings.</td></tr>';

      document.getElementById('exp-ipo-past-tbody').innerHTML = past.length ? past.map(ipo => {
        const retClass = (ipo.returnPct || 0) >= 0 ? 'var(--teal-bright)' : 'var(--crimson-bright)';
        return `<tr>
          <td style="font-family:var(--font-mono);color:var(--gold-bright);">${ipo.ticker}</td>
          <td>${esc(ipo.name)}</td>
          <td>${formatNum(ipo.ipo_price)}</td>
          <td>${formatNum(ipo.current_price)}</td>
          <td style="color:${retClass};">${ipo.returnPct != null ? (ipo.returnPct >= 0 ? '+' : '') + formatNum(ipo.returnPct) + '%' : '—'}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="5" style="color:var(--slate-soft);">No past offerings.</td></tr>';

      document.querySelectorAll('[data-view-ipo]').forEach(b => b.addEventListener('click', () => openIpoSubs(b.dataset.viewIpo, b.dataset.ipoTicker)));
    } catch(e) { console.error('loadIpos:', e); }
  }

  async function createIpo() {
    const ticker = document.getElementById('exp-ipo-ticker').value.toUpperCase();
    const name = document.getElementById('exp-ipo-name').value;
    const sector = document.getElementById('exp-ipo-sector').value;
    const ipoPrice = parseFloat(document.getElementById('exp-ipo-price').value);
    const msg = document.getElementById('exp-ipo-create-msg');

    if (!ticker || !name || !sector || !ipoPrice) {
      msg.textContent = 'All fields required.'; msg.className = 'a-msg error'; msg.style.display = 'block'; return;
    }
    if (!/^[A-Z]{1,4}$/.test(ticker)) { msg.textContent = 'Invalid ticker.'; msg.className = 'a-msg error'; msg.style.display = 'block'; return; }

    try {
      const r = await fetch('/api/exchange/admin/companies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, name, sector, ipo_price: ipoPrice, total_shares: 1000000, shares_in_float: 750000, status: 'ipo' }),
      });
      msg.style.display = 'block';
      if (r.ok) {
        msg.className = 'a-msg success'; msg.textContent = 'Offering created. Players can now subscribe.';
        document.getElementById('exp-ipo-ticker').value = '';
        document.getElementById('exp-ipo-name').value = '';
        document.getElementById('exp-ipo-sector').value = '';
        document.getElementById('exp-ipo-price').value = '';
        loadIpos();
        loadCompanies();
      } else {
        const d = await r.json();
        msg.className = 'a-msg error'; msg.textContent = d.error;
      }
    } catch(e) { msg.className = 'a-msg error'; msg.textContent = 'Network error.'; msg.style.display = 'block'; }
  }

  async function openIpoSubs(id, ticker) {
    try {
      const data = await (await fetch('/api/exchange/admin/companies/' + id + '/ipo/subscriptions')).json();
      const co = data.company;
      const subs = data.subscriptions || [];

      document.getElementById('exp-ipo-subs-card').classList.add('active');
      document.getElementById('exp-ipo-subs-heading').textContent = 'Offering Subscriptions — ' + ticker;
      document.getElementById('exp-ipo-subs-msg').style.display = 'none';
      document.getElementById('exp-ipo-subs-card').dataset.ipoId = id;

      document.getElementById('exp-ipo-subs-content').innerHTML = `
        <p style="margin:0 0 12px;">
          Float: <span style="color:var(--parchment);">${formatNum(co.shares_in_float)}</span> |
          Subscribed: <span style="color:var(--parchment);">${formatNum(co.total_subscribed)}</span> |
          Remaining: <span style="color:${data.oversubscribed ? 'var(--crimson-bright)' : 'var(--teal-bright)'};">${formatNum(data.remaining)}</span>
          ${data.oversubscribed ? '<span style="color:var(--crimson-bright);"> (Oversubscribed!)</span>' : ''}
        </p>
        ${subs.length ? `<table class="a-table"><thead><tr><th>Account</th><th>Player</th><th>Quantity</th><th>Placed</th></tr></thead><tbody>
          ${subs.map(s => `<tr><td>${esc(s.account_id).substring(0,8)}...</td><td>${esc(s.player_name)}</td><td>${s.quantity}</td><td style="font-size:10px;">${new Date(s.placed_at).toLocaleString()}</td></tr>`).join('')}
        </tbody></table>` : '<p style="color:var(--slate-soft);">No subscriptions yet.</p>'}
      `;
      document.getElementById('exp-ipo-subs-card').scrollIntoView({ behavior: 'smooth' });
    } catch(e) { console.error('openIpoSubs:', e); }
  }

  async function allocateIpo() {
    const id = document.getElementById('exp-ipo-subs-card').dataset.ipoId;
    const msg = document.getElementById('exp-ipo-subs-msg');

    if (!confirm('Allocate shares and activate trading? This will debit subscribers and issue shares.')) return;

    try {
      const r = await fetch('/api/exchange/admin/companies/' + id + '/ipo/allocate', { method: 'POST' });
      const d = await r.json();
      msg.style.display = 'block';
      if (r.ok) {
        msg.className = 'a-msg success';
        msg.textContent = `IPO allocated! ${d.subscribers} subscribers, ${formatNum(d.allocated)} shares allocated.${d.oversubscribed ? ' Was oversubscribed — scaled pro-rata.' : ''}`;
        document.getElementById('exp-ipo-subs-card').classList.remove('active');
        loadIpos();
        loadCompanies();
      } else {
        msg.className = 'a-msg error'; msg.textContent = d.error;
      }
    } catch(e) { msg.className = 'a-msg error'; msg.textContent = 'Network error.'; msg.style.display = 'block'; }
  }

  async function cancelIpo() {
    const id = document.getElementById('exp-ipo-subs-card').dataset.ipoId;
    const msg = document.getElementById('exp-ipo-subs-msg');

    if (!confirm('Cancel this IPO? All subscriptions will be cancelled and the company delisted.')) return;

    try {
      const r = await fetch('/api/exchange/admin/companies/' + id + '/ipo/cancel', { method: 'POST' });
      const d = await r.json();
      msg.style.display = 'block';
      if (r.ok) {
        msg.className = 'a-msg success'; msg.textContent = 'IPO cancelled.';
        document.getElementById('exp-ipo-subs-card').classList.remove('active');
        loadIpos();
        loadCompanies();
      } else {
        msg.className = 'a-msg error'; msg.textContent = d.error;
      }
    } catch(e) { msg.className = 'a-msg error'; msg.textContent = 'Network error.'; msg.style.display = 'block'; }
  }

  return { init };
})();
