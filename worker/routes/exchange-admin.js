/* ============================================================
   Regnum Aeternum — Worker
   Fiducia Exchange: Admin API routes.
   Company management, halts, dividends, oversight.
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser, hasRole } from './auth.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function nowIso() { return new Date().toISOString(); }

async function requireAdmin(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return { error: json({ error: 'Authentication required.' }, { status: 401 }) };
  if (!hasRole(user, 'admin') && !hasRole(user, 'banker')) {
    return { error: json({ error: 'Admin or banker role required.' }, { status: 403 }) };
  }
  return { user };
}

// ── PUT /api/exchange/admin/companies/:id ─────────────────────────
export async function updateCompany(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const sets = [];
  const binds = [];
  const allowed = ['name', 'sector', 'description', 'logo_emoji', 'linked_bank_account',
                   'fundamental_beta', 'status'];
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  if (sets.length === 0) return json(company);

  sets.push("updated_at = ?");
  binds.push(nowIso(), Number(id));

  await env.DB.prepare(`UPDATE fdx_companies SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds).run();

  // Audit log
  await env.DB.prepare(
    `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, 'UPDATE_COMPANY', 'company', ?, ?)`
  ).bind(auth.user.username, Number(id), JSON.stringify(body)).run();

  const updated = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  return json(updated);
}

// ── PUT /api/exchange/admin/companies/:id/fundamentals ────────────
export async function updateFundamentals(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { fundamental_earnings, fundamental_assets, fundamental_liabilities,
          fundamental_revenue, fundamental_growth_rate, report_type, period_label,
          headline, body_text } = body;

  const sets = [];
  const binds = [];
  const allowedFund = {
    fundamental_earnings: 'fundamental_earnings',
    fundamental_assets: 'fundamental_assets',
    fundamental_liabilities: 'fundamental_liabilities',
    fundamental_revenue: 'fundamental_revenue',
    fundamental_growth_rate: 'fundamental_growth_rate',
  };

  for (const [k, col] of Object.entries(allowedFund)) {
    if (body[k] !== undefined && body[k] !== null) {
      sets.push(`${col} = ?`);
      binds.push(Number(body[k]));
    }
  }

  if (sets.length > 0) {
    sets.push("updated_at = ?");
    binds.push(nowIso(), Number(id));
    await env.DB.prepare(`UPDATE fdx_companies SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds).run();
  }

  // File a company report if headline provided
  if (headline) {
    await env.DB.prepare(
      `INSERT INTO fdx_company_reports
         (company_id, report_type, period_label, headline, body, earnings_change, revenue_change, assets_change, filed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(Number(id), report_type || 'QUARTERLY', period_label || '', headline,
           body_text || '', body.fundamental_earnings !== undefined ? Number(body.fundamental_earnings) - (company.fundamental_earnings || 0) : null,
           body.fundamental_revenue !== undefined ? Number(body.fundamental_revenue) - (company.fundamental_revenue || 0) : null,
           body.fundamental_assets !== undefined ? Number(body.fundamental_assets) - (company.fundamental_assets || 0) : null,
           auth.user.username).run();
  }

  // Audit log
  await env.DB.prepare(
    `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, 'UPDATE_FUNDAMENTALS', 'company', ?, ?)`
  ).bind(auth.user.username, Number(id), JSON.stringify(body)).run();

  const updated = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  return json(updated);
}

// ── POST /api/exchange/admin/companies/:id/halt ───────────────────
export async function haltCompany(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });
  if (company.status === 'halted') return json({ error: 'Already halted.' }, { status: 400 });

  let body;
  try { body = await request.json(); }
  catch { body = {}; }
  const reason = body.reason || 'Administrative halt';

  await env.DB.prepare(
    `UPDATE fdx_companies SET status = 'halted', halt_reason = ?, updated_at = ? WHERE id = ?`
  ).bind(reason, nowIso(), Number(id)).run();

  await env.DB.prepare(
    `INSERT INTO fdx_halt_log (company_id, halt_type, triggered_by, reason)
     VALUES (?, 'ADMIN_HALT', ?, ?)`
  ).bind(Number(id), auth.user.username, reason).run();

  return json({ ok: true, status: 'halted', reason });
}

// ── POST /api/exchange/admin/companies/:id/resume ─────────────────
export async function resumeCompany(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });
  if (company.status !== 'halted') return json({ error: 'Company is not halted.' }, { status: 400 });

  await env.DB.prepare(
    `UPDATE fdx_companies SET status = 'active', halt_reason = NULL, updated_at = ? WHERE id = ?`
  ).bind(nowIso(), Number(id)).run();

  // Update halt log with resume time
  await env.DB.prepare(
    `UPDATE fdx_halt_log SET resumed_at = ?
     WHERE company_id = ? AND resumed_at IS NULL ORDER BY halted_at DESC LIMIT 1`
  ).bind(nowIso(), Number(id)).run();

  return json({ ok: true, status: 'active' });
}

// ── POST /api/exchange/admin/companies/:id/shares/issue ───────────
export async function issueShares(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const count = parseInt(body.count, 10);
  if (!Number.isFinite(count) || count <= 0) {
    return json({ error: 'count must be a positive integer.' }, { status: 400 });
  }

  const newTotal = company.total_shares + count;
  const newFloat = company.shares_in_float + count;

  await env.DB.prepare(
    `UPDATE fdx_companies SET total_shares = ?, shares_in_float = ?, updated_at = ? WHERE id = ?`
  ).bind(newTotal, newFloat, nowIso(), Number(id)).run();

  await env.DB.prepare(
    `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, 'ISSUE_SHARES', 'company', ?, ?)`
  ).bind(auth.user.username, Number(id),
         JSON.stringify({ count, before: company.total_shares, after: newTotal })).run();

  return json({ ok: true, total_shares: newTotal, shares_in_float: newFloat });
}

// ── POST /api/exchange/admin/companies/:id/shares/buyback ─────────
export async function buybackShares(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const count = parseInt(body.count, 10);
  if (!Number.isFinite(count) || count <= 0) {
    return json({ error: 'count must be a positive integer.' }, { status: 400 });
  }
  if (count > company.shares_in_float) {
    return json({ error: 'Cannot buy back more than shares in float.' }, { status: 400 });
  }

  // Validate treasury funds if company has a linked bank account
  const cost = Math.round(count * (company.current_price || company.ipo_price) * 100) / 100;
  if (company.linked_bank_account) {
    const treasury = await env.DB.prepare(
      'SELECT balance FROM banking_accounts WHERE key = ?'
    ).bind(company.linked_bank_account).first();
    if (!treasury) {
      return json({ error: 'Linked bank account does not exist.' }, { status: 400 });
    }
    if (treasury.balance < cost) {
      return json({
        error: `Insufficient treasury funds. Need ${cost}, available: ${treasury.balance}.`,
      }, { status: 422 });
    }
  }

  const newTotal = company.total_shares - count;
  const newFloat = company.shares_in_float - count;

  await env.DB.prepare(
    `UPDATE fdx_companies SET total_shares = ?, shares_in_float = ?, updated_at = ? WHERE id = ?`
  ).bind(newTotal, newFloat, nowIso(), Number(id)).run();

  // If linked bank account, deduct buyback cost from treasury
  if (company.linked_bank_account && cost > 0) {
    const account = await env.DB.prepare(
      'SELECT balance FROM banking_accounts WHERE key = ?'
    ).bind(company.linked_bank_account).first();
    if (account) {
      const newBalance = Math.round((account.balance - cost) * 100) / 100;
      const now = nowIso();
      await env.DB.batch([
        env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?')
          .bind(newBalance, now, company.linked_bank_account),
        env.DB.prepare(
          `INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(company.linked_bank_account, '__exchange__', cost, newBalance, 0,
               `Buyback ${count} ${company.ticker} @ ${company.current_price || company.ipo_price}`,
               `admin:${auth.user.username}`, now),
      ]);
    }
  }

  await env.DB.prepare(
    `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, 'BUYBACK_SHARES', 'company', ?, ?)`
  ).bind(auth.user.username, Number(id),
         JSON.stringify({ count, cost, before: company.total_shares, after: newTotal })).run();

  return json({ ok: true, total_shares: newTotal, shares_in_float: newFloat, cost });
}

// ── POST /api/exchange/admin/dividends ────────────────────────────
export async function declareDividend(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { ticker, dividend_per_share, record_date, pay_date } = body;
  if (!ticker || !dividend_per_share || !pay_date) {
    return json({ error: 'ticker, dividend_per_share, and pay_date are required.' }, { status: 400 });
  }

  const company = await env.DB.prepare('SELECT id FROM fdx_companies WHERE ticker = ?')
    .bind(ticker.toUpperCase()).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  const dps = parseFloat(dividend_per_share);
  if (!Number.isFinite(dps) || dps <= 0) {
    return json({ error: 'dividend_per_share must be positive.' }, { status: 400 });
  }

  const result = await env.DB.prepare(
    `INSERT INTO fdx_dividends (company_id, dividend_per_share, record_date, pay_date, declared_by)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(company.id, dps, record_date || nowIso(), pay_date, auth.user.username).run();

  return json({ ok: true, id: result.meta.last_row_id }, { status: 201 });
}

// ── DELETE /api/exchange/admin/dividends/:id ──────────────────────
export async function cancelDividend(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const dividend = await env.DB.prepare('SELECT * FROM fdx_dividends WHERE id = ?')
    .bind(Number(id)).first();
  if (!dividend) return json({ error: 'Dividend not found.' }, { status: 404 });
  if (dividend.status !== 'pending') {
    return json({ error: 'Only pending dividends can be cancelled.' }, { status: 400 });
  }

  await env.DB.prepare(
    "UPDATE fdx_dividends SET status = 'cancelled' WHERE id = ?"
  ).bind(Number(id)).run();

  return json({ ok: true });
}

// ── GET /api/exchange/admin/companies ─────────────────────────────
export async function listAllCompanies(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  const baseSelect = `SELECT c.*, o.name AS owner_name
     FROM fdx_companies c
     LEFT JOIN banking_accounts ba ON ba.key = c.linked_bank_account
     LEFT JOIN banking_accounts o  ON o.key = ba.owner_key`;

  const { results } = status
    ? await env.DB.prepare(`${baseSelect} WHERE c.status = ? ORDER BY c.ticker ASC`).bind(status).all()
    : await env.DB.prepare(`${baseSelect} ORDER BY c.ticker ASC`).all();

  return json(results || []);
}

// ── GET /api/exchange/admin/dividends ─────────────────────────────
export async function listDividends(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';

  const { results } = await env.DB.prepare(
    `SELECT d.*, c.ticker, c.name AS company_name
     FROM fdx_dividends d
     JOIN fdx_companies c ON c.id = d.company_id
     WHERE d.status = ?
     ORDER BY d.pay_date ASC`
  ).bind(status).all();

  return json(results || []);
}

// ── GET /api/exchange/admin/audit ─────────────────────────────────
export async function getAuditLog(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

  const { results } = await env.DB.prepare(
    'SELECT * FROM fdx_audit_log ORDER BY performed_at DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();

  return json(results || []);
}

// ── GET /api/exchange/admin/halts ─────────────────────────────────
export async function getHaltHistory(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const { results } = await env.DB.prepare(
    `SELECT h.*, c.ticker, c.name AS company_name
     FROM fdx_halt_log h
     LEFT JOIN fdx_companies c ON c.id = h.company_id
     ORDER BY h.halted_at DESC LIMIT 100`
  ).all();

  return json(results || []);
}

// ── GET /api/exchange/admin/flagged/orders ────────────────────────
export async function getFlaggedOrders(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const { results } = await env.DB.prepare(
    `SELECT o.*, c.ticker
     FROM fdx_orders o
     JOIN fdx_companies c ON c.id = o.company_id
     WHERE o.flagged = 1
     ORDER BY o.placed_at DESC LIMIT 100`
  ).all();

  return json(results || []);
}

// ── GET /api/exchange/admin/flagged/trades ────────────────────────
export async function getFlaggedTrades(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const { results } = await env.DB.prepare(
    `SELECT t.*, c.ticker
     FROM fdx_trades t
     JOIN fdx_companies c ON c.id = t.company_id
     WHERE t.flagged = 1
     ORDER BY t.executed_at DESC LIMIT 100`
  ).all();

  return json(results || []);
}

// ── POST /api/exchange/admin/flagged/orders/:id/dismiss ───────────
export async function dismissFlaggedOrder(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  await env.DB.prepare(
    'UPDATE fdx_orders SET flagged = 0, flag_reason = NULL WHERE id = ?'
  ).bind(Number(id)).run();

  return json({ ok: true });
}

// ── POST /api/exchange/admin/flagged/trades/:id/dismiss ───────────
export async function dismissFlaggedTrade(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  await env.DB.prepare(
    'UPDATE fdx_trades SET flagged = 0, flag_reason = NULL WHERE id = ?'
  ).bind(Number(id)).run();

  return json({ ok: true });
}

// ── PUT /api/exchange/admin/settings ──────────────────────────────
export async function updateSettings(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  if (!hasRole(auth.user, 'admin')) {
    return json({ error: 'Admin role required for settings.' }, { status: 403 });
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  for (const [key, value] of Object.entries(body)) {
    await env.DB.prepare(
      `INSERT INTO fdx_settings (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_by = ?, updated_at = ?`
    ).bind(key, String(value), auth.user.username, nowIso(),
           String(value), auth.user.username, nowIso()).run();
  }

  return json({ ok: true });
}

// ── GET /api/exchange/admin/settings ──────────────────────────────
export async function getSettings(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const { results } = await env.DB.prepare('SELECT * FROM fdx_settings').all();
  const settings = {};
  for (const row of (results || [])) {
    settings[row.key] = row.value;
  }
  return json(settings);
}

// ── POST /api/exchange/admin/halt ─────────────────────────────────
export async function globalHalt(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { body = {}; }
  const reason = body.reason || 'Global market halt';

  await env.DB.prepare(
    `UPDATE fdx_companies SET status = 'halted', halt_reason = ?, updated_at = ?
     WHERE status = 'active'`
  ).bind(reason, nowIso()).run();

  await env.DB.prepare(
    `INSERT INTO fdx_halt_log (company_id, halt_type, triggered_by, reason)
     VALUES (NULL, 'ADMIN_HALT', ?, ?)`
  ).bind(auth.user.username, reason).run();

  return json({ ok: true });
}

// ── POST /api/exchange/admin/resume ───────────────────────────────
export async function globalResume(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  await env.DB.prepare(
    `UPDATE fdx_companies SET status = 'active', halt_reason = NULL, updated_at = ?
     WHERE status = 'halted'`
  ).bind(nowIso()).run();

  await env.DB.prepare(
    `UPDATE fdx_halt_log SET resumed_at = ?
     WHERE resumed_at IS NULL`
  ).bind(nowIso()).run();

  return json({ ok: true });
}

// ── GET /api/exchange/admin/reports ───────────────────────────────
export async function getReports(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const ticker = url.searchParams.get('ticker');

  let query, params;
  if (ticker) {
    query = `SELECT r.*, c.ticker, c.name AS company_name
             FROM fdx_company_reports r
             JOIN fdx_companies c ON c.id = r.company_id
             WHERE c.ticker = ?
             ORDER BY r.filed_at DESC LIMIT 50`;
    params = [ticker.toUpperCase()];
  } else {
    query = `SELECT r.*, c.ticker, c.name AS company_name
             FROM fdx_company_reports r
             JOIN fdx_companies c ON c.id = r.company_id
             ORDER BY r.filed_at DESC LIMIT 50`;
    params = [];
  }

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results || []);
}

// ── POST /api/exchange/admin/reports ──────────────────────────────
export async function createReport(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { ticker, report_type, period_label, headline, body_text } = body;
  if (!ticker || !headline) {
    return json({ error: 'ticker and headline are required.' }, { status: 400 });
  }

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE ticker = ?')
    .bind(ticker.toUpperCase()).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  // Compute deltas from current fundamentals
  const earningsChange = body.earnings_change !== undefined ? Number(body.earnings_change) : null;
  const revenueChange = body.revenue_change !== undefined ? Number(body.revenue_change) : null;
  const assetsChange = body.assets_change !== undefined ? Number(body.assets_change) : null;

  const result = await env.DB.prepare(
    `INSERT INTO fdx_company_reports
       (company_id, report_type, period_label, headline, body, earnings_change, revenue_change, assets_change, filed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(company.id, report_type || 'QUARTERLY', period_label || '',
         headline, body_text || '', earningsChange, revenueChange, assetsChange,
         auth.user.username).run();

  // If fundamental changes were included in the body, apply them
  const fundFields = ['fundamental_earnings', 'fundamental_assets', 'fundamental_liabilities',
                      'fundamental_revenue', 'fundamental_growth_rate'];
  const sets = [];
  const binds = [];
  for (const f of fundFields) {
    if (body[f] !== undefined && body[f] !== null) {
      sets.push(`${f} = ?`);
      binds.push(Number(body[f]));
    }
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    binds.push(nowIso(), company.id);
    await env.DB.prepare(`UPDATE fdx_companies SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds).run();
  }

  await env.DB.prepare(
    `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, 'FILE_REPORT', 'company', ?, ?)`
  ).bind(auth.user.username, company.id,
         JSON.stringify({ headline, report_type: report_type || 'QUARTERLY' })).run();

  const report = await env.DB.prepare('SELECT * FROM fdx_company_reports WHERE id = ?')
    .bind(result.meta.last_row_id).first();

  // Auto-create a Times of Regnum news article from this report
  try {
    const articleTitle = `${company.ticker}: ${headline}`;
    const articleContent = `**${company.name} (${company.ticker})** filed a ${report_type || 'QUARTERLY'} report${period_label ? ' for ' + period_label : ''}.

${body_text || ''}

${earningsChange !== null ? `- Earnings change: ${earningsChange >= 0 ? '+' : ''}${earningsChange.toFixed(2)}
` : ''}${revenueChange !== null ? `- Revenue change: ${revenueChange >= 0 ? '+' : ''}${revenueChange.toFixed(2)}
` : ''}${assetsChange !== null ? `- Assets change: ${assetsChange >= 0 ? '+' : ''}${assetsChange.toFixed(2)}
` : ''}

*Current price: ${formatNum(company.current_price || company.ipo_price || 0)} | Market cap: ${formatNum((company.current_price || company.ipo_price || 0) * (company.total_shares || 0))}*`;

    const article = await store.insertArticle(env, {
      title: articleTitle,
      subtitle: `${company.name} — ${report_type || 'QUARTERLY'} Report`,
      content: articleContent,
      author: 'exchange:report',
    });
    // Auto-publish (admin-filed reports go straight to published)
    await store.updateArticle(env, article.id, { status: 'published', published_at: nowIso() });
  } catch (err) {
    // News article creation is best-effort; don't fail the report if it errors
    console.error('Auto-news creation error:', err.message);
  }

  return json(report, { status: 201 });
}

function formatNum(n) { return n != null ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'; }

// ── POST /api/exchange/admin/companies/:id/split ──────────────────
export async function stockSplit(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  if (!hasRole(auth.user, 'admin')) {
    return json({ error: 'Admin role required.' }, { status: 403 });
  }

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { ratio_numerator, ratio_denominator } = body;
  const num = parseInt(ratio_numerator, 10);
  const den = parseInt(ratio_denominator, 10);

  if (!num || !den || num <= 0 || den <= 0) {
    return json({ error: 'ratio_numerator and ratio_denominator must be positive integers.' }, { status: 400 });
  }
  if (num === den) return json({ error: 'Split ratio cannot be 1:1.' }, { status: 400 });

  const ratio = num / den;
  const now = nowIso();

  // Update company shares and price
  const newTotal = Math.round(company.total_shares * ratio);
  const newFloat = Math.round(company.shares_in_float * ratio);
  const newPrice = Math.round((company.current_price / ratio) * 100) / 100;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE fdx_companies SET total_shares = ?, shares_in_float = ?,
         current_price = ?, ipo_price = ?,
         updated_at = ? WHERE id = ?`
    ).bind(newTotal, newFloat, newPrice,
           Math.round((company.ipo_price / ratio) * 100) / 100,
           now, Number(id)),

    // Update all portfolios for this company
    env.DB.prepare(
      `UPDATE fdx_portfolios SET quantity = ROUND(quantity * ?),
         average_cost = ROUND(average_cost / ?, 2),
         total_invested = ROUND(total_invested, 2),
         last_updated = ?
       WHERE company_id = ?`
    ).bind(ratio, ratio, now, Number(id)),

    // Update open orders
    env.DB.prepare(
      `UPDATE fdx_orders SET quantity = ROUND(quantity * ?),
         quantity_filled = ROUND(quantity_filled * ?),
         limit_price = ROUND(COALESCE(limit_price, 0) / ?, 2),
         stop_price = ROUND(COALESCE(stop_price, 0) / ?, 2)
       WHERE company_id = ? AND status IN ('open','partial')
         AND order_type != 'MARKET'`
    ).bind(ratio, ratio, ratio, ratio, Number(id)),

    // Cancel all MARKET orders (price reference has changed)
    env.DB.prepare(
      `UPDATE fdx_orders SET status = 'cancelled', cancelled_at = ?
       WHERE company_id = ? AND order_type = 'MARKET'
         AND status IN ('open','partial')`
    ).bind(now, Number(id)),
  ]);

  await env.DB.prepare(
    `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, 'STOCK_SPLIT', 'company', ?, ?)`
  ).bind(auth.user.username, Number(id),
         JSON.stringify({ ratio: `${num}:${den}`, before_shares: company.total_shares, after_shares: newTotal, before_price: company.current_price, after_price: newPrice })).run();

  return json({ ok: true, total_shares: newTotal, shares_in_float: newFloat, current_price: newPrice });
}

// ── POST /api/exchange/admin/companies/:id/delist ─────────────────
export async function delistCompany(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  if (!hasRole(auth.user, 'admin')) {
    return json({ error: 'Admin role required.' }, { status: 403 });
  }

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });
  if (company.status === 'delisted') return json({ error: 'Already delisted.' }, { status: 400 });

  let body;
  try { body = await request.json(); }
  catch { body = {}; }
  const reason = body.reason || 'Voluntarily delisted';

  // Cancel all open orders
  await env.DB.prepare(
    `UPDATE fdx_orders SET status = 'cancelled', cancelled_at = ?
     WHERE company_id = ? AND status IN ('open','partial')`
  ).bind(nowIso(), Number(id)).run();

  // Update company status (clear halt_reason since we're delisting, not halting)
  await env.DB.prepare(
    `UPDATE fdx_companies SET status = 'delisted', halt_reason = NULL, updated_at = ? WHERE id = ?`
  ).bind(nowIso(), Number(id)).run();

  // Log halt
  await env.DB.prepare(
    `INSERT INTO fdx_halt_log (company_id, halt_type, triggered_by, reason)
     VALUES (?, 'DELISTING_NOTICE', ?, ?)`
  ).bind(Number(id), auth.user.username, reason).run();

  // Audit log
  await env.DB.prepare(
    `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, 'DELIST_COMPANY', 'company', ?, ?)`
  ).bind(auth.user.username, Number(id),
         JSON.stringify({ ticker: company.ticker, reason, final_price: company.current_price })).run();

  return json({ ok: true, status: 'delisted' });
}

// ── GET /api/exchange/admin/company/:ticker ───────────────────────
export async function getCompanyByTicker(request, env, ticker) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE ticker = ?')
    .bind(ticker.toUpperCase()).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });
  return json(company);
}

// ── PUT /api/exchange/admin/reports/:id ───────────────────────────
export async function updateReport(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const report = await env.DB.prepare('SELECT * FROM fdx_company_reports WHERE id = ?')
    .bind(Number(id)).first();
  if (!report) return json({ error: 'Report not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const sets = [];
  const binds = [];
  const allowed = ['headline', 'body', 'published', 'earnings_change', 'revenue_change', 'assets_change'];
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  if (sets.length === 0) return json(report);

  binds.push(Number(id));
  await env.DB.prepare(`UPDATE fdx_company_reports SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds).run();

  const updated = await env.DB.prepare('SELECT * FROM fdx_company_reports WHERE id = ?')
    .bind(Number(id)).first();
  return json(updated);
}

// ════════════════════════════════════════════════════════════════
// OFFERINGS — Admin endpoints
// ════════════════════════════════════════════════════════════════

// ── GET /api/exchange/admin/companies/:id/ipo/subscriptions ───────
export async function getIpoSubscriptions(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });

  const { results } = await env.DB.prepare(
    `SELECT o.id, o.account_id, o.player_name, o.quantity, o.placed_at,
            ba.name AS account_name
     FROM fdx_orders o
     LEFT JOIN banking_accounts ba ON ba.key = o.account_id
     WHERE o.company_id = ? AND o.status = 'pending_ipo'
     ORDER BY o.placed_at ASC`
  ).bind(Number(id)).all();

  const subscribed = (results || []).reduce((sum, r) => sum + r.quantity, 0);

  return json({
    company: { ticker: company.ticker, name: company.name, ipo_price: company.ipo_price, shares_in_float: company.shares_in_float, total_subscribed: subscribed },
    subscriptions: results || [],
    oversubscribed: subscribed > company.shares_in_float,
    remaining: Math.max(0, company.shares_in_float - subscribed),
  });
}

// ── POST /api/exchange/admin/companies/:id/ipo/allocate ───────────
export async function allocateIpo(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  if (!hasRole(auth.user, 'admin')) {
    return json({ error: 'Admin role required.' }, { status: 403 });
  }

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });
  if (company.status !== 'ipo') {
    return json({ error: 'Company must be in offering status to allocate.' }, { status: 400 });
  }

  const { results: subscriptions } = await env.DB.prepare(
    `SELECT * FROM fdx_orders
     WHERE company_id = ? AND status = 'pending_ipo'
     ORDER BY placed_at ASC`
  ).bind(Number(id)).all();

  if (!subscriptions || subscriptions.length === 0) {
    // No subscriptions — activate with existing float
    await env.DB.prepare(
      `UPDATE fdx_companies SET status = 'active', current_price = ipo_price, updated_at = ? WHERE id = ?`
    ).bind(nowIso(), Number(id)).run();

    await env.DB.prepare(
      `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
       VALUES (?, 'IPO_ALLOCATE', 'company', ?, ?)`
    ).bind(auth.user.username, Number(id), JSON.stringify({ subscribers: 0, allocated: 0 })).run();

    return json({ ok: true, status: 'active', allocated: 0, subscribers: 0 });
  }

  const totalRequested = subscriptions.reduce((sum, s) => sum + s.quantity, 0);
  const float = company.shares_in_float;
  let allocated = 0;
  const now = nowIso();
  const feeRate = 0.005;

  if (totalRequested <= float) {
    // Undersubscribed or exactly matched — everyone gets what they asked for
    const remainingFloat = float - totalRequested;

    for (const sub of subscriptions) {
      const cost = Math.round(sub.quantity * company.ipo_price * 100) / 100;
      const fee = Math.round(cost * feeRate * 100) / 100;
      const total = Math.round((cost + fee) * 100) / 100;

      // Debit buyer
      try {
        await debitOffering(env, sub.account_id, total);
        // Credit exchange treasury
        await creditOffering(env, '__exchange_treasury__', fee, 'Offering fee: ' + company.ticker);

        // Update portfolio
        await env.DB.prepare(
          `INSERT INTO fdx_portfolios (account_id, company_id, quantity, average_cost, total_invested)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account_id, company_id) DO UPDATE SET
             quantity = quantity + ?,
             average_cost = ROUND((total_invested + ?) / (quantity + ?), 2),
             total_invested = total_invested + ?,
             last_updated = ?`
        ).bind(sub.account_id, Number(id), sub.quantity, company.ipo_price, cost,
               sub.quantity, cost, sub.quantity, cost, now).run();

        // Mark order filled
        await env.DB.prepare(
          `UPDATE fdx_orders SET status = 'filled', quantity_filled = ?, filled_at = ? WHERE id = ?`
        ).bind(sub.quantity, now, sub.id).run();

        allocated += sub.quantity;
      } catch (err) {
        console.error('Offering allocation error for', sub.account_id, err.message);
        await env.DB.prepare(
          `UPDATE fdx_orders SET status = 'rejected', flag_reason = ? WHERE id = ?`
        ).bind('Insufficient funds: ' + err.message, sub.id).run();
      }
    }

    // Undersubscribed — keep original float, unsold shares stay in treasury
    await env.DB.prepare(
      `UPDATE fdx_companies SET status = 'active', current_price = ipo_price,
         updated_at = ? WHERE id = ?`
    ).bind(now, Number(id)).run();

  } else {
    // Oversubscribed — proportional scaling (FCFS or pro-rata)
    const scale = float / totalRequested;
    let allocatedFloat = 0;

    for (const sub of subscriptions) {
      const allocatedQty = Math.max(1, Math.floor(sub.quantity * scale));
      if (allocatedFloat + allocatedQty > float) break; // don't exceed float

      const cost = Math.round(allocatedQty * company.ipo_price * 100) / 100;
      const fee = Math.round(cost * feeRate * 100) / 100;
      const total = Math.round((cost + fee) * 100) / 100;

      try {
        await debitOffering(env, sub.account_id, total);
        await creditOffering(env, '__exchange_treasury__', fee, 'Offering fee: ' + company.ticker);

        await env.DB.prepare(
          `INSERT INTO fdx_portfolios (account_id, company_id, quantity, average_cost, total_invested)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account_id, company_id) DO UPDATE SET
             quantity = quantity + ?,
             average_cost = ROUND((total_invested + ?) / (quantity + ?), 2),
             total_invested = total_invested + ?,
             last_updated = ?`
        ).bind(sub.account_id, Number(id), allocatedQty, company.ipo_price, cost,
               allocatedQty, cost, allocatedQty, cost, now).run();

        await env.DB.prepare(
          `UPDATE fdx_orders SET status = 'partial', quantity_filled = ?, filled_at = ? WHERE id = ?`
        ).bind(allocatedQty, now, sub.id).run();

        allocatedFloat += allocatedQty;
      } catch (err) {
        console.error('Offering oversubscription error for', sub.account_id, err.message);
        await env.DB.prepare(
          `UPDATE fdx_orders SET status = 'rejected', flag_reason = ? WHERE id = ?`
        ).bind('Insufficient funds: ' + err.message, sub.id).run();
      }
    }

    allocated = allocatedFloat;
    await env.DB.prepare(
      `UPDATE fdx_companies SET status = 'active', current_price = ipo_price, updated_at = ? WHERE id = ?`
    ).bind(now, Number(id)).run();
  }

  // Audit log
  await env.DB.prepare(
    `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, 'IPO_ALLOCATE', 'company', ?, ?)`
  ).bind(auth.user.username, Number(id),
         JSON.stringify({ subscribers: subscriptions.length, total_requested: totalRequested, allocated, oversubscribed: totalRequested > float })).run();

  return json({
    ok: true, status: 'active',
    subscribers: subscriptions.length, total_requested: totalRequested, allocated,
    oversubscribed: totalRequested > float,
  });
}

// ── POST /api/exchange/admin/companies/:id/ipo/cancel ─────────────
export async function cancelIpo(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });
  if (company.status !== 'ipo') {
    return json({ error: 'Company is not in offering status.' }, { status: 400 });
  }

  // Cancel all subscriptions
  await env.DB.prepare(
    `UPDATE fdx_orders SET status = 'cancelled', cancelled_at = ?
     WHERE company_id = ? AND status = 'pending_ipo'`
  ).bind(nowIso(), Number(id)).run();

  // Set company to delisted (or back to a pre-offering state)
  await env.DB.prepare(
    `UPDATE fdx_companies SET status = 'delisted', halt_reason = NULL, updated_at = ? WHERE id = ?`
  ).bind(nowIso(), Number(id)).run();

  await env.DB.prepare(
    `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, 'IPO_CANCEL', 'company', ?, ?)`
  ).bind(auth.user.username, Number(id),
         JSON.stringify({ ticker: company.ticker })).run();

  return json({ ok: true, status: 'delisted' });
}

// ── POST /api/exchange/admin/companies/:id/offering ───────────────
// Takes a private (unlisted) company through the public-offering flow.
export async function openIpo(request, env, id) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const company = await env.DB.prepare('SELECT * FROM fdx_companies WHERE id = ?')
    .bind(Number(id)).first();
  if (!company) return json({ error: 'Company not found.' }, { status: 404 });
  if (company.status !== 'private') {
    return json({ error: 'Only private (unlisted) companies can open an offering.' }, { status: 400 });
  }

  let body;
  try { body = await request.json(); }
  catch { body = {}; }

  const ipoPrice = parseFloat(body.ipo_price);
  const floatShares = parseInt(body.shares_in_float, 10);
  if (!Number.isFinite(ipoPrice) || ipoPrice <= 0) {
    return json({ error: 'A valid ipo_price is required.' }, { status: 400 });
  }
  if (!Number.isFinite(floatShares) || floatShares <= 0) {
    return json({ error: 'A valid shares_in_float is required.' }, { status: 400 });
  }
  if (floatShares > company.total_shares) {
    return json({ error: 'Float shares cannot exceed total shares.' }, { status: 400 });
  }

  await env.DB.prepare(
    `UPDATE fdx_companies SET status = 'ipo', ipo_price = ?, shares_in_float = ?,
       current_price = ?, updated_at = ? WHERE id = ?`
  ).bind(ipoPrice, floatShares, ipoPrice, nowIso(), Number(id)).run();

  await env.DB.prepare(
    `INSERT INTO fdx_audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, 'OPEN_OFFERING', 'company', ?, ?)`
  ).bind(auth.user.username, Number(id),
         JSON.stringify({ ipo_price: ipoPrice, shares_in_float: floatShares })).run();

  return json({ ok: true, status: 'ipo' });
}
// ════════════════════════════════════════════════════════════════
// NEWS INTEGRATION — Times of Regnum exchange feed
// ════════════════════════════════════════════════════════════════

// ── GET /api/exchange/news-feed ───────────────────────────────────
export async function getNewsFeed(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '10', 10) || 10));

  // Fetch recent company reports
  const { results: reports } = await env.DB.prepare(
    `SELECT r.*, c.ticker, c.name AS company_name, c.current_price, c.logo_emoji
     FROM fdx_company_reports r
     JOIN fdx_companies c ON c.id = r.company_id
     ORDER BY r.filed_at DESC LIMIT ?`
  ).bind(limit).all();

  // Fetch recent dividends
  const { results: dividends } = await env.DB.prepare(
    `SELECT d.*, c.ticker, c.name AS company_name
     FROM fdx_dividends d
     JOIN fdx_companies c ON c.id = d.company_id
     WHERE d.status = 'paid'
     ORDER BY d.declared_at DESC LIMIT ?`
  ).bind(Math.floor(limit / 2)).all();

  // Fetch recent offerings
  const { results: ipos } = await env.DB.prepare(
    `SELECT a.details, a.performed_at
     FROM fdx_audit_log a
     WHERE a.action = 'IPO_ALLOCATE'
     ORDER BY a.performed_at DESC LIMIT ?`
  ).bind(Math.floor(limit / 2)).all();

  // Build feed items
  const items = [];

  for (const r of (reports || [])) {
    items.push({
      type: 'report',
      headline: `${r.ticker}: ${r.headline}`,
      subtitle: `${r.company_name} — ${r.report_type} Report`,
      body: r.body || '',
      ticker: r.ticker,
      company_name: r.company_name,
      price: r.current_price,
      logo_emoji: r.logo_emoji,
      date: r.filed_at,
      suggested_title: `${r.ticker}: ${r.headline}`,
      suggested_content: `**${r.company_name} (${r.ticker})** filed a ${r.report_type} report.

${r.body || ''}

${r.earnings_change ? `Earnings ${r.earnings_change >= 0 ? 'up' : 'down'} ${Math.abs(r.earnings_change).toFixed(2)} | ` : ''}${r.revenue_change ? `Revenue ${r.revenue_change >= 0 ? 'up' : 'down'} ${Math.abs(r.revenue_change).toFixed(2)}` : ''}`,
    });
  }

  for (const d of (dividends || [])) {
    items.push({
      type: 'dividend',
      headline: `${d.ticker} Pays Dividend: ${d.dividend_per_share}/share`,
      subtitle: `${d.company_name} — Dividend Distribution`,
      body: `Paid ${d.total_paid != null ? formatNum(d.total_paid) : d.dividend_per_share + '/share'} on ${d.pay_date}.`,
      ticker: d.ticker,
      company_name: d.company_name,
      date: d.declared_at,
      suggested_title: `${d.ticker} Declares ${d.dividend_per_share}/share Dividend`,
      suggested_content: `**${d.company_name} (${d.ticker})** has declared a dividend of ${d.dividend_per_share} per share, payable on ${d.pay_date}.\n\nTotal payout: ${d.total_paid != null ? formatNum(d.total_paid) : '(pending)'}. This marks another return of value to shareholders.`,
    });
  }

  for (const ipo of (ipos || [])) {
    let details;
    try { details = JSON.parse(ipo.details); } catch { details = {}; }
    items.push({
      type: 'ipo',
      headline: `New Listing: Public Offering Completed`,
      subtitle: `${details.subscribers || '?'} subscribers, ${formatNum(details.allocated || 0)} shares allocated`,
      body: details.oversubscribed ? 'The offering was oversubscribed. Shares were allocated on a pro-rata basis.' : 'All subscriptions were fulfilled.',
      date: ipo.performed_at,
      suggested_title: `Public Offering Completed: ${details.subscribers || 0} Investors Participate`,
      suggested_content: `The latest public offering on the Fiducia Exchange has completed, with ${details.subscribers || 0} subscribers receiving ${formatNum(details.allocated || 0)} shares.${details.oversubscribed ? ' The offering was oversubscribed, demonstrating strong market demand.' : ''}`,
    });
  }

  // Sort by date descending
  items.sort((a, b) => new Date(b.date) - new Date(a.date));

  return json(items.slice(0, limit));
}

async function debitOffering(env, accountKey, amount) {
  const account = await env.DB.prepare(
    'SELECT balance, frozen FROM banking_accounts WHERE key = ?'
  ).bind(accountKey).first();
  if (!account) throw new Error('Account not found');
  if (account.frozen) throw new Error('Account frozen');
  if (account.balance < amount) throw new Error('Insufficient balance');

  const newBalance = Math.round((account.balance - amount) * 100) / 100;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(newBalance, now, accountKey),
    env.DB.prepare('INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(accountKey, '__exchange__', amount, newBalance, 0, 'OFFERING_SUBSCRIPTION', 'system:offering', now),
  ]);
}

async function creditOffering(env, accountKey, amount, description) {
  const account = await env.DB.prepare(
    'SELECT balance FROM banking_accounts WHERE key = ?'
  ).bind(accountKey).first();
  if (!account) {
    // Create exchange treasury if needed
    if (accountKey === '__exchange_treasury__') {
      const now = nowIso();
      await env.DB.prepare(
        'INSERT OR IGNORE INTO banking_accounts (key, name, balance, color, type, owner_key, treasury_key, password_hash, shares, tag, frozen, cumulative, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)'
      ).bind('__exchange_treasury__', 'Fiducia Exchange Treasury', amount, 16766720, 'treasury', '', '', '', 0, 'FDX', now, now).run();
      const existing = await env.DB.prepare('SELECT balance FROM banking_accounts WHERE key = ?').bind(accountKey).first();
      if (existing) {
        const newBal = Math.round((existing.balance + amount) * 100) / 100;
        await env.DB.batch([
          env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(newBal, now, accountKey),
          env.DB.prepare('INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind('__exchange__', accountKey, amount, 0, newBal, description, 'system:offering', now),
        ]);
      }
      return;
    }
    throw new Error('Account not found');
  }

  const newBalance = Math.round((account.balance + amount) * 100) / 100;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(newBalance, now, accountKey),
    env.DB.prepare('INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind('__exchange__', accountKey, amount, 0, newBalance, description, 'system:offering', now),
  ]);
}
