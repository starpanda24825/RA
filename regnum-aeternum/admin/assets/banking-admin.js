/* ============================================================
   Regnum Aeternum — Banking Admin Panel
   Lazy-loaded IIFE, attached to window.BankingAdmin.
   Called by admin/index.html when the Banking tab is activated.
   ============================================================ */
(function () {
  'use strict';

  /* ── Helpers ───────────────────────────────────────────────── */
  function hasRole(user, role) {
    if (!user || !user.role) return false;
    return (user.role || '').split(',').map(function (r) { return r.trim(); }).indexOf(role) !== -1;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'style') e.setAttribute('style', attrs[k]);
      else if (k === 'type') e.setAttribute('type', attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    if (text != null) e.textContent = text;
    return e;
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(path, opts)
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }

  function typePill(t) {
    return '<span class="account-type-pill account-type-pill--' + t + '">' + t + '</span>';
  }

  function msgEl(id) { var e = document.getElementById(id); return { show: function (cls, text) { e.className = 'a-msg ' + cls; e.textContent = text; e.style.display = 'block'; }, hide: function () { e.style.display = 'none'; } }; }

  /* ── State ─────────────────────────────────────────────────── */
  var user = null;
  var isAdmin = false;
  var isBanker = false;
  var allAccountsCache = [];

  function esc(v) { return escapeHtml(v); }

  /* ── Sub-navigation ────────────────────────────────────────── */
  var subNavs = null;
  var subPanels = null;

  function initSubNav() {
    subNavs = document.querySelectorAll('.banking-subnav__btn');
    subPanels = document.querySelectorAll('.banking-subpanel');
    subNavs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        subNavs.forEach(function (b) { b.classList.remove('active'); });
        subPanels.forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        var panelId = 'bp-' + btn.dataset.bp;
        var panel = document.getElementById(panelId);
        if (panel) panel.classList.add('active');
        onSubPanelActivate(btn.dataset.bp);
      });
    });
  }

  /* ── Modal helper ──────────────────────────────────────────── */
  function showModal(title, bodyHtml, onClose) {
    var existing = document.querySelector('.banking-modal-backdrop');
    if (existing) existing.remove();
    var backdrop = el('div', { class: 'banking-modal-backdrop' });
    var modalInner = '<button class="banking-modal__close" id="bmodal-close">&times;</button>' +
      '<h3>' + esc(title) + '</h3>' + bodyHtml;
    var modal = el('div', { class: 'banking-modal' });
    modal.innerHTML = modalInner;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    document.getElementById('bmodal-close').addEventListener('click', function () {
      backdrop.remove();
      if (onClose) onClose();
    });
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) { backdrop.remove(); if (onClose) onClose(); } });
    return backdrop;
  }

  /* ── Panel activation dispatcher ───────────────────────────── */
  function onSubPanelActivate(bp) {
    switch (bp) {
      case 'accounts':    loadAccounts(); break;
      case 'transactions': loadTransactions(); break;
      case 'cards':       break; // requires account selection
      case 'settings':    if (isAdmin) loadSettings(); break;
      case 'treasuries':  if (isAdmin) loadTreasuries(); break;
      case 'bankers':     if (isAdmin) loadBankerAssignments(); break;
      case 'companies':   if (isAdmin) loadCompanies(); break;
      case 'taxes':       if (isAdmin) loadTaxStatus(); break;
      case 'cc-tokens':   if (isAdmin) loadCCTokens(); break;
    }
  }

  /* ════════════════════════════════════════════════════════════
     ACCOUNTS SUB-PANEL
     ════════════════════════════════════════════════════════════ */
  function loadAccounts(filters) {
    filters = filters || {};
    var params = new URLSearchParams();
    if (filters.type) params.set('type', filters.type);
    if (filters.treasury) params.set('treasury', filters.treasury);
    if (filters.frozen !== undefined) params.set('frozen', String(filters.frozen));
    if (filters.search) params.set('search', filters.search);
    var qs = params.toString();
    api('/api/banking/admin/accounts' + (qs ? '?' + qs : ''))
      .then(function (res) {
        if (!res.ok) return;
        allAccountsCache = res.data;
        renderAccountsTable(res.data);
      });
  }

  function renderAccountsTable(accounts) {
    var tbody = document.getElementById('bp-accounts-tbody');
    if (!tbody) return;
    tbody.innerHTML = accounts.map(function (a) {
      return '<tr>' +
        '<td style="font-family:var(--font-mono);font-size:11.5px;">' + esc(a.key) + '</td>' +
        '<td>' + esc(a.name) + '</td>' +
        '<td>' + typePill(a.type) + '</td>' +
        '<td style="font-family:var(--font-mono);">$' + Number(a.balance).toLocaleString() + '</td>' +
        '<td>' + (a.treasury_key ? '<span class="treasury-tag">' + esc(a.treasury_key) + '</span>' : '—') + '</td>' +
        '<td>' + (a.frozen ? '<span class="frozen-badge">&#128274; FROZEN</span>' : 'Active') + '</td>' +
        '<td>' +
          '<button class="a-btn" data-ba-edit="' + esc(a.key) + '">Edit</button>' +
          '<button class="a-btn" data-ba-freeze="' + esc(a.key) + '">' + (a.frozen ? 'Unfreeze' : 'Freeze') + '</button>' +
          (isAdmin && a.type !== 'treasury' ? '<button class="a-btn danger" data-ba-del="' + esc(a.key) + '">Delete</button>' : '') +
        '</td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-ba-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { openAccountEditor(btn.dataset.baEdit); });
    });
    tbody.querySelectorAll('[data-ba-freeze]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var acc = accounts.find(function (a) { return a.key === btn.dataset.baFreeze; });
        freezeAccount(btn.dataset.baFreeze, !(acc && acc.frozen));
      });
    });
    tbody.querySelectorAll('[data-ba-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Delete account ' + btn.dataset.baDel + ' permanently?')) return;
        deleteAccount(btn.dataset.baDel);
      });
    });
  }

  function openAccountEditor(key) {
    var editing = key ? allAccountsCache.find(function (a) { return a.key === key; }) : null;
    var formHtml = '<div style="display:flex;flex-direction:column;gap:12px;">';
    if (!editing) {
      // Type selector (personal / company only; treasury handled in Treasuries tab)
      formHtml += '<div class="a-field"><label>Type</label><select class="a-select" id="bae-type" style="width:100%;">' +
        '<option value="personal">Personal</option><option value="company">Company</option>' +
        '</select></div>';
      // Personal: web user search dropdown (name + password come from web account)
      formHtml += '<div class="a-field" id="bae-personal-fields"><label>Linked Web User</label>' +
        '<input class="a-input" id="bae-user-search" placeholder="Search registered users…" autocomplete="off" style="width:100%;margin-bottom:4px;"/>' +
        '<select class="a-select" id="bae-user-id" size="5" style="width:100%;font-family:var(--font-mono);font-size:12px;"></select>' +
        '</div>';
      // Company: manual name field
      formHtml += '<div class="a-field" id="bae-company-fields" style="display:none;"><label>Account Name</label><input class="a-input" id="bae-name" style="width:100%;"/></div>';
      formHtml += '<div class="a-field"><label>Color</label><input class="a-input" id="bae-color" type="number" value="16384" style="width:100px;"/></div>';
      formHtml += '<div class="a-form" id="bae-co-extra" style="gap:10px;display:none;">' +
        '<div class="a-field"><label>Owner Key</label><input class="a-input" id="bae-ownerkey" style="width:220px;"/></div>' +
        '<div class="a-field"><label>Shares</label><input class="a-input" id="bae-shares" type="number" value="0" style="width:100px;"/></div>' +
        '</div>';
    } else {
      formHtml += '<div class="a-field"><label>Name</label><input class="a-input" id="bae-name" style="width:100%;" value="' + esc(editing.name) + '"/></div>';
      formHtml += '<div class="a-field"><label>Color</label><input class="a-input" id="bae-color" type="number" style="width:100px;" value="' + (editing.color || 16384) + '"/></div>';
      if (editing.type === 'treasury') {
        formHtml += '<div class="a-field"><label>Tag</label><input class="a-input" id="bae-tag" style="width:80px;" maxlength="4" value="' + esc(editing.tag || '') + '"/></div>';
      }
      if (editing.type === 'company') {
        formHtml += '<div class="a-field"><label>Shares</label><input class="a-input" id="bae-shares" type="number" style="width:100px;" value="' + (editing.shares || 0) + '"/></div>';
      }
      formHtml += '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--parchment-dim);cursor:pointer;">' +
        '<input type="checkbox" id="bae-frozen" ' + (editing.frozen ? 'checked' : '') + '/> Frozen</label>';
    }
    formHtml += '<div style="display:flex;gap:8px;margin-top:8px;">' +
      '<button class="a-btn primary" id="bae-save-btn">' + (editing ? 'Save' : 'Create') + '</button>' +
      '<button class="a-btn" id="bae-cancel-btn">Cancel</button>' +
      '</div><p id="bae-msg" class="a-msg" style="display:none;"></p></div>';

    var modal = showModal(editing ? 'Edit Account — ' + editing.key : 'New Account', formHtml);

    var typeSel = document.getElementById('bae-type');
    var personalF = document.getElementById('bae-personal-fields');
    var companyF  = document.getElementById('bae-company-fields');
    var coExtra   = document.getElementById('bae-co-extra');
    var userSearchEl = document.getElementById('bae-user-search');
    var userIdEl = document.getElementById('bae-user-id');
    var allUsers = [];

    if (typeSel) {
      function toggleTypeFields() {
        var isCo = typeSel.value === 'company';
        if (personalF) personalF.style.display = isCo ? 'none' : '';
        if (companyF)  companyF.style.display  = isCo ? '' : 'none';
        if (coExtra)   coExtra.style.display   = isCo ? 'flex' : 'none';
      }
      typeSel.addEventListener('change', toggleTypeFields);
      toggleTypeFields();
    }

    // Load web users for the personal account dropdown
    if (!editing) {
      api('/api/admin/users').then(function (res) {
        if (!res.ok) return;
        allUsers = res.data || [];
        renderUserOptions('');
      });

      function renderUserOptions(filter) {
        var f = (filter || '').toLowerCase();
        var filtered = allUsers.filter(function (u) {
          return !f || u.username.toLowerCase().indexOf(f) !== -1;
        });
        if (userIdEl) {
          userIdEl.innerHTML = filtered.map(function (u) {
            return '<option value="' + u.id + '">' + esc(u.username) + ' (' + esc(u.role || '') + ')</option>';
          }).join('');
        }
      }

      if (userSearchEl) {
        userSearchEl.addEventListener('input', function () {
          renderUserOptions(userSearchEl.value);
        });
      }
    }

    document.getElementById('bae-cancel-btn').addEventListener('click', function () { modal.remove(); });
    document.getElementById('bae-save-btn').addEventListener('click', function () {
      var msg = msgEl('bae-msg');
      var body = { color: Number(document.getElementById('bae-color').value) || 16384 };
      if (!editing) {
        body.type = typeSel.value;
        if (body.type === 'personal') {
          var selUserId = userIdEl ? userIdEl.value : '';
          if (!selUserId) { msg.show('error', 'Please select a web user for the personal account.'); return; }
          body.userId = Number(selUserId);
          // Backend uses web username as account name and copies password hash
        } else {
          body.name = document.getElementById('bae-name').value;
          body.ownerKey = document.getElementById('bae-ownerkey').value;
          body.shares = Number(document.getElementById('bae-shares').value) || 0;
          if (!body.name) { msg.show('error', 'Account name is required.'); return; }
        }
      } else {
        body.name = document.getElementById('bae-name').value;
        body.frozen = document.getElementById('bae-frozen') ? document.getElementById('bae-frozen').checked : false;
        if (editing.type === 'company') body.shares = Number(document.getElementById('bae-shares').value) || 0;
        if (editing.type === 'treasury') body.tag = document.getElementById('bae-tag').value;
      }
      var method = editing ? 'PUT' : 'POST';
      var url = editing ? '/api/banking/admin/accounts/' + encodeURIComponent(editing.key) : '/api/banking/admin/accounts';
      api(url, { method: method, body: JSON.stringify(body) }).then(function (res) {
        if (!res.ok) { msg.show('error', res.data.error || 'Could not save.'); return; }
        msg.show('success', 'Saved.');
        modal.remove();
        loadAccounts();
      });
    });
  }

  function deleteAccount(key) {
    api('/api/banking/admin/accounts/' + encodeURIComponent(key) + '?force=true', { method: 'DELETE' })
      .then(function (res) {
        if (!res.ok) { alert(res.data.error || 'Could not delete.'); return; }
        loadAccounts();
      });
  }

  function freezeAccount(key, frozen) {
    api('/api/banking/admin/accounts/' + encodeURIComponent(key) + '/freeze', {
      method: 'PUT', body: JSON.stringify({ frozen: frozen })
    }).then(function () { loadAccounts(); });
  }

  function $safe(id) { return document.getElementById(id); }

  function bindEvt(id, event, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
  }

  bindEvt('ba-accounts-filter', 'input', function () { loadAccounts({ search: this.value }); });
  bindEvt('new-ba-account-btn', 'click', function () { openAccountEditor(null); });

  /* ════════════════════════════════════════════════════════════
     TRANSACTIONS SUB-PANEL
     ════════════════════════════════════════════════════════════ */
  function loadTransactions() {
    api('/api/banking/admin/accounts?limit=200').then(function (res) {
      if (!res.ok) return;
      var accounts = res.data;
      var fromSel = document.getElementById('ba-tx-from');
      var toSel = document.getElementById('ba-tx-to');
      var fineSel = document.getElementById('ba-fine-account');
      var opts = accounts.map(function (a) { return '<option value="' + esc(a.key) + '">' + esc(a.key) + ' — ' + esc(a.name) + '</option>'; }).join('');
      fromSel.innerHTML = '<option value="">Select source…</option>' + opts;
      toSel.innerHTML = '<option value="">Select destination…</option>' + opts;
      fineSel.innerHTML = '<option value="">Select account…</option>' + opts;
    });
  }

  bindEvt('ba-tx-submit', 'click', function () {
    var fromKey = ($safe('ba-tx-from') || {}).value;
    var toKey = document.getElementById('ba-tx-to').value;
    var amount = document.getElementById('ba-tx-amount').value;
    var desc = document.getElementById('ba-tx-desc').value;
    var txMsg = msgEl('ba-tx-msg');
    if (!fromKey || !toKey || !amount) { txMsg.show('error', 'From, To, and Amount are required.'); return; }
    api('/api/banking/admin/transaction', {
      method: 'POST',
      body: JSON.stringify({ fromKey: fromKey, toKey: toKey, amount: Number(amount), description: desc })
    }).then(function (res) {
      if (!res.ok) { txMsg.show('error', res.data.error || 'Transaction failed.'); return; }
      txMsg.show('success', 'Transaction complete.');
      document.getElementById('ba-tx-amount').value = '';
      document.getElementById('ba-tx-desc').value = '';
    });
  });

  bindEvt('ba-fine-submit', 'click', function () {
    var accountKey = ($safe('ba-fine-account') || {}).value;
    var amount = document.getElementById('ba-fine-amount').value;
    var desc = document.getElementById('ba-fine-desc').value;
    var fineMsg = msgEl('ba-fine-msg');
    if (!accountKey || !amount) { fineMsg.show('error', 'Account and Amount are required.'); return; }
    api('/api/banking/admin/fine', {
      method: 'POST',
      body: JSON.stringify({ accountKey: accountKey, amount: Number(amount), description: desc || 'Fine' })
    }).then(function (res) {
      if (!res.ok) { fineMsg.show('error', res.data.error || 'Fine failed.'); return; }
      fineMsg.show('success', 'Fine applied.');
      document.getElementById('ba-fine-amount').value = '';
    });
  });

  /* ════════════════════════════════════════════════════════════
     CARDS SUB-PANEL
     ════════════════════════════════════════════════════════════ */
  function loadCardsForAccount() {
    var key = document.getElementById('ba-cards-account-key').value.trim();
    if (!key) return;
    document.getElementById('ba-cards-msg').style.display = 'none';
    api('/api/banking/admin/accounts/' + encodeURIComponent(key) + '/cards').then(function (res) {
      if (!res.ok) { msgEl('ba-cards-msg').show('error', res.data.error || 'Could not load cards.'); return; }
      renderCardsTable(res.data, key);
    });
  }

  function renderCardsTable(cards, accountKey) {
    var tbody = document.getElementById('ba-cards-tbody');
    tbody.innerHTML = cards.map(function (c) {
      return '<tr>' +
        '<td style="font-family:var(--font-mono);">' + esc(c.cardId) + '</td>' +
        '<td><span class="a-pill a-pill--' + (c.status === 'active' ? 'editor' : 'citizen') + '">' + esc(c.status) + '</span></td>' +
        '<td>' + esc(c.created_at || '') + '</td>' +
        '<td>' +
          (c.status === 'active' ? '<button class="a-btn" data-bc-cancel="' + esc(c.cardId) + '">Cancel</button>' : '') +
          (isAdmin ? '<button class="a-btn danger" data-bc-del="' + esc(c.cardId) + '">Delete</button>' : '') +
        '</td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-bc-cancel]').forEach(function (btn) {
      btn.addEventListener('click', function () { cancelCard(accountKey, btn.dataset.bcCancel); });
    });
    tbody.querySelectorAll('[data-bc-del]').forEach(function (btn) {
      btn.addEventListener('click', function () { deleteCard(accountKey, btn.dataset.bcDel); });
    });
  }

  function issueCard(accountKey) {
    api('/api/banking/admin/accounts/' + encodeURIComponent(accountKey) + '/cards', { method: 'POST' })
      .then(function (res) {
        if (!res.ok) { msgEl('ba-cards-msg').show('error', res.data.error || 'Could not issue card.'); return; }
        msgEl('ba-cards-msg').show('success', 'Card issued: ' + res.data.cardId);
        loadCardsForAccount();
      });
  }

  function cancelCard(accountKey, cardId) {
    if (!confirm('Cancel card ' + cardId + '?')) return;
    api('/api/banking/admin/accounts/' + encodeURIComponent(accountKey) + '/cards/' + encodeURIComponent(cardId) + '/cancel', { method: 'PUT' })
      .then(function () { loadCardsForAccount(); });
  }

  function deleteCard(accountKey, cardId) {
    if (!confirm('Permanently delete card ' + cardId + '?')) return;
    api('/api/banking/admin/accounts/' + encodeURIComponent(accountKey) + '/cards/' + encodeURIComponent(cardId), { method: 'DELETE' })
      .then(function () { loadCardsForAccount(); });
  }

  bindEvt('ba-cards-load', 'click', loadCardsForAccount);
  bindEvt('ba-cards-issue', 'click', function () {
    var key = document.getElementById('ba-cards-account-key').value.trim();
    if (!key) { msgEl('ba-cards-msg').show('error', 'Enter an account key first.'); return; }
    issueCard(key);
  });

  /* ════════════════════════════════════════════════════════════
     SETTINGS SUB-PANEL (admin only)
     ════════════════════════════════════════════════════════════ */
  function loadSettings() {
    if (!isAdmin) return;
    api('/api/banking/admin/settings').then(function (res) {
      if (!res.ok) return;
      var s = res.data;
      document.getElementById('ba-cumulative-limit').value = s.cumulative_limit || '';
      document.getElementById('ba-cumulative-price').value = s.cumulative_price || '';
      document.getElementById('ba-bank-owner-key').value = s.bank_owner_key || '';
      document.getElementById('ba-tax-enabled').checked = !!s.tax_enabled;
      document.getElementById('ba-tax-rate-personal').value = s.tax_rate_personal || 0;
      document.getElementById('ba-tax-rate-company').value = s.tax_rate_company || 0;
      document.getElementById('ba-tax-threshold').value = s.tax_threshold || 0;
      document.getElementById('ba-tax-period').value = s.tax_period_days || 7;
      var cp = s.currency_prices || {};
      var cpEl = document.getElementById('ba-currency-prices');
      if (cpEl) cpEl.value = JSON.stringify(cp, null, 2);
    });
  }

  bindEvt('ba-settings-save', 'click', function () {
    if (!isAdmin) return;
    var cpVal = {};
    try { cpVal = JSON.parse(document.getElementById('ba-currency-prices').value || '{}'); } catch (e) { }
    var body = {
      cumulative_limit: Number(document.getElementById('ba-cumulative-limit').value) || 0,
      cumulative_price: Number(document.getElementById('ba-cumulative-price').value) || 0,
      bank_owner_key: document.getElementById('ba-bank-owner-key').value.trim(),
      tax_enabled: document.getElementById('ba-tax-enabled').checked,
      tax_rate_personal: Number(document.getElementById('ba-tax-rate-personal').value) || 0,
      tax_rate_company: Number(document.getElementById('ba-tax-rate-company').value) || 0,
      tax_threshold: Number(document.getElementById('ba-tax-threshold').value) || 0,
      tax_period_days: Number(document.getElementById('ba-tax-period').value) || 7,
      currency_prices: cpVal
    };
    api('/api/banking/admin/settings', { method: 'PUT', body: JSON.stringify(body) }).then(function (res) {
      msgEl('ba-settings-msg').show(res.ok ? 'success' : 'error', res.ok ? 'Settings saved.' : (res.data.error || 'Could not save.'));
    });
  });

  /* ════════════════════════════════════════════════════════════
     TREASURIES SUB-PANEL (admin only)
     ════════════════════════════════════════════════════════════ */
  function loadTreasuries() {
    if (!isAdmin) return;
    api('/api/banking/admin/treasuries').then(function (res) {
      if (!res.ok) return;
      var tbody = document.getElementById('ba-treasuries-tbody');
      tbody.innerHTML = res.data.map(function (t) {
        return '<tr>' +
          '<td style="font-family:var(--font-mono);">' + esc(t.key) + '</td>' +
          '<td>' + esc(t.name) + '</td>' +
          '<td><span class="treasury-tag">' + esc(t.tag || '') + '</span></td>' +
          '<td>' + esc(t.created_at || '') + '</td>' +
          '<td>' +
            '<button class="a-btn" data-bt-edit="' + esc(t.key) + '">Edit</button>' +
            '<button class="a-btn danger" data-bt-del="' + esc(t.key) + '">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('');
      tbody.querySelectorAll('[data-bt-edit]').forEach(function (btn) {
        btn.addEventListener('click', function () { openTreasuryEditor(btn.dataset.btEdit); });
      });
      tbody.querySelectorAll('[data-bt-del]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('Delete treasury ' + btn.dataset.btDel + '? This cannot be undone.')) return;
          api('/api/banking/admin/treasuries/' + encodeURIComponent(btn.dataset.btDel) + '?force=true', { method: 'DELETE' })
            .then(function (res) {
              if (!res.ok) { alert(res.data.error || 'Could not delete treasury.'); return; }
              loadTreasuries();
            });
        });
      });
    });
  }

  function openTreasuryEditor(key) {
    var formHtml = '<div style="display:flex;flex-direction:column;gap:12px;">' +
      '<div class="a-field"><label>Name</label><input class="a-input" id="btre-name" style="width:100%;"/></div>' +
      '<div class="a-field"><label>Tag (2-4 letters)</label><input class="a-input" id="btre-tag" style="width:80px;" maxlength="4"/></div>' +
      '<div class="a-field"><label>Password</label><input class="a-input" id="btre-password" type="password" style="width:200px;"/></div>' +
      '<div class="a-field"><label>Color</label><input class="a-input" id="btre-color" type="number" value="16384" style="width:100px;"/></div>' +
      '<div style="display:flex;gap:8px;margin-top:8px;">' +
        '<button class="a-btn primary" id="btre-save-btn">Create</button>' +
        '<button class="a-btn" id="btre-cancel-btn">Cancel</button>' +
      '</div><p id="btre-msg" class="a-msg" style="display:none;"></p></div>';
    showModal('New Treasury', formHtml);
    document.getElementById('btre-cancel-btn').addEventListener('click', function () {
      document.querySelector('.banking-modal-backdrop').remove();
    });
    document.getElementById('btre-save-btn').addEventListener('click', function () {
      var body = {
        name: document.getElementById('btre-name').value,
        tag: document.getElementById('btre-tag').value,
        password: document.getElementById('btre-password').value,
        color: Number(document.getElementById('btre-color').value) || 16384
      };
      if (!body.name || !body.tag || !body.password) { msgEl('btre-msg').show('error', 'All fields required.'); return; }
      api('/api/banking/admin/treasuries', { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
        if (!res.ok) { msgEl('btre-msg').show('error', res.data.error || 'Could not create.'); return; }
        msgEl('btre-msg').show('success', 'Treasury created. Key: ' + res.data.key);
        loadTreasuries();
      });
    });
  }

  bindEvt('new-ba-treasury-btn', 'click', function () { openTreasuryEditor(); });

  /* ════════════════════════════════════════════════════════════
     BANKER ASSIGNMENTS SUB-PANEL (admin only)
     ════════════════════════════════════════════════════════════ */
  function loadBankerAssignments() {
    if (!isAdmin) return;
    Promise.all([
      api('/api/banking/admin/banker-assignments'),
      api('/api/admin/users'),
      api('/api/banking/admin/treasuries')
    ]).then(function (results) {
      var assignments = results[0].ok ? results[0].data : [];
      var users = results[1].ok ? results[1].data : [];
      var treasuries = results[2].ok ? results[2].data : [];

      var bankerUsers = users.filter(function (u) { return hasRole(u, 'banker'); });
      var table = document.getElementById('ba-bankers-tbody');
      table.innerHTML = assignments.map(function (a) {
        return '<tr>' +
          '<td>' + esc(a.username || 'User #' + a.user_id) + '</td>' +
          '<td><span class="treasury-tag">' + esc(a.treasury_name || a.treasury_key) + '</span></td>' +
          '<td>' + esc(a.assigned_at || '') + '</td>' +
          '<td><button class="a-btn danger" data-bba-remove="' + a.user_id + '">Remove</button></td>' +
        '</tr>';
      }).join('');

      table.querySelectorAll('[data-bba-remove]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('Remove banker assignment for user #' + btn.dataset.bbaRemove + '?')) return;
          api('/api/banking/admin/banker-assignments/' + btn.dataset.bbaRemove, { method: 'DELETE' })
            .then(function () { loadBankerAssignments(); });
        });
      });

      var assignUserSel = document.getElementById('ba-banker-user');
      assignUserSel.innerHTML = '<option value="">Select banker…</option>' +
        bankerUsers.map(function (u) { return '<option value="' + u.id + '">' + esc(u.username) + '</option>'; }).join('');
    });
  }

  bindEvt('ba-banker-assign', 'click', function () {
    if (!isAdmin) return;
    var userId = document.getElementById('ba-banker-user').value;
    var treasuryKey = document.getElementById('ba-banker-treasury').value;
    if (!userId || !treasuryKey) { msgEl('ba-bankers-msg').show('error', 'Select a banker and treasury.'); return; }
    api('/api/banking/admin/banker-assignments/' + userId, {
      method: 'PUT', body: JSON.stringify({ treasuryKey: treasuryKey })
    }).then(function (res) {
      if (!res.ok) { msgEl('ba-bankers-msg').show('error', res.data.error || 'Could not assign.'); return; }
      msgEl('ba-bankers-msg').show('success', 'Banker assigned.');
      loadBankerAssignments();
    });
  });

  /* ════════════════════════════════════════════════════════════
     COMPANIES SUB-PANEL (admin only)
     ════════════════════════════════════════════════════════════ */
  function loadCompanies() {
    if (!isAdmin) return;
    api('/api/banking/admin/companies').then(function (res) {
      if (!res.ok) return;
      var tbody = document.getElementById('ba-companies-tbody');
      tbody.innerHTML = res.data.map(function (c) {
        return '<tr>' +
          '<td>' + esc(c.name) + '</td>' +
          '<td style="font-family:var(--font-mono);">$' + Number(c.balance).toLocaleString() + '</td>' +
          '<td>' + (c.shares || 0) + '</td>' +
          '<td style="font-family:var(--font-mono);">$' + (c.pricePerShare || 0).toFixed(2) + '</td>' +
          '<td>' + esc(c.owner_key || '—') + '</td>' +
          '<td>' +
            '<button class="a-btn" data-bco-view="' + esc(c.key) + '">View</button>' +
            '<button class="a-btn" data-bco-issue="' + esc(c.key) + '">Issue Shares</button>' +
          '</td>' +
        '</tr>';
      }).join('');

      tbody.querySelectorAll('[data-bco-view]').forEach(function (btn) {
        btn.addEventListener('click', function () { viewCompany(btn.dataset.bcoView); });
      });
      tbody.querySelectorAll('[data-bco-issue]').forEach(function (btn) {
        btn.addEventListener('click', function () { openIssueShares(btn.dataset.bcoIssue); });
      });
    });
  }

  function viewCompany(key) {
    Promise.all([
      api('/api/banking/admin/accounts/' + encodeURIComponent(key)),
      api('/api/banking/admin/companies/' + encodeURIComponent(key) + '/shareholders')
    ]).then(function (results) {
      var company = results[0].ok ? results[0].data : null;
      var shareholders = results[1].ok ? results[1].data : [];
      if (!company) return;

      var totalShares = company.shares || 1;
      var shHtml = shareholders.map(function (sh) {
        var pct = totalShares > 0 ? Math.round((sh.shares / totalShares) * 100) : 0;
        return '<div class="shareholder-row">' +
          '<span class="shareholder-row__name">' + esc(sh.name || sh.holder_key) + '</span>' +
          '<div style="flex:1;min-width:100px;"><div class="share-bar"><div class="share-bar__fill" style="width:' + pct + '%;"></div></div></div>' +
          '<span class="shareholder-row__pct">' + sh.shares + ' (' + pct + '%)</span>' +
        '</div>';
      }).join('');

      var body = '<div class="balance-display">$' + Number(company.balance).toLocaleString() + '</div>' +
        '<p style="font-family:var(--font-mono);font-size:11px;color:var(--slate-soft);margin:4px 0 16px;">' +
          esc(company.key) + ' · ' + esc(company.type) + ' · ' + esc(company.name) +
        '</p>' +
        '<h4 style="font-family:var(--font-display);font-size:15px;color:var(--parchment);margin:0 0 10px;">Shareholders</h4>' +
        (shHtml || '<p style="color:var(--slate-soft);">No shareholders yet.</p>');
      showModal(company.name, body);
    });
  }

  function openIssueShares(companyKey) {
    api('/api/banking/admin/companies/' + encodeURIComponent(companyKey)).then(function (res) {
      // Use accounts list for buyer selection
    });
    api('/api/banking/admin/accounts?type=personal&limit=100').then(function (res) {
      var accounts = res.ok ? res.data : [];
      var buyerOpts = accounts.map(function (a) { return '<option value="' + esc(a.key) + '">' + esc(a.key) + ' — ' + esc(a.name) + '</option>'; }).join('');
      var formHtml = '<div style="display:flex;flex-direction:column;gap:12px;">' +
        '<div class="a-field"><label>Company</label><input class="a-input" value="' + esc(companyKey) + '" disabled style="width:100%;"/></div>' +
        '<div class="a-field"><label>Issuer Key (company owner)</label><input class="a-input" id="bis-issuer" style="width:100%;"/></div>' +
        '<div class="a-field"><label>Buyer</label><select class="a-select" id="bis-buyer" style="width:100%;">' + buyerOpts + '</select></div>' +
        '<div class="a-field"><label>Share Count</label><input class="a-input" id="bis-count" type="number" value="1" style="width:100px;"/></div>' +
        '<div style="display:flex;gap:8px;margin-top:8px;">' +
          '<button class="a-btn primary" id="bis-save-btn">Issue</button>' +
          '<button class="a-btn" id="bis-cancel-btn">Cancel</button>' +
        '</div><p id="bis-msg" class="a-msg" style="display:none;"></p></div>';
      showModal('Issue Shares — ' + companyKey, formHtml);
      document.getElementById('bis-cancel-btn').addEventListener('click', function () {
        document.querySelector('.banking-modal-backdrop').remove();
      });
      document.getElementById('bis-save-btn').addEventListener('click', function () {
        var body = {
          issuerKey: document.getElementById('bis-issuer').value,
          companyKey: companyKey,
          buyerKey: document.getElementById('bis-buyer').value,
          shareCount: Number(document.getElementById('bis-count').value)
        };
        api('/api/banking/admin/shares/issue', { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
          if (!res.ok) { msgEl('bis-msg').show('error', res.data.error || 'Could not issue.'); return; }
          msgEl('bis-msg').show('success', 'Shares issued.');
        });
      });
    });
  }

  /* ════════════════════════════════════════════════════════════
     TAXES SUB-PANEL (admin only)
     ════════════════════════════════════════════════════════════ */
  function loadTaxStatus() {
    if (!isAdmin) return;
    api('/api/banking/admin/settings').then(function (res) {
      if (!res.ok) return;
      var s = res.data;
      var statusEl = document.getElementById('ba-tax-status-card');
      statusEl.innerHTML =
        '<span class="tax-status-card__indicator tax-status-card__indicator--' + (s.tax_enabled ? 'enabled' : 'disabled') + '">' +
          (s.tax_enabled ? 'Taxes Active' : 'Taxes Paused') +
        '</span>' +
        '<span class="tax-status-card__stat">Personal Rate: <strong>' + (s.tax_rate_personal || 0) + '%</strong></span>' +
        '<span class="tax-status-card__stat">Company Rate: <strong>' + (s.tax_rate_company || 0) + '%</strong></span>' +
        '<span class="tax-status-card__stat">Threshold: <strong>$' + (s.tax_threshold || 0).toLocaleString() + '</strong></span>' +
        '<span class="tax-status-card__stat">Last Run: <strong>' + (s.tax_last_run_at ? new Date(s.tax_last_run_at).toLocaleString() : 'Never') + '</strong></span>';
    });
  }

  bindEvt('ba-taxes-run', 'click', function () {
    if (!isAdmin) return;
    if (!confirm('Run taxes now on all applicable accounts?')) return;
    api('/api/banking/admin/taxes/run', { method: 'POST' }).then(function (res) {
      if (!res.ok) { msgEl('ba-taxes-msg').show('error', res.data.error || 'Could not run taxes.'); return; }
      msgEl('ba-taxes-msg').show('success', res.data.totalCollected > 0
        ? 'Taxes applied to ' + res.data.applied + ' accounts. $' + res.data.totalCollected.toLocaleString() + ' collected.'
        : 'No accounts met the tax threshold.');
      loadTaxStatus();
    });
  });

  /* ════════════════════════════════════════════════════════════
     CC TOKENS SUB-PANEL (admin only)
     ════════════════════════════════════════════════════════════ */
  function loadCCTokens() {
    if (!isAdmin) return;
    api('/api/banking/admin/cc-tokens').then(function (res) {
      if (!res.ok) return;
      var grid = document.getElementById('ba-cctokens-grid');
      grid.innerHTML = res.data.map(function (t) {
        return '<div class="cc-token-card">' +
          '<span class="cc-token-card__type">' + esc(t.terminal_type) + '</span>' +
          '<span class="cc-token-card__label">' + esc(t.computer_label || 'Unlabelled') + '</span>' +
          '<div class="cc-token-card__meta">' +
            '<span>Last used: ' + (t.last_used_at ? new Date(t.last_used_at).toLocaleString() : 'Never') + '</span>' +
            (t.expires_at ? '<span>Expires: ' + new Date(t.expires_at).toLocaleString() + '</span>' : '') +
          '</div>' +
          '<button class="a-btn danger" data-bct-revoke="' + t.id + '" style="align-self:flex-start;">Revoke</button>' +
        '</div>';
      }).join('');
      grid.querySelectorAll('[data-bct-revoke]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('Revoke token #' + btn.dataset.bctRevoke + '?')) return;
          api('/api/banking/admin/cc-tokens/' + btn.dataset.bctRevoke, { method: 'DELETE' })
            .then(function () { loadCCTokens(); });
        });
      });
    });
  }

  bindEvt('ba-cctoken-issue', 'click', function () {
    if (!isAdmin) return;
    var type = document.getElementById('ba-cctoken-type').value;
    var label = document.getElementById('ba-cctoken-label').value;
    var treasury = document.getElementById('ba-cctoken-treasury').value;
    var body = { terminalType: type, computerLabel: label };
    if (type === 'admin') body.treasuryKey = treasury;

    api('/api/banking/admin/cc-tokens', { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
      if (!res.ok) { msgEl('ba-cctokens-msg').show('error', res.data.error || 'Could not issue token.'); return; }
      var secretHtml = '<p style="font-size:13px;color:var(--parchment-dim);margin:0 0 8px;">' +
        'This secret is shown <strong>once</strong>. Copy it now and store it securely — it cannot be recovered.</p>' +
        '<div class="banking-modal__secret">' + esc(res.data.secret) + '</div>' +
        '<button class="a-btn primary" id="bsecret-done" style="width:100%;margin-top:8px;">I Have Saved This</button>';
      showModal('CC Token Secret — ' + esc(res.data.terminalType), secretHtml, function () { loadCCTokens(); });
      document.getElementById('bsecret-done').addEventListener('click', function () {
        document.querySelector('.banking-modal-backdrop').remove();
        loadCCTokens();
      });
    });
  });

  /* ════════════════════════════════════════════════════════════
     INIT — called by admin/index.html
     ════════════════════════════════════════════════════════════ */
  window.BankingAdmin = {
    init: function (userData) {
      user = userData;
      isAdmin = hasRole(user, 'admin');
      isBanker = hasRole(user, 'banker');
      initSubNav();
    }
  };
})();
