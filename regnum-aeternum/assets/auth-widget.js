/* ============================================================
   REGNUM AETERNUM — Sign In / Create Account widget
   Self-contained: injects its own <style>, builds its own modal,
   and figures out its own depth (for the Admin Panel link) from
   its own <script src> — so the same file works unmodified at
   any folder depth across the site.

   Talks to the same /api/auth/* endpoints the /ballistics/ and
   /admin/ login gates already use, so one account works
   everywhere; this just adds public self-registration as a
   "citizen" (admins promote accounts to other roles from /admin/).
   ============================================================ */
(function () {
  'use strict';

  var STYLE_ID = 'ra-auth-widget-styles';
  var CSS = [
    '.ra-auth-slot { margin-left: auto; display:flex; align-items:center; gap:10px; }',
    '.ra-auth-btn {',
    '  font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;',
    '  color: var(--gold-bright); background: none; border: 1px solid var(--gold-dim); border-radius: 100px;',
    '  padding: 7px 16px; cursor: pointer; transition: border-color .2s, background .2s; white-space: nowrap;',
    '}',
    '.ra-auth-btn:hover { border-color: var(--gold); background: rgba(201,162,39,0.08); }',
    '.ra-auth-user { display:flex; align-items:center; gap:10px; font-family: var(--font-mono); font-size: 11px; color: var(--parchment-dim); }',
    '.ra-auth-user__name { color: var(--parchment); max-width: 140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
    '.ra-auth-user__role { color: var(--teal-bright); text-transform: uppercase; letter-spacing: .06em; font-size: 10px; border: 1px solid rgba(46,142,150,.4); border-radius: 100px; padding: 2px 9px; white-space:nowrap; }',
    '.ra-auth-link { color: var(--gold-bright); border-bottom: 1px dotted var(--gold-dim); font-size: 11px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .06em; white-space:nowrap; }',
    '.ra-modal-backdrop { position: fixed; inset: 0; background: rgba(10,9,10,0.72); backdrop-filter: blur(3px); display:flex; align-items:center; justify-content:center; z-index: 1000; padding: 20px; }',
    '.ra-modal { background: var(--ink-elevated); border: 1px solid var(--slate-line); border-radius: 14px; width: 100%; max-width: 380px; padding: 28px 26px; position: relative; }',
    '.ra-modal__close { position: absolute; top: 14px; right: 16px; background:none; border:none; color: var(--parchment-faint); font-size: 18px; cursor:pointer; line-height:1; }',
    '.ra-modal__tabs { display:flex; gap:6px; margin-bottom: 20px; border-bottom: 1px solid var(--slate-line); }',
    '.ra-modal__tab { font-family: var(--font-mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; padding: 8px 4px; background:none; border:none; border-bottom: 2px solid transparent; color: var(--parchment-faint); cursor:pointer; }',
    '.ra-modal__tab.active { color: var(--gold-bright); border-bottom-color: var(--gold-bright); }',
    '.ra-modal__panel { display:none; flex-direction: column; gap: 12px; }',
    '.ra-modal__panel.active { display:flex; }',
    '.ra-modal__title { font-family: var(--font-display); font-size: 20px; color: var(--parchment); margin: 0 0 4px; font-weight: 600; }',
    '.ra-modal input { font: inherit; font-size: 14px; color: var(--parchment); background: var(--ink-soft); border: 1px solid var(--slate-line); border-radius: 8px; padding: 11px 14px; width: 100%; }',
    '.ra-modal input:focus { outline: none; border-color: var(--gold-dim); }',
    '.ra-modal button[type="submit"] { font-family: var(--font-mono); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; background: var(--crimson); border: 1px solid var(--crimson-bright); color: var(--parchment); border-radius: 8px; padding: 12px 0; cursor: pointer; margin-top: 4px; }',
    '.ra-modal button[type="submit"]:hover { background: var(--crimson-bright); }',
    '.ra-modal button[type="submit"]:disabled { opacity: .5; cursor: not-allowed; }',
    '.ra-modal__err { color: #e3a3a3; font-family: var(--font-mono); font-size: 12px; margin: 0; display:none; }',
    '.ra-modal__hint { color: var(--slate-soft); font-family: var(--font-mono); font-size: 10.5px; margin: -4px 0 0; }'
  ].join('\n');

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          return { ok: r.ok, status: r.status, data: data };
        });
      });
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    if (text != null) e.textContent = text;
    return e;
  }

  var state = { user: null };
  var slotEl = null;
  var widgetDepth = ''; // relative path prefix back to the site root

  function buildModal() {
    var backdrop = el('div', { class: 'ra-modal-backdrop' });
    var modal = el('div', { class: 'ra-modal' });
    var close = el('button', { class: 'ra-modal__close', type: 'button', 'aria-label': 'Close' }, '\u2715');

    var tabs = el('div', { class: 'ra-modal__tabs' });
    var tabLogin = el('button', { class: 'ra-modal__tab active', type: 'button' }, 'Sign In');
    var tabReg = el('button', { class: 'ra-modal__tab', type: 'button' }, 'Create Account');
    tabs.appendChild(tabLogin);
    tabs.appendChild(tabReg);

    // ---- Sign in panel ----
    var loginPanel = el('form', { class: 'ra-modal__panel active' });
    loginPanel.appendChild(el('h3', { class: 'ra-modal__title' }, 'Sign In'));
    var lUser = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username', required: 'required' });
    var lPass = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: 'required' });
    var lErr = el('p', { class: 'ra-modal__err' });
    var lBtn = el('button', { type: 'submit' }, 'Sign In');
    [lUser, lPass, lErr, lBtn].forEach(function (n) { loginPanel.appendChild(n); });

    // ---- Create account panel ----
    var regPanel = el('form', { class: 'ra-modal__panel' });
    regPanel.appendChild(el('h3', { class: 'ra-modal__title' }, 'Create a Citizen Account'));
    var rUser = el('input', { type: 'text', placeholder: 'Choose a username', autocomplete: 'username', required: 'required' });
    var rPass = el('input', { type: 'password', placeholder: 'Choose a password', autocomplete: 'new-password', required: 'required' });
    var rPass2 = el('input', { type: 'password', placeholder: 'Confirm password', autocomplete: 'new-password', required: 'required' });
    var rHint = el('p', { class: 'ra-modal__hint' }, '3\u201332 characters: letters, numbers, _ - . \u00b7 password 8+ characters.');
    var rErr = el('p', { class: 'ra-modal__err' });
    var rBtn = el('button', { type: 'submit' }, 'Create Account');
    [rUser, rPass, rPass2, rHint, rErr, rBtn].forEach(function (n) { regPanel.appendChild(n); });

    function showTab(which) {
      tabLogin.classList.toggle('active', which === 'login');
      tabReg.classList.toggle('active', which === 'reg');
      loginPanel.classList.toggle('active', which === 'login');
      regPanel.classList.toggle('active', which === 'reg');
    }
    tabLogin.addEventListener('click', function () { showTab('login'); });
    tabReg.addEventListener('click', function () { showTab('reg'); });

    function closeModal() {
      document.removeEventListener('keydown', onKeydown);
      backdrop.remove();
    }
    function onKeydown(e) { if (e.key === 'Escape') closeModal(); }
    document.addEventListener('keydown', onKeydown);

    close.addEventListener('click', closeModal);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });

    loginPanel.addEventListener('submit', function (e) {
      e.preventDefault();
      lErr.style.display = 'none';
      lBtn.disabled = true;
      api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: lUser.value, password: lPass.value }) })
        .then(function (res) {
          lBtn.disabled = false;
          if (!res.ok) {
            lErr.textContent = res.data.error || 'Sign in failed.';
            lErr.style.display = 'block';
            return;
          }
          state.user = res.data;
          renderWidget();
          closeModal();
        });
    });

    regPanel.addEventListener('submit', function (e) {
      e.preventDefault();
      rErr.style.display = 'none';
      if (rPass.value !== rPass2.value) {
        rErr.textContent = 'Passwords do not match.';
        rErr.style.display = 'block';
        return;
      }
      rBtn.disabled = true;
      api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: rUser.value, password: rPass.value }) })
        .then(function (res) {
          rBtn.disabled = false;
          if (!res.ok) {
            rErr.textContent = res.data.error || 'Could not create account.';
            rErr.style.display = 'block';
            return;
          }
          state.user = res.data;
          renderWidget();
          closeModal();
        });
    });

    modal.appendChild(close);
    modal.appendChild(tabs);
    modal.appendChild(loginPanel);
    modal.appendChild(regPanel);
    backdrop.appendChild(modal);
    return backdrop;
  }

  function openModal() {
    document.body.appendChild(buildModal());
  }

  function renderWidget() {
    if (!slotEl) return;
    slotEl.innerHTML = '';

    if (state.user) {
      var wrap = el('div', { class: 'ra-auth-user' });
      wrap.appendChild(el('span', { class: 'ra-auth-user__name' }, state.user.username));
      wrap.appendChild(el('span', { class: 'ra-auth-user__role' }, state.user.role));

      if (state.user.role === 'admin' || state.user.role === 'editor') {
        wrap.appendChild(el('a', { class: 'ra-auth-link', href: widgetDepth + 'admin/' }, 'Admin Panel'));
      }

      var out = el('button', { class: 'ra-auth-btn', type: 'button' }, 'Sign Out');
      out.addEventListener('click', function () {
        api('/api/auth/logout', { method: 'POST' }).then(function () {
          state.user = null;
          renderWidget();
        });
      });
      wrap.appendChild(out);
      slotEl.appendChild(wrap);
    } else {
      var btn = el('button', { class: 'ra-auth-btn', type: 'button' }, 'Sign In');
      btn.addEventListener('click', openModal);
      slotEl.appendChild(btn);
    }
  }

  function init() {
    injectStyles();
    var topbar = document.querySelector('.topbar');
    if (!topbar) return;

    // Work out the relative path back to the site root from this
    // script's own src= attribute, so the Admin Panel link resolves
    // correctly no matter how deeply nested the current page is.
    var scripts = document.getElementsByTagName('script');
    var src = '';
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i].getAttribute('src') || '';
      if (/assets\/auth-widget\.js(\?.*)?$/.test(s)) { src = s; break; }
    }
    widgetDepth = src.replace(/assets\/auth-widget\.js(\?.*)?$/, '');

    slotEl = el('div', { class: 'ra-auth-slot' });
    topbar.appendChild(slotEl);
    renderWidget();

    api('/api/auth/me').then(function (res) {
      if (res.ok) state.user = res.data;
      renderWidget();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
