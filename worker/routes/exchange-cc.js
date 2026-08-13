/* ============================================================
   Regnum Aeternum — Worker
   Fiducia Exchange: ComputerCraft HTTP Bridge
   Same CC auth as banking-cc (Bearer token SHA-256).
   Optimised for CC's textutils.unserialiseJSON — compact responses.
   ============================================================ */

import * as store from '../lib/store.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function ccJson(success, response, init = {}) {
  return json({ success, response }, init);
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function authenticateCC(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return { error: ccJson(false, 'Missing Authorization header.') };
  const tokenHash = await sha256hex(m[1].trim());
  const token = await store.findCCToken(env, tokenHash);
  if (!token) return { error: ccJson(false, 'Invalid or expired token.') };
  // Exchange terminals require 'stock_exchange' or 'admin' token type
  if (token.terminal_type !== 'stock_exchange' && token.terminal_type !== 'admin') {
    return { error: ccJson(false, 'Token type must be stock_exchange or admin.') };
  }
  store.updateCCTokenLastUsed(env, tokenHash).catch(() => {});
  return { token };
}

/** Get the banking account linked to a CC token. CC terminals have a treasury_key
 *  scope; we expect exchange terminals to provide an `account` field identifying
 *  the player's banking account. */
async function resolvePlayerAccount(env, token, bodyAccount) {
  if (bodyAccount) {
    const acc = await env.DB.prepare(
      'SELECT key, name, balance, frozen FROM banking_accounts WHERE key = ?'
    ).bind(String(bodyAccount)).first();
    if (!acc || acc.frozen) return null;
    if (token.treasury_key && acc.treasury_key !== token.treasury_key) return null;
    return acc;
  }
  return null;
}

// ── GET /api/exchange/cc/market ───────────────────────────────────
export async function ccMarket(request, env) {
  const { results: companies } = await env.DB.prepare(
    `SELECT c.ticker, c.name, c.sector, c.current_price AS price,
            c.prev_close_price, c.day_volume AS volume, c.market_cap, c.status
     FROM fdx_companies c
     WHERE c.status IN ('active','halted')
       AND (c.linked_bank_account IS NULL
            OR EXISTS (SELECT 1 FROM banking_accounts ba WHERE ba.key = c.linked_bank_account))
     ORDER BY c.ticker ASC`
  ).all();

  return ccJson(true, (companies || []).map(c => ({
    t: c.ticker, n: c.name, s: c.sector,
    p: Math.round(c.price * 100) / 100,
    ch: c.prev_close_price ? Math.round((c.price - c.prev_close_price) * 100) / 100 : 0,
    chp: c.prev_close_price ? Math.round(((c.price - c.prev_close_price) / c.prev_close_price) * 10000) / 100 : 0,
    v: c.volume, st: c.status,
  })));
}

// ── GET /api/exchange/cc/quote/:ticker ────────────────────────────
export async function ccQuote(request, env, ticker) {
  const company = await env.DB.prepare(
    'SELECT * FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return ccJson(false, 'Company not found.');

  const bestBid = await env.DB.prepare(
    `SELECT COALESCE(MAX(limit_price), 0) AS p FROM fdx_orders
     WHERE company_id = ? AND side = 'BUY' AND status IN ('open','partial') AND limit_price IS NOT NULL`
  ).bind(company.id).first();

  const bestAsk = await env.DB.prepare(
    `SELECT COALESCE(MIN(limit_price), 0) AS p FROM fdx_orders
     WHERE company_id = ? AND side = 'SELL' AND status IN ('open','partial') AND limit_price IS NOT NULL`
  ).bind(company.id).first();

  return ccJson(true, {
    t: company.ticker, n: company.name,
    p: Math.round(company.current_price * 100) / 100,
    ch: company.prev_close_price ? Math.round((company.current_price - company.prev_close_price) * 100) / 100 : 0,
    chp: company.prev_close_price ? Math.round(((company.current_price - company.prev_close_price) / company.prev_close_price) * 10000) / 100 : 0,
    hi: company.day_high, lo: company.day_low,
    v: company.day_volume, mc: company.market_cap,
    bid: (bestBid && bestBid.p) || 0,
    ask: (bestAsk && bestAsk.p) || 0,
    st: company.status,
  });
}

// ── GET /api/exchange/cc/orderbook/:ticker ────────────────────────
export async function ccOrderBook(request, env, ticker) {
  const company = await env.DB.prepare(
    'SELECT id, current_price FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return ccJson(false, 'Company not found.');

  const { results: bids } = await env.DB.prepare(
    `SELECT limit_price AS p, SUM(quantity - quantity_filled) AS q
     FROM fdx_orders
     WHERE company_id = ? AND side = 'BUY' AND status IN ('open','partial') AND limit_price IS NOT NULL
     GROUP BY limit_price ORDER BY limit_price DESC LIMIT 5`
  ).bind(company.id).all();

  const { results: asks } = await env.DB.prepare(
    `SELECT limit_price AS p, SUM(quantity - quantity_filled) AS q
     FROM fdx_orders
     WHERE company_id = ? AND side = 'SELL' AND status IN ('open','partial') AND limit_price IS NOT NULL
     GROUP BY limit_price ORDER BY limit_price ASC LIMIT 5`
  ).bind(company.id).all();

  return ccJson(true, {
    t: ticker, p: Math.round(company.current_price * 100) / 100,
    bids: (bids || []).map(b => ({ p: b.p, q: b.q })),
    asks: (asks || []).map(a => ({ p: a.p, q: a.q })),
  });
}

// ── POST /api/exchange/cc/portfolio ───────────────────────────────
export async function ccPortfolio(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return ccJson(false, 'Invalid body.'); }
  if (!body.account) return ccJson(false, 'account required.');

  const account = await resolvePlayerAccount(env, auth.token, body.account);
  if (!account) return ccJson(false, 'Invalid or frozen account.');

  const { results: holdings } = await env.DB.prepare(
    `SELECT p.quantity, p.average_cost, p.total_invested,
            c.ticker, c.name AS company_name, c.current_price
     FROM fdx_portfolios p
     JOIN fdx_companies c ON c.id = p.company_id
     WHERE p.account_id = ? AND p.quantity > 0
     ORDER BY (p.quantity * c.current_price) DESC`
  ).bind(account.key).all();

  return ccJson(true, (holdings || []).map(h => ({
    t: h.ticker, n: h.company_name,
    q: h.quantity, avg: Math.round(h.average_cost * 100) / 100,
    p: Math.round(h.current_price * 100) / 100,
    val: Math.round(h.quantity * h.current_price * 100) / 100,
    pl: Math.round((h.quantity * h.current_price - h.total_invested) * 100) / 100,
  })));
}

// ── POST /api/exchange/cc/orders ──────────────────────────────────
export async function ccPlaceOrder(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return ccJson(false, 'Invalid body.'); }

  const { account, ticker, side, qty, limit, type } = body;
  if (!account || !ticker || !side || !qty) return ccJson(false, 'account, ticker, side, qty required.');

  const company = await env.DB.prepare(
    'SELECT * FROM fdx_companies WHERE ticker = ? AND status = ?'
  ).bind(ticker.toUpperCase(), 'active').first();
  if (!company) return ccJson(false, 'Company not found or not active.');

  const playerAcc = await resolvePlayerAccount(env, auth.token, account);
  if (!playerAcc) return ccJson(false, 'Invalid or frozen account.');

  const quantity = parseInt(qty, 10);
  if (!Number.isFinite(quantity) || quantity <= 0) return ccJson(false, 'Invalid quantity.');

  const orderType = (type || 'LIMIT').toUpperCase();
  const limitPrice = limit !== undefined ? parseFloat(limit) : null;

  if (orderType === 'LIMIT' && (!limitPrice || limitPrice <= 0)) {
    return ccJson(false, 'Limit price required.');
  }

  const sideUpper = side.toUpperCase();
  if (!['BUY','SELL'].includes(sideUpper)) return ccJson(false, 'side must be BUY or SELL.');

  // Quick balance check for BUY
  if (sideUpper === 'BUY') {
    const estPrice = limitPrice || company.current_price;
    const estCost = Math.ceil(quantity * estPrice * 1.01);
    if (playerAcc.balance < estCost) {
      return ccJson(false, `Insufficient balance. Need ~${estCost}, have ${playerAcc.balance}.`);
    }
  }

  const result = await env.DB.prepare(
    `INSERT INTO fdx_orders
       (company_id, account_id, player_name, side, order_type, quantity, limit_price, time_in_force, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'GTC', 'open')`
  ).bind(company.id, playerAcc.key, auth.token.computer_label || 'CC Trader',
         sideUpper, orderType, quantity, limitPrice).run();

  return ccJson(true, { id: result.meta.last_row_id, st: 'open', q: quantity, p: limitPrice });
}

// ── POST /api/exchange/cc/orders/list ─────────────────────────────
export async function ccMyOrders(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return ccJson(false, 'Invalid body.'); }
  if (!body.account) return ccJson(false, 'account required.');

  const account = await resolvePlayerAccount(env, auth.token, body.account);
  if (!account) return ccJson(false, 'Invalid or frozen account.');

  const { results } = await env.DB.prepare(
    `SELECT o.id, o.side, o.order_type, o.quantity, o.quantity_filled,
            o.limit_price, o.status, o.placed_at, c.ticker, c.name AS company_name
     FROM fdx_orders o
     JOIN fdx_companies c ON c.id = o.company_id
     WHERE o.account_id = ?
     ORDER BY o.placed_at DESC LIMIT 50`
  ).bind(account.key).all();

  return ccJson(true, (results || []).map(o => ({
    id: o.id, t: o.ticker, n: o.company_name,
    sd: o.side, tp: o.order_type,
    q: o.quantity, qf: o.quantity_filled || 0,
    lp: o.limit_price, st: o.status,
    at: o.placed_at,
  })));
}

// ── POST /api/exchange/cc/orders/cancel ───────────────────────────
export async function ccCancelOrder(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return ccJson(false, 'Invalid body.'); }
  if (!body.account || !body.id) return ccJson(false, 'account and id required.');

  const account = await resolvePlayerAccount(env, auth.token, body.account);
  if (!account) return ccJson(false, 'Invalid or frozen account.');

  const order = await env.DB.prepare(
    'SELECT * FROM fdx_orders WHERE id = ? AND account_id = ?'
  ).bind(Number(body.id), account.key).first();

  if (!order) return ccJson(false, 'Order not found.');
  if (!['open','partial'].includes(order.status)) return ccJson(false, 'Order already ' + order.status + '.');

  await env.DB.prepare(
    "UPDATE fdx_orders SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?"
  ).bind(Number(body.id)).run();

  return ccJson(true, 'Order cancelled.');
}

// ── POST /api/exchange/cc/trades ──────────────────────────────────
export async function ccMyTrades(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return ccJson(false, 'Invalid body.'); }
  if (!body.account) return ccJson(false, 'account required.');

  const account = await resolvePlayerAccount(env, auth.token, body.account);
  if (!account) return ccJson(false, 'Invalid or frozen account.');

  const { results } = await env.DB.prepare(
    `SELECT t.quantity, t.price, t.total_value, t.executed_at,
            c.ticker, t.buyer_account, t.seller_account
     FROM fdx_trades t
     JOIN fdx_companies c ON c.id = t.company_id
     WHERE t.buyer_account = ? OR t.seller_account = ?
     ORDER BY t.executed_at DESC LIMIT 30`
  ).bind(account.key, account.key).all();

  return ccJson(true, (results || []).map(t => ({
    t: t.ticker,
    sd: t.buyer_account === account.key ? 'BUY' : 'SELL',
    q: t.quantity, p: t.price, tv: t.total_value,
    at: t.executed_at,
  })));
}

// ── GET /api/exchange/cc/index ────────────────────────────────────
export async function ccIndex(request, env) {
  const latest = await env.DB.prepare(
    'SELECT index_value, advancing, declining, unchanged FROM fdx_index_snapshots ORDER BY snapped_at DESC LIMIT 1'
  ).first();

  return ccJson(true, latest ? {
    idx: Math.round(latest.index_value * 100) / 100,
    adv: latest.advancing, dec: latest.declining, unc: latest.unchanged,
  } : { idx: 1000, adv: 0, dec: 0, unc: 0 });
}
