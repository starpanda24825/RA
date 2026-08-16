/* ============================================================
   Regnum Aeternum — Public Banking Portal App
   Same style as auth-widget.js and banking-admin.js.
   ============================================================ */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  var account = null;    // banking account from /api/banking/me
  var user = null;       // web user from /api/auth/me
  var logPage = 0;
  var logLimit = 25;
  var logTotal = 0;
  var transferReady = false;
  var companyReady = false;
  var filtersReady = false;

  // ── Helpers ─────────────────────────────────────────────────
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          return { ok: r.ok, status: r.status, data: data };
        });
      });
  }

  function $(id) { return document.getElementById(id); }

  function fmt(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtInt(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  function fmtDate(d) {
    if (!d) return '';
    var dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' ' + dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function typePill(type) {
    var cls = 'bank-pill';
    if (type === 'company') cls += ' bank-pill--company';
    else if (type === 'treasury') cls += ' bank-pill--treasury';
    else cls += ' bank-pill--personal';
    return '<span class="' + cls + '">' + esc(type) + '</span>';
  }

  // ── View switching ─────────────────────────────────────────
  function showView(viewId) {
    ['bank-view-guest', 'bank-view-noaccount', 'bank-view-app'].forEach(function (id) {
      $(id).style.display = (id === viewId) ? '' : 'none';
    });
  }

  function showPanel(panelId) {
    document.querySelectorAll('.bank-panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('.bank-tab').forEach(function (t) { t.classList.remove('active'); });
    $(panelId).classList.add('active');
    var tab = document.querySelector('.bank-tab[data-tab="' + panelId.replace('bank-panel-', '') + '"]');
    if (tab) tab.classList.add('active');
  }

  // ── Init: auth check + routing ─────────────────────────────
  function init() {
    api('/api/auth/me').then(function (res) {
      if (!res.ok) {
        showView('bank-view-guest');
        return;
      }
      user = res.data;

      api('/api/banking/me').then(function (r) {
        if (r.status === 404) {
          showView('bank-view-noaccount');
          return;
        }
        if (!r.ok) {
          showView('bank-view-guest');
          return;
        }
        account = r.data;
        showView('bank-view-app');
        setupTabs();
        loadDashboard();
      });
    });
  }

  // ── Tab setup ──────────────────────────────────────────────
  function setupTabs() {
    // Show/hide conditional tabs
    // Portfolio tab: always show initially, hide only if API confirms empty
    $('bank-tab-portfolio').style.display = '';
    api('/api/banking/me/portfolio').then(function (r) {
      if (!r.ok || !r.data || r.data.length === 0) {
        $('bank-tab-portfolio').style.display = 'none';
      }
    });

    if (account.type === 'company') {
      $('bank-tab-company').style.display = '';
    }

    document.querySelectorAll('.bank-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var panelId = 'bank-panel-' + tab.dataset.tab;
        showPanel(panelId);

        if (tab.dataset.tab === 'dashboard') loadDashboard();
        else if (tab.dataset.tab === 'transfer') loadTransferForm();
        else if (tab.dataset.tab === 'log') loadTransactionLog(0);
        else if (tab.dataset.tab === 'portfolio') loadPortfolio();
        else if (tab.dataset.tab === 'company') loadCompanyView();
      });
    });

    // "View All" link on dashboard tx
    var viewAll = $('dash-tx-viewall');
    if (viewAll) {
      viewAll.addEventListener('click', function () {
        showPanel('bank-panel-log');
        loadTransactionLog(0);
      });
    }
  }

  // ── Dashboard ──────────────────────────────────────────────
  function reportCardLost(cardId) {
    if (!confirm('Report this card as lost? It will be cancelled immediately and a replacement will be requested for a banker to issue.')) return;
    api('/api/banking/me/cards/' + encodeURIComponent(cardId) + '/report-lost', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Reported lost by owner' })
    }).then(function (res) {
      if (!res.ok) { alert(res.data.error || 'Could not report card lost.'); return; }
      loadDashboard();
    });
  }

  function loadDashboard() {
    if (!account) return;
    $('bal-amount').textContent = fmt(account.balance);
    $('bal-name').textContent = account.name;
    $('bal-type-pill').innerHTML = typePill(account.type);
    var keyEl = $('bal-key');
    keyEl.textContent = account.key;
    keyEl.title = 'Click to copy account key';
    keyEl.addEventListener('click', function () {
      navigator.clipboard.writeText(account.key).catch(function () {});
    });

    // Load cards
    api('/api/banking/me/cards').then(function (r) {
      var list = $('dash-cards-list');
      var empty = $('dash-cards-empty');
      list.innerHTML = '';
      if (!r.ok || !r.data || r.data.length === 0) {
        empty.style.display = '';
        return;
      }
      empty.style.display = 'none';
      r.data.forEach(function (card) {
        var div = document.createElement('div');
        div.className = 'bank-card';
        div.style.marginBottom = '10px';
        var reissueNote = card.reissue_requested
          ? '<span class="bank-card__status bank-card__status--reissue">Reissue requested</span>'
          : '';
        var actions = card.status === 'active'
          ? '<button class="bank-card__action" data-bc-lost="' + esc(card.card_id) + '">Report lost</button>'
          : '';
        div.innerHTML =
          '<span class="bank-card__name">' + esc(account.name) + '</span>' +
          '<span class="bank-card__key">' + esc(card.card_id) + '</span>' +
          '<div class="bank-card__meta">' +
            '<span>' + fmtDate(card.created_at) + '</span>' +
            '<span class="bank-card__status bank-card__status--' + esc(card.status) + '">' + esc(card.status) + '</span>' +
            reissueNote +
          '</div>' +
          actions;
        list.appendChild(div);
      });

      list.querySelectorAll('[data-bc-lost]').forEach(function (btn) {
        btn.addEventListener('click', function () { reportCardLost(btn.dataset.bcLost); });
      });
    });

    // Load recent transactions
    api('/api/banking/me/transactions?limit=5&offset=0').then(function (r) {
      var list = $('dash-tx-list');
      var empty = $('dash-tx-empty');
      list.innerHTML = '';
      if (!r.ok || !r.data || !r.data.results || r.data.results.length === 0) {
        empty.style.display = '';
        return;
      }
      empty.style.display = 'none';
      renderTxRows(list, r.data.results, account.key);
    });
  }

  // ── Transaction row rendering ──────────────────────────────
  function renderTxRows(container, txs, myKey) {
    container.innerHTML = '';
    txs.forEach(function (tx) {
      var isCredit = tx.to_key === myKey;
      var otherParty = isCredit ? (tx.from_name || tx.from_key) : (tx.to_name || tx.to_key);
      var rowClass = 'tx-row ' + (isCredit ? 'tx-row--credit' : 'tx-row--debit');
      var amtClass = 'tx-row__amount ' + (isCredit ? 'tx-row__amount--credit' : 'tx-row__amount--debit');
      var sign = isCredit ? '+' : '−';

      var row = document.createElement('div');
      row.className = rowClass;
      row.innerHTML =
        '<span class="tx-row__other">' + esc(otherParty) + '</span>' +
        '<span class="' + amtClass + '">' + sign + ' ' + fmt(tx.amount) + '</span>' +
        '<span class="tx-row__desc">' + esc(tx.description || '') + '</span>' +
        '<span class="tx-row__date">' + fmtDate(tx.created_at) + '</span>' +
        '<div class="tx-row__detail">' +
          'ID: ' + esc(tx.id) + ' · ' +
          'Balance after: ' + fmt(isCredit ? tx.to_balance : tx.from_balance) +
        '</div>';

      row.addEventListener('click', function () {
        row.classList.toggle('tx-row--expanded');
      });
      container.appendChild(row);
    });
  }

  // ── Transfer form ────────────────────────────────────────
  function loadTransferForm() {
    $('tx-recipient-search').value = '';
    $('tx-recipient-key').value = '';
    $('tx-recipient-name').value = '';
    $('tx-amount').value = '';
    $('tx-desc').value = '';
    $('tx-preview').classList.remove('visible');
    $('tx-confirm-btn').disabled = true;
    $('tx-msg').style.display = 'none';

    $('tx-preview-from').textContent = account.name + ' (' + account.key + ')';

    // Attach listeners only once (flagged)
    if (!transferReady) {
      transferReady = true;
      setupRecipientSearch('tx-recipient-search', 'tx-recipient-dropdown', function (acct) {
        $('tx-recipient-key').value = acct.key;
        $('tx-recipient-name').value = acct.name;
        $('tx-recipient-search').value = acct.name + ' (' + acct.key + ')';
        updateTransferPreview();
      });
      $('tx-amount').addEventListener('input', updateTransferPreview);
      $('tx-desc').addEventListener('input', updateTransferPreview);
      $('tx-confirm-btn').addEventListener('click', submitTransfer);
    }
  }

  function updateTransferPreview() {
    var toKey = $('tx-recipient-key').value;
    var toName = $('tx-recipient-name').value;
    var amount = parseInt($('tx-amount').value, 10);
    var preview = $('tx-preview');
    var btn = $('tx-confirm-btn');

    if (!toKey || !amount || amount < 1) {
      preview.classList.remove('visible');
      btn.disabled = true;
      return;
    }

    $('tx-preview-to').textContent = toName + ' (' + toKey + ')';
    $('tx-preview-amount').textContent = fmtInt(amount);
    $('tx-preview-newbal').textContent = fmt(account.balance - amount);
    preview.classList.add('visible');

    btn.disabled = (amount > account.balance || toKey === account.key);
  }

  function submitTransfer() {
    var msg = $('tx-msg');
    var btn = $('tx-confirm-btn');
    msg.style.display = 'none';
    btn.disabled = true;

    api('/api/banking/transfer', {
      method: 'POST',
      body: JSON.stringify({
        toKey: $('tx-recipient-key').value,
        amount: parseInt($('tx-amount').value, 10),
        description: $('tx-desc').value
      })
    }).then(function (res) {
      msg.style.display = 'block';
      if (res.ok) {
        msg.className = 'bank-msg success';
        msg.textContent = 'Transfer complete! New balance: ' + fmt(res.data.fromBalanceAfter);
        account.balance = res.data.fromBalanceAfter;
        $('bal-amount').textContent = fmt(account.balance);
        $('tx-amount').value = '';
        $('tx-desc').value = '';
        $('tx-preview').classList.remove('visible');
        updateTransferPreview();
      } else {
        msg.className = 'bank-msg error';
        msg.textContent = res.data.error || 'Transfer failed.';
      }
      btn.disabled = false;
    });
  }

  // ── Recipient search (shared) ──────────────────────────────
  var searchTimer = null;
  function setupRecipientSearch(inputId, dropdownId, onSelect) {
    var input = $(inputId);
    var dropdown = $(dropdownId);
    var selectedIdx = -1;

    input.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var q = input.value.trim();
      if (q.length < 2) {
        dropdown.classList.remove('open');
        dropdown.innerHTML = '';
        selectedIdx = -1;
        return;
      }
      searchTimer = setTimeout(function () {
        api('/api/banking/accounts/search?q=' + encodeURIComponent(q)).then(function (res) {
          if (!res.ok || !res.data) return;
          dropdown.innerHTML = '';
          selectedIdx = -1;
          if (res.data.length === 0) {
            dropdown.classList.remove('open');
            return;
          }
          res.data.forEach(function (acct, i) {
            var opt = document.createElement('div');
            opt.className = 'recipient-option';
            opt.innerHTML =
              '<span class="recipient-option__name">' + esc(acct.name) + '</span>' +
              '<span class="recipient-option__key">' + esc(acct.key) + ' · ' +
                '<span class="recipient-option__type">' + esc(acct.type) + '</span></span>';
            opt.addEventListener('mousedown', function (e) {
              e.preventDefault();
              onSelect(acct);
              dropdown.classList.remove('open');
            });
            dropdown.appendChild(opt);
          });
          dropdown.classList.add('open');
        });
      }, 250);
    });

    input.addEventListener('keydown', function (e) {
      var opts = dropdown.querySelectorAll('.recipient-option');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIdx = Math.min(selectedIdx + 1, opts.length - 1);
        highlightOption(opts, selectedIdx);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIdx = Math.max(selectedIdx - 1, -1);
        highlightOption(opts, selectedIdx);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIdx >= 0 && opts[selectedIdx]) {
          opts[selectedIdx].click();
        }
      } else if (e.key === 'Escape') {
        dropdown.classList.remove('open');
      }
    });

    // Close dropdown on outside click
    document.addEventListener('click', function (e) {
      if (!input.parentElement.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    });
  }

  function highlightOption(opts, idx) {
    opts.forEach(function (o, i) {
      o.classList.toggle('recipient-option--selected', i === idx);
    });
  }

  // ── Transaction log ──────────────────────────────────────
  function loadTransactionLog(page) {
    logPage = page || 0;
    var params = 'limit=' + logLimit + '&offset=' + (logPage * logLimit);

    api('/api/banking/me/transactions?' + params).then(function (r) {
      var list = $('log-tx-list');
      var empty = $('log-tx-empty');
      list.innerHTML = '';
      empty.style.display = 'none';

      if (!r.ok || !r.data) return;
      var txs = r.data.results || [];
      logTotal = r.data.total || txs.length;

      if (txs.length === 0) {
        empty.style.display = '';
      } else {
        renderTxRows(list, txs, account.key);
      }

      renderLogPagination();
    });
  }

  function renderLogPagination() {
    var container = $('log-pagination');
    var totalPages = Math.ceil(logTotal / logLimit);
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    var html = '<button id="log-prev"' + (logPage === 0 ? ' disabled' : '') + '>&larr; Prev</button>';
    html += '<span>Page ' + (logPage + 1) + ' of ' + totalPages + '</span>';
    html += '<button id="log-next"' + (logPage >= totalPages - 1 ? ' disabled' : '') + '>Next &rarr;</button>';
    container.innerHTML = html;

    var prev = $('log-prev');
    var next = $('log-next');
    if (prev) prev.addEventListener('click', function () { if (logPage > 0) loadTransactionLog(logPage - 1); });
    if (next) next.addEventListener('click', function () { if (logPage < totalPages - 1) loadTransactionLog(logPage + 1); });
  }

  // ── Filter setup ─────────────────────────────────────────
  var filterTimeout;
  function setupFilters() {
    if (filtersReady) return;
    filtersReady = true;
    $('log-filter-apply').addEventListener('click', function () {
      applyFilters();
    });
    $('log-filter-clear').addEventListener('click', function () {
      $('log-filter-desc').value = '';
      $('log-filter-amount-min').value = '';
      $('log-filter-amount-max').value = '';
      $('log-filter-date-from').value = '';
      $('log-filter-date-to').value = '';
      loadTransactionLog(0);
    });

    // Debounced auto-filter
    ['log-filter-desc', 'log-filter-amount-min', 'log-filter-amount-max'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('input', function () {
        clearTimeout(filterTimeout);
        filterTimeout = setTimeout(applyFilters, 400);
      });
    });
  }

  function applyFilters() {
    var desc = ($('log-filter-desc').value || '').trim().toLowerCase();
    var minAmt = parseFloat($('log-filter-amount-min').value);
    var maxAmt = parseFloat($('log-filter-amount-max').value);
    var dateFrom = $('log-filter-date-from').value;
    var dateTo = $('log-filter-date-to').value;

    // Fetch a larger batch and filter client-side
    api('/api/banking/me/transactions?limit=200&offset=0').then(function (r) {
      var list = $('log-tx-list');
      var empty = $('log-tx-empty');
      list.innerHTML = '';
      empty.style.display = 'none';

      var txs = r.data && r.data.results ? r.data.results : [];
      var filtered = txs.filter(function (tx) {
        if (desc && (tx.description || '').toLowerCase().indexOf(desc) === -1 &&
            (tx.from_name || '').toLowerCase().indexOf(desc) === -1 &&
            (tx.to_name || '').toLowerCase().indexOf(desc) === -1) return false;
        if (!isNaN(minAmt) && tx.amount < minAmt) return false;
        if (!isNaN(maxAmt) && tx.amount > maxAmt) return false;
        if (dateFrom) {
          var txDate = new Date(tx.created_at).toISOString().slice(0, 10);
          if (txDate < dateFrom) return false;
        }
        if (dateTo) {
          var txDate = new Date(tx.created_at).toISOString().slice(0, 10);
          if (txDate > dateTo) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        empty.style.display = '';
      } else {
        renderTxRows(list, filtered.slice(0, 50), account.key);
      }
      $('log-pagination').innerHTML = '';
    });
  }

  // ── Portfolio ────────────────────────────────────────────
  function loadPortfolio() {
    api('/api/banking/me/portfolio').then(function (r) {
      var tbody = $('portfolio-tbody');
      var empty = $('portfolio-empty');
      var totalEl = $('portfolio-total-val');
      tbody.innerHTML = '';
      empty.style.display = 'none';

      if (!r.ok || !r.data || r.data.length === 0) {
        empty.style.display = '';
        totalEl.textContent = '$0.00';
        return;
      }

      var total = 0;
      r.data.forEach(function (h) {
        var value = h.estimatedValue || 0;
        total += value;
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + esc(h.companyName) + '</td>' +
          '<td class="num">' + h.shares.toLocaleString() + '</td>' +
          '<td class="num">' + fmt(h.pricePerShare) + '</td>' +
          '<td class="num">' + fmt(value) + '</td>';
        tbody.appendChild(tr);
      });
      totalEl.textContent = fmt(total);
    });
  }

  // ── Company view ─────────────────────────────────────────
  function loadCompanyView() {
    if (!account || account.type !== 'company') return;

    // Stats
    $('comp-balance').textContent = fmt(account.balance);
    $('comp-shares').textContent = (account.shares || 0).toLocaleString();
    var pricePerShare = account.shares > 0 ? account.balance / account.shares : 0;
    $('comp-price').textContent = fmt(pricePerShare);

    // Sparkline — show last 7 days of balance from transaction log
    api('/api/banking/me/transactions?limit=100&offset=0').then(function (r) {
      var txs = r.data && r.data.results ? r.data.results : [];
      var points = extractBalanceHistory(txs, account.balance);
      drawSparkline('comp-sparkline', points);
    });

    // Shareholders
    var companyKey = account.key;
    api('/api/banking/companies/' + encodeURIComponent(companyKey) + '/shareholders').then(function (r) {
      var pieSvg = $('comp-pie-svg');
      var legend = $('comp-pie-legend');
      var empty = $('comp-pie-empty');
      legend.innerHTML = '';

      if (!r.ok || !r.data || r.data.length === 0) {
        empty.style.display = '';
        pieSvg.innerHTML = '';
        return;
      }
      empty.style.display = 'none';
      drawShareholderPie('comp-pie-svg', 'comp-pie-legend', r.data);
    });

    // Attach share issuance listeners only once (flagged)
    if (!companyReady) {
      companyReady = true;
      setupRecipientSearch('issuance-recipient-search', 'issuance-recipient-dropdown', function (acct) {
        $('issuance-buyer-key').value = acct.key;
        $('issuance-buyer-name').value = acct.name;
        $('issuance-recipient-search').value = acct.name + ' (' + acct.key + ')';
        updateIssuancePreview();
      });
      $('issuance-count').addEventListener('input', updateIssuancePreview);
      $('issuance-confirm-btn').addEventListener('click', submitIssuance);
    }
  }

  function updateIssuancePreview() {
    var buyerKey = $('issuance-buyer-key').value;
    var buyerName = $('issuance-buyer-name').value;
    var count = parseInt($('issuance-count').value, 10);
    var preview = $('issuance-preview');
    var btn = $('issuance-confirm-btn');
    var pricePerShare = account.shares > 0 ? account.balance / account.shares : 0;

    if (!buyerKey || !count || count < 1) {
      preview.style.display = 'none';
      btn.disabled = true;
      return;
    }

    $('issuance-preview-count').textContent = count.toLocaleString();
    $('issuance-preview-buyer').textContent = buyerName;
    $('issuance-preview-price').textContent = fmt(pricePerShare);
    $('issuance-preview-total').textContent = fmt(pricePerShare * count);
    preview.style.display = '';
    btn.disabled = false;
  }

  function submitIssuance() {
    var msg = $('issuance-msg');
    var btn = $('issuance-confirm-btn');
    msg.style.display = 'none';
    btn.disabled = true;

    api('/api/banking/company/issue-shares', {
      method: 'POST',
      body: JSON.stringify({
        buyerKey: $('issuance-buyer-key').value,
        shareCount: parseInt($('issuance-count').value, 10)
      })
    }).then(function (res) {
      msg.style.display = 'block';
      if (res.ok) {
        msg.className = 'bank-msg success';
        msg.textContent = 'Shares issued successfully!';
        // Reload account to get updated data
        api('/api/banking/me').then(function (r) {
          if (r.ok) {
            account = r.data;
            loadCompanyView();
            $('bal-amount').textContent = fmt(account.balance);
            $('comp-balance').textContent = fmt(account.balance);
            $('comp-shares').textContent = (account.shares || 0).toLocaleString();
            var pps = account.shares > 0 ? account.balance / account.shares : 0;
            $('comp-price').textContent = fmt(pps);
          }
        });
        $('issuance-count').value = '';
        updateIssuancePreview();
      } else {
        msg.className = 'bank-msg error';
        msg.textContent = res.data.error || 'Failed to issue shares.';
        btn.disabled = false;
      }
    });
  }

  // ── Sparkline chart (SVG, no library) ────────────────────
  function drawSparkline(containerId, dataPoints) {
    var container = $(containerId);
    if (!container) return;

    var points = dataPoints || [];
    while (container.firstChild) container.removeChild(container.firstChild);

    var svgNS = 'http://www.w3.org/2000/svg';
    var w = container.clientWidth || 400;
    var h = container.clientHeight || 80;
    var pad = 2;

    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('preserveAspectRatio', 'none');

    if (points.length < 2) {
      // Simple text
      var txt = document.createElementNS(svgNS, 'text');
      txt.setAttribute('x', '50%');
      txt.setAttribute('y', '50%');
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('dominant-baseline', 'middle');
      txt.setAttribute('fill', 'var(--slate-soft)');
      txt.setAttribute('font-family', 'var(--font-mono)');
      txt.setAttribute('font-size', '11');
      txt.textContent = 'Not enough data';
      svg.appendChild(txt);
      container.appendChild(svg);
      return;
    }

    var maxVal = Math.max.apply(null, points);
    var minVal = Math.min.apply(null, points);
    if (maxVal === minVal) { maxVal = minVal + 1; }

    var xStep = (w - 2 * pad) / (points.length - 1);
    var yScale = function (v) { return h - pad - ((v - minVal) / (maxVal - minVal)) * (h - 2 * pad); };

    // Area fill
    var areaPath = '';
    points.forEach(function (v, i) {
      var x = pad + i * xStep;
      var y = yScale(v);
      areaPath += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
    });
    areaPath += 'L' + (pad + (points.length - 1) * xStep) + ',' + (h - pad) + ' ';
    areaPath += 'L' + pad + ',' + (h - pad) + ' Z';

    var area = document.createElementNS(svgNS, 'path');
    area.setAttribute('d', areaPath);
    area.setAttribute('fill', 'rgba(201,162,39,0.12)');
    svg.appendChild(area);

    // Line
    var linePath = '';
    points.forEach(function (v, i) {
      var x = pad + i * xStep;
      var y = yScale(v);
      linePath += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
    });

    var line = document.createElementNS(svgNS, 'path');
    line.setAttribute('d', linePath);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'var(--gold-bright)');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(line);

    container.appendChild(svg);
  }

  function extractBalanceHistory(txs, currentBalance) {
    // Walk backwards through transactions reconstructing balance
    var balances = [currentBalance];
    var running = currentBalance;

    // Sort by date descending
    var sorted = txs.slice().sort(function (a, b) {
      return new Date(b.created_at) - new Date(a.created_at);
    });

    for (var i = 0; i < sorted.length && balances.length < 8; i++) {
      var tx = sorted[i];
      if (tx.to_key === account.key) {
        running -= tx.amount;
      } else {
        running += tx.amount;
      }
      balances.unshift(running);
    }

    // Trim to at most 7 entries
    return balances.slice(-7);
  }

  // ── Pie chart (SVG, no library) ──────────────────────────
  function drawShareholderPie(svgId, legendId, shareholders) {
    var svgEl = $(svgId);
    var legendEl = $(legendId);
    if (!svgEl || !legendEl) return;

    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    legendEl.innerHTML = '';

    var svgNS = 'http://www.w3.org/2000/svg';
    var cx = 80, cy = 80, r = 72;
    var colors = ['#c9a227', '#2e8e96', '#8e1b2b', '#4b4f54', '#b3273a', '#6b7075', '#e3bf4c', '#45b3bc'];

    var total = shareholders.reduce(function (sum, s) { return sum + s.shares; }, 0);
    if (total === 0) return;

    var angle = -Math.PI / 2;
    shareholders.forEach(function (s, i) {
      var sliceAngle = (s.shares / total) * 2 * Math.PI;
      var x1 = cx + r * Math.cos(angle);
      var y1 = cy + r * Math.sin(angle);
      var x2 = cx + r * Math.cos(angle + sliceAngle);
      var y2 = cy + r * Math.sin(angle + sliceAngle);
      var largeArc = sliceAngle > Math.PI ? 1 : 0;

      var path = document.createElementNS(svgNS, 'path');
      var d = 'M' + cx + ',' + cy +
        ' L' + x1 + ',' + y1 +
        ' A' + r + ',' + r + ' 0 ' + largeArc + ' 1 ' + x2 + ',' + y2 +
        ' Z';
      path.setAttribute('d', d);
      var color = colors[i % colors.length];
      path.setAttribute('fill', color);
      path.setAttribute('stroke', 'var(--ink)');
      path.setAttribute('stroke-width', '1.5');
      svgEl.appendChild(path);

      // Legend
      var pct = ((s.shares / total) * 100).toFixed(1);
      var item = document.createElement('div');
      item.className = 'pie-chart-legend__item';
      item.innerHTML =
        '<span class="pie-chart-legend__swatch" style="background:' + color + ';"></span>' +
        esc(s.holder_name || s.holder_key) + ' — ' + s.shares.toLocaleString() + ' (' + pct + '%)';
      legendEl.appendChild(item);

      angle += sliceAngle;
    });
  }

  // ── Guest "Sign In" button ────────────────────────────────
  var guestBtn = $('guest-signin-btn');
  if (guestBtn) {
    guestBtn.addEventListener('click', function () {
      // Trigger the auth-widget modal
      var authBtn = document.querySelector('.ra-auth-btn');
      if (authBtn) authBtn.click();
    });
  }

  // ── Start ────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Set up filter listeners (script is deferred, DOM is ready by now)
  setupFilters();
})();
