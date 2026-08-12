/* ============================================================
   Regnum Aeternum — Worker
   Fiducia Exchange: Player API routes.
   Public market data + authenticated trading operations.
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser, hasRole } from './auth.js';
import * as marketEngine from '../lib/market-engine.js';
import * as manipulationGuard from '../lib/manipulation-guard.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function nowIso() { return new Date().toISOString(); }

/** Resolve linked banking account from the session user. */
async function requireLinkedAccount(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return { error: json({ error: 'Authentication required.' }, { status: 401 }) };
  const account = await store.findBankingAccountByUserId(env, user.id);
  if (!account) {
    return { error: json({ error: 'No banking account linked. Contact a banker.' }, { status: 404 }) };
  }
  return { user, account };
}

// ── GET /api/exchange/market ──────────────────────────────────────
export async function getMarket(request, env) {
  const { results: companies } = await env.DB.prepare(
    "SELECT id, ticker, name, sector, description, logo_emoji, total_shares, shares_in_float, current_price, prev_close_price, day_high, day_low, day_volume, market_cap, status FROM fdx_companies WHERE status IN ('active','halted') ORDER BY ticker ASC"
  ).all();

  const enriched = (companies || []).map(c => ({
    ...c,
    change: c.prev_close_price ? Math.round((c.current_price - c.prev_close_price) * 100) / 100 : 0,
    changePct: c.prev_close_price ? Math.round(((c.current_price - c.prev_close_price) / c.prev_close_price) * 10000) / 100 : 0,
  }));

  return json(enriched);
}

// ── GET /api/exchange/companies/:ticker ───────────────────────────
export async function getCompany(request, env, ticker) {
  const company = await env.DB.prepare(
    'SELECT * FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  // Get 52-week high/low
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
  const highLow = await env.DB.prepare(
    `SELECT MAX(high) AS high52, MIN(low) AS low52 FROM fdx_candles
     WHERE company_id = ? AND interval = '1d' AND open_time >= ?`
  ).bind(company.id, yearAgo).first();

  // Get bid/ask
  const bestBid = await env.DB.prepare(
    `SELECT COALESCE(MAX(limit_price), 0) AS price FROM fdx_orders
     WHERE company_id = ? AND side = 'BUY' AND status IN ('open','partial') AND limit_price IS NOT NULL`
  ).bind(company.id).first();

  const bestAsk = await env.DB.prepare(
    `SELECT COALESCE(MIN(limit_price), 0) AS price FROM fdx_orders
     WHERE company_id = ? AND side = 'SELL' AND status IN ('open','partial') AND limit_price IS NOT NULL`
  ).bind(company.id).first();

  // Compute P/E ratio
  const eps = company.total_shares > 0 ? company.fundamental_earnings / company.total_shares : 0;
  const peRatio = eps > 0 ? Math.round((company.current_price / eps) * 100) / 100 : null;

  return json({
    ...company,
    high52w: (highLow && highLow.high52) || null,
    low52w: (highLow && highLow.low52) || null,
    bestBid: (bestBid && bestBid.price) || null,
    bestAsk: (bestAsk && bestAsk.price) || null,
    peRatio,
    change: company.prev_close_price ? Math.round((company.current_price - company.prev_close_price) * 100) / 100 : 0,
    changePct: company.prev_close_price ? Math.round(((company.current_price - company.prev_close_price) / company.prev_close_price) * 10000) / 100 : 0,
  });
}

// ── GET /api/exchange/companies/:ticker/candles ───────────────────
export async function getCompanyCandles(request, env, ticker) {
  const company = await env.DB.prepare(
    'SELECT id FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  const url = new URL(request.url);
  const interval = url.searchParams.get('interval') || '1h';
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));

  if (!['5m','1h','1d'].includes(interval)) {
    return json({ error: 'Interval must be 5m, 1h, or 1d.' }, { status: 400 });
  }

  const { results } = await env.DB.prepare(
    `SELECT * FROM fdx_candles WHERE company_id = ? AND interval = ?
     ORDER BY open_time DESC LIMIT ?`
  ).bind(company.id, interval, limit).all();

  return json((results || []).reverse());
}

// ── GET /api/exchange/companies/:ticker/orderbook ─────────────────
export async function getOrderBook(request, env, ticker) {
  const company = await env.DB.prepare(
    'SELECT id FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  const { results: bids } = await env.DB.prepare(
    `SELECT limit_price, SUM(quantity - quantity_filled) AS total_qty
     FROM fdx_orders
     WHERE company_id = ? AND side = 'BUY' AND status IN ('open','partial') AND limit_price IS NOT NULL
     GROUP BY limit_price ORDER BY limit_price DESC LIMIT 10`
  ).bind(company.id).all();

  const { results: asks } = await env.DB.prepare(
    `SELECT limit_price, SUM(quantity - quantity_filled) AS total_qty
     FROM fdx_orders
     WHERE company_id = ? AND side = 'SELL' AND status IN ('open','partial') AND limit_price IS NOT NULL
     GROUP BY limit_price ORDER BY limit_price ASC LIMIT 10`
  ).bind(company.id).all();

  return json({ bids: bids || [], asks: asks || [] });
}

// ── GET /api/exchange/companies/:ticker/trades ────────────────────
export async function getCompanyTrades(request, env, ticker) {
  const company = await env.DB.prepare(
    'SELECT id FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  const { results } = await env.DB.prepare(
    `SELECT id, quantity, price, total_value, executed_at
     FROM fdx_trades WHERE company_id = ?
     ORDER BY executed_at DESC LIMIT 50`
  ).bind(company.id).all();

  return json(results || []);
}

// ── GET /api/exchange/companies/:ticker/shareholders ──────────────
export async function getCompanyShareholders(request, env, ticker) {
  const company = await env.DB.prepare(
    'SELECT id, total_shares FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  const { results } = await env.DB.prepare(
    `SELECT p.account_id, p.quantity,
            ROUND(100.0 * p.quantity / ?, 2) AS pct_owned
     FROM fdx_portfolios p
     WHERE p.company_id = ? AND p.quantity > 0
     ORDER BY p.quantity DESC LIMIT 20`
  ).bind(company.total_shares, company.id).all();

  // Mask account IDs to just show first 4 chars
  return json((results || []).map(r => ({
    ...r,
    account_id: (r.account_id || '').substring(0, 4) + '***',
    pct_owned: parseFloat(r.pct_owned),
  })));
}

// ── GET /api/exchange/index ───────────────────────────────────────
export async function getIndex(request, env) {
  const latest = await env.DB.prepare(
    'SELECT * FROM fdx_index_snapshots ORDER BY snapped_at DESC LIMIT 1'
  ).first();

  const url = new URL(request.url);
  const limit = Math.min(720, Math.max(1, parseInt(url.searchParams.get('limit') || '288', 10) || 288));

  const { results: history } = await env.DB.prepare(
    'SELECT * FROM fdx_index_snapshots ORDER BY snapped_at DESC LIMIT ?'
  ).bind(limit).all();

  return json({
    current: latest || { index_value: 1000, total_market_cap: 0, advancing: 0, declining: 0, unchanged: 0 },
    history: (history || []).reverse(),
  });
}

// ── GET /api/exchange/companies/:ticker/reports ───────────────────
export async function getCompanyReports(request, env, ticker) {
  const company = await env.DB.prepare(
    'SELECT id FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  const { results } = await env.DB.prepare(
    `SELECT * FROM fdx_company_reports WHERE company_id = ? AND published = 1
     ORDER BY filed_at DESC LIMIT 20`
  ).bind(company.id).all();

  return json(results || []);
}

// ── POST /api/exchange/orders ─────────────────────────────────────
export async function placeOrder(request, env) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;
  const { user, account } = result;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { ticker, side, order_type = 'LIMIT', quantity, limit_price, stop_price, time_in_force = 'GTC' } = body;

  // Validate
  if (!ticker || !side || !quantity) {
    return json({ error: 'ticker, side, and quantity are required.' }, { status: 400 });
  }
  if (!['BUY', 'SELL'].includes(side.toUpperCase())) {
    return json({ error: 'side must be BUY or SELL.' }, { status: 400 });
  }
  if (!['MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LIMIT'].includes(order_type.toUpperCase())) {
    return json({ error: 'Invalid order_type.' }, { status: 400 });
  }
  if (!['GTC', 'DAY', 'IOC', 'FOK'].includes(time_in_force.toUpperCase())) {
    return json({ error: 'Invalid time_in_force.' }, { status: 400 });
  }

  const company = await env.DB.prepare(
    'SELECT * FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return json({ error: 'Company not found.' }, { status: 404 });
  if (company.status !== 'active') {
    return json({ error: `Trading is currently ${company.status} for ${ticker}.` }, { status: 400 });
  }

  const qty = parseInt(quantity, 10);
  if (!Number.isFinite(qty) || qty <= 0 || qty !== Number(quantity)) {
    return json({ error: 'quantity must be a positive integer.' }, { status: 400 });
  }

  const limPrice = limit_price !== undefined && limit_price !== null ? parseFloat(limit_price) : null;
  const stopPrice = stop_price !== undefined && stop_price !== null ? parseFloat(stop_price) : null;

  if (order_type.toUpperCase() === 'LIMIT' && (limPrice === null || limPrice <= 0)) {
    return json({ error: 'limit_price is required for LIMIT orders.' }, { status: 400 });
  }
  if ((order_type.toUpperCase() === 'STOP_LOSS' || order_type.toUpperCase() === 'STOP_LIMIT') && (stopPrice === null || stopPrice <= 0)) {
    return json({ error: 'stop_price is required for STOP_LOSS and STOP_LIMIT orders.' }, { status: 400 });
  }

  // Build order object for validation
  const orderData = {
    company_id: company.id,
    account_id: account.key,
    player_name: user.username,
    side: side.toUpperCase(),
    order_type: order_type.toUpperCase(),
    quantity: qty,
    limit_price: limPrice,
    stop_price: stopPrice,
    time_in_force: time_in_force.toUpperCase(),
  };

  // Run manipulation checks
  const flags = await manipulationGuard.validateOrderPreTrade(env.DB, orderData);
  const highFlags = flags.filter(f => f.severity === 'high' || f.severity === 'critical');
  if (highFlags.length > 0) {
    return json({
      error: 'Order rejected by market surveillance.',
      flags: highFlags.map(f => f.reason),
    }, { status: 403 });
  }

  // Pre-trade balance check for BUY orders
  if (side.toUpperCase() === 'BUY') {
    const lastPrice = company.current_price || company.ipo_price;
    const estimatedPrice = limPrice || lastPrice * 1.05;
    const estimatedCost = Math.ceil(qty * estimatedPrice * 1.01); // +1% buffer for market orders

    const available = await marketEngine.getAvailableBalance(env.DB, account.key);
    if (available < estimatedCost) {
      return json({
        error: `Insufficient balance. Need approximately ${estimatedCost}, available: ${available}.`,
      }, { status: 422 });
    }
  }

  // Pre-trade share check for SELL orders
  if (side.toUpperCase() === 'SELL') {
    const portfolio = await env.DB.prepare(
      'SELECT quantity FROM fdx_portfolios WHERE account_id = ? AND company_id = ?'
    ).bind(account.key, company.id).first();

    const held = (portfolio && portfolio.quantity) || 0;
    const openSellQty = await env.DB.prepare(
      `SELECT COALESCE(SUM(quantity - quantity_filled), 0) AS total
       FROM fdx_orders WHERE company_id = ? AND account_id = ? AND side = 'SELL'
       AND status IN ('open','partial')`
    ).bind(company.id, account.key).first();

    const committed = (openSellQty && openSellQty.total) || 0;
    const availableShares = held - committed;

    if (availableShares < qty) {
      return json({
        error: `Insufficient shares. You hold ${held}, ${committed} already committed to open orders.`,
      }, { status: 422 });
    }
  }

  // Handle IOC/FOK
  let tif = time_in_force.toUpperCase();
  let expiresAt = null;
  if (tif === 'DAY') {
    const eod = new Date();
    eod.setUTCHours(20, 0, 0, 0);
    if (eod <= new Date()) eod.setUTCDate(eod.getUTCDate() + 1);
    expiresAt = eod.toISOString();
  }

  // Insert order
  const result2 = await env.DB.prepare(
    `INSERT INTO fdx_orders
       (company_id, account_id, player_name, side, order_type, quantity, limit_price, stop_price, time_in_force, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).bind(company.id, account.key, user.username, side.toUpperCase(), order_type.toUpperCase(),
         qty, limPrice, stopPrice, tif, expiresAt).run();

  const orderId = result2.meta.last_row_id;

  // For IOC orders, run matching immediately
  if (tif === 'IOC' || tif === 'FOK') {
    await marketEngine.runMatchingEngine(env.DB);

    // Check if order filled
    const order = await env.DB.prepare('SELECT * FROM fdx_orders WHERE id = ?').bind(orderId).first();
    if (tif === 'FOK' && order.status !== 'filled') {
      await env.DB.prepare(
        `UPDATE fdx_orders SET status = 'rejected', cancelled_at = ? WHERE id = ?`
      ).bind(nowIso(), orderId).run();
      return json({ error: 'Order could not be filled immediately (FOK).' }, { status: 422 });
    }
    if (tif === 'IOC' && order.status === 'open') {
      await env.DB.prepare(
        `UPDATE fdx_orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?`
      ).bind(nowIso(), orderId).run();
    }
  } else {
    // For GTC/DAY orders, run matching engine
    await marketEngine.runMatchingEngine(env.DB);
  }

  const finalOrder = await env.DB.prepare('SELECT * FROM fdx_orders WHERE id = ?').bind(orderId).first();
  return json(finalOrder, { status: 201 });
}

// ── GET /api/exchange/orders ──────────────────────────────────────
export async function getMyOrders(request, env) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const { results } = await env.DB.prepare(
    `SELECT o.*, c.ticker, c.name AS company_name
     FROM fdx_orders o
     JOIN fdx_companies c ON c.id = o.company_id
     WHERE o.account_id = ?
     ORDER BY o.placed_at DESC LIMIT 100`
  ).bind(result.account.key).all();

  return json(results || []);
}

// ── DELETE /api/exchange/orders/:id ───────────────────────────────
export async function cancelOrder(request, env, orderId) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const order = await env.DB.prepare(
    'SELECT * FROM fdx_orders WHERE id = ? AND account_id = ?'
  ).bind(Number(orderId), result.account.key).first();

  if (!order) return json({ error: 'Order not found.' }, { status: 404 });
  if (!['open', 'partial'].includes(order.status)) {
    return json({ error: 'Order cannot be cancelled (already ' + order.status + ').' }, { status: 400 });
  }

  // Check spoofing before cancellation
  const placedAt = new Date(order.placed_at);
  const secondsOpen = (Date.now() - placedAt.getTime()) / 1000;
  const spoofCheck = await manipulationGuard.checkSpoofing(env.DB, order, secondsOpen);
  if (spoofCheck) {
    await manipulationGuard.flagOrder(env.DB, order.id, spoofCheck.reason);
  }

  await env.DB.prepare(
    `UPDATE fdx_orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?`
  ).bind(nowIso(), Number(orderId)).run();

  return json({ ok: true });
}

// ── GET /api/exchange/trades ──────────────────────────────────────
export async function getMyTrades(request, env) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const { results } = await env.DB.prepare(
    `SELECT t.*, c.ticker, c.name AS company_name
     FROM fdx_trades t
     JOIN fdx_companies c ON c.id = t.company_id
     WHERE t.buyer_account = ? OR t.seller_account = ?
     ORDER BY t.executed_at DESC LIMIT 100`
  ).bind(result.account.key, result.account.key).all();

  return json(results || []);
}

// ── GET /api/exchange/portfolio ───────────────────────────────────
export async function getMyPortfolio(request, env) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const { results: holdings } = await env.DB.prepare(
    `SELECT p.*, c.ticker, c.name AS company_name, c.current_price, c.logo_emoji, c.sector
     FROM fdx_portfolios p
     JOIN fdx_companies c ON c.id = p.company_id
     WHERE p.account_id = ? AND p.quantity > 0
     ORDER BY (p.quantity * c.current_price) DESC`
  ).bind(result.account.key).all();

  // Calculate summary
  let totalValue = 0, totalInvested = 0;
  const enriched = (holdings || []).map(h => {
    const currValue = Math.round(h.quantity * h.current_price * 100) / 100;
    const unrealizedPnl = Math.round((currValue - h.total_invested) * 100) / 100;
    totalValue += currValue;
    totalInvested += h.total_invested;
    return {
      ...h,
      currentValue: currValue,
      unrealizedPnl,
      unrealizedPnlPct: h.total_invested > 0 ? Math.round((unrealizedPnl / h.total_invested) * 10000) / 100 : 0,
    };
  });

  return json({
    holdings: enriched,
    summary: {
      totalValue: Math.round(totalValue * 100) / 100,
      totalInvested: Math.round(totalInvested * 100) / 100,
      totalPnl: Math.round((totalValue - totalInvested) * 100) / 100,
      totalPnlPct: totalInvested > 0 ? Math.round(((totalValue - totalInvested) / totalInvested) * 10000) / 100 : 0,
    },
  });
}

// ── POST /api/exchange/watchlist/:ticker ──────────────────────────
export async function addToWatchlist(request, env, ticker) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const company = await env.DB.prepare(
    'SELECT id FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  try {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO fdx_watchlist (account_id, company_id) VALUES (?, ?)'
    ).bind(result.account.key, company.id).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: 'Already in watchlist.' }, { status: 409 });
  }
}

// ── DELETE /api/exchange/watchlist/:ticker ────────────────────────
export async function removeFromWatchlist(request, env, ticker) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const company = await env.DB.prepare(
    'SELECT id FROM fdx_companies WHERE ticker = ?'
  ).bind(ticker.toUpperCase()).first();

  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  await env.DB.prepare(
    'DELETE FROM fdx_watchlist WHERE account_id = ? AND company_id = ?'
  ).bind(result.account.key, company.id).run();

  return json({ ok: true });
}

// ── GET /api/exchange/watchlist ───────────────────────────────────
export async function getWatchlist(request, env) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.ticker, c.name, c.current_price, c.prev_close_price, c.logo_emoji, c.sector
     FROM fdx_watchlist w
     JOIN fdx_companies c ON c.id = w.company_id
     WHERE w.account_id = ?
     ORDER BY c.ticker ASC`
  ).bind(result.account.key).all();

  return json((results || []).map(c => ({
    ...c,
    change: c.prev_close_price ? Math.round((c.current_price - c.prev_close_price) * 100) / 100 : 0,
    changePct: c.prev_close_price ? Math.round(((c.current_price - c.prev_close_price) / c.prev_close_price) * 10000) / 100 : 0,
  })));
}

// ── GET /api/exchange/sectors ─────────────────────────────────────
export async function getSectors(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT sector, COUNT(*) AS count, SUM(market_cap) AS total_market_cap
     FROM fdx_companies WHERE status IN ('active','halted')
     GROUP BY sector ORDER BY total_market_cap DESC`
  ).all();

  return json(results || []);
}

// ════════════════════════════════════════════════════════════════
// OFFERINGS — Player endpoints
// ════════════════════════════════════════════════════════════════

// ── GET /api/exchange/ipo ─────────────────────────────────────────
export async function listIpos(request, env) {
  // Active offerings (status = 'ipo')
  const { results: active } = await env.DB.prepare(
    `SELECT c.*, COUNT(o.id) AS subscription_count,
            COALESCE(SUM(o.quantity), 0) AS total_subscribed
     FROM fdx_companies c
     LEFT JOIN fdx_orders o ON o.company_id = c.id
       AND o.status = 'pending_ipo'
     WHERE c.status = 'ipo'
     GROUP BY c.id
     ORDER BY c.listed_at DESC`
  ).all();

  // Past offerings — companies that went through offering allocation (have IPO_ALLOCATE audit entries)
  const { results: past } = await env.DB.prepare(
    `SELECT DISTINCT c.ticker, c.name, c.ipo_price, c.current_price, c.listed_at, c.status
     FROM fdx_companies c
     INNER JOIN fdx_audit_log al ON al.entity_type = 'company'
       AND al.entity_id = c.id AND al.action = 'IPO_ALLOCATE'
     WHERE c.status IN ('active','halted','delisted')
     ORDER BY c.listed_at DESC LIMIT 20`
  ).all();

  const enrichedActive = (active || []).map(ipo => ({
    ...ipo,
    oversubscription: ipo.total_subscribed > ipo.shares_in_float
      ? Math.round((ipo.total_subscribed / ipo.shares_in_float) * 100) / 100 : null,
    remaining: Math.max(0, ipo.shares_in_float - ipo.total_subscribed),
  }));

  const enrichedPast = (past || []).map(ipo => ({
    ...ipo,
    returnPct: ipo.current_price > 0
      ? Math.round(((ipo.current_price - ipo.ipo_price) / ipo.ipo_price) * 10000) / 100
      : null,
  }));

  return json({ active: enrichedActive, past: enrichedPast });
}

// ── POST /api/exchange/ipo/:companyId/subscribe ───────────────────
export async function subscribeToIpo(request, env, companyId) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;
  const { user, account } = result;

  const company = await env.DB.prepare(
    'SELECT * FROM fdx_companies WHERE id = ? AND status = ?'
  ).bind(Number(companyId), 'ipo').first();

  if (!company) return json({ error: 'Offering not found or not open for subscription.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const qty = parseInt(body.quantity, 10);
  if (!Number.isFinite(qty) || qty <= 0 || qty !== Number(body.quantity)) {
    return json({ error: 'quantity must be a positive integer.' }, { status: 400 });
  }

  // Check balance
  const totalCost = Math.round(qty * company.ipo_price * 100) / 100;
  const available = await marketEngine.getAvailableBalance(env.DB, account.key);
  if (available < totalCost) {
    return json({
      error: `Insufficient balance. Offering cost: ${totalCost}, available: ${available}.`,
    }, { status: 422 });
  }

  // Check if already subscribed — update existing or create new
  const existing = await env.DB.prepare(
    `SELECT * FROM fdx_orders
     WHERE company_id = ? AND account_id = ? AND status = 'pending_ipo'`
  ).bind(company.id, account.key).first();

  if (existing) {
    // Cancel old and replace with new quantity
    await env.DB.prepare(
      "UPDATE fdx_orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?"
    ).bind(nowIso(), existing.id).run();
  }

  await env.DB.prepare(
    `INSERT INTO fdx_orders
       (company_id, account_id, player_name, side, order_type, quantity, limit_price, time_in_force, status)
     VALUES (?, ?, ?, 'BUY', 'MARKET', ?, ?, 'GTC', 'pending_ipo')`
  ).bind(company.id, account.key, user.username, qty, company.ipo_price).run();

  return json({ ok: true, ticker: company.ticker, quantity: qty, ipo_price: company.ipo_price }, { status: 201 });
}

// ── DELETE /api/exchange/ipo/:companyId/subscribe ─────────────────
export async function cancelIpoSubscription(request, env, companyId) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const company = await env.DB.prepare(
    'SELECT id FROM fdx_companies WHERE id = ? AND status = ?'
  ).bind(Number(companyId), 'ipo').first();

  if (!company) return json({ error: 'Offering not found.' }, { status: 404 });

  await env.DB.prepare(
    `UPDATE fdx_orders SET status = 'cancelled', cancelled_at = ?
     WHERE company_id = ? AND account_id = ? AND status = 'pending_ipo'`
  ).bind(nowIso(), company.id, result.account.key).run();

  return json({ ok: true });
}

// ── GET /api/exchange/ipo/my ──────────────────────────────────────
export async function getMyIpoSubscriptions(request, env) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const { results } = await env.DB.prepare(
    `SELECT o.*, c.ticker, c.name AS company_name, c.ipo_price, c.shares_in_float
     FROM fdx_orders o
     JOIN fdx_companies c ON c.id = o.company_id
     WHERE o.account_id = ? AND o.status = 'pending_ipo'
     ORDER BY o.placed_at DESC`
  ).bind(result.account.key).all();

  return json(results || []);
}
