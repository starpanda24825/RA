/* ============================================================
   Regnum Aeternum — Worker
   Banking System: Citizen Portal API routes.

   All routes (except public company endpoints) require an active
   ra_session cookie (web login). Citizens can view their own
   account, transfer funds, and browse public company information.
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser } from './auth.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

/**
 * Resolves the authenticated user and their linked banking account.
 * Returns { user, account } on success, or { error: Response } on failure.
 */
async function requireLinkedAccount(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) {
    return { error: json({ error: 'Authentication required.' }, { status: 401 }) };
  }
  const account = await store.findBankingAccountByUserId(env, user.id);
  if (!account) {
    return {
      error: json(
        { error: 'No banking account is linked to your web account. Contact a banker or administrator.' },
        { status: 404 }
      ),
    };
  }
  return { user, account };
}

// ── GET /api/banking/me ────────────────────────────────────────────
// Returns the banking account linked to the current web user.
// password_hash is excluded by ACCOUNT_COLS in store.findBankingAccountByUserId.
export async function getMe(request, env) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;
  return json(result.account);
}

// ── GET /api/banking/me/transactions?limit=50&offset=0 ────────────
export async function getMyTransactions(request, env) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const url    = new URL(request.url);
  const limit  = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit')  || '50', 10) || 50));
  const offset = Math.max(0,              parseInt(url.searchParams.get('offset') || '0',  10) || 0);

  const log = await store.getBankingTransactionLog(env, result.account.key, { limit, offset });
  return json(log);
}

// ── POST /api/banking/transfer ────────────────────────────────────
export async function transfer(request, env) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;
  const { user, account } = result;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { toKey, amount, description = '' } = body;

  if (!toKey || typeof toKey !== 'string') {
    return json({ error: 'Recipient account key is required.' }, { status: 400 });
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0 || Math.floor(amt) !== amt) {
    return json({ error: 'Amount must be a positive integer.' }, { status: 400 });
  }

  try {
    const txResult = await store.atomicTransfer(env, {
      fromKey:     account.key,
      toKey:       toKey.trim(),
      amount:      amt,
      description: String(description).slice(0, 100),
      initiatedBy: `web:${user.id}`,
    });
    return json({ ok: true, fromBalanceAfter: txResult.fromBalanceAfter });
  } catch (err) {
    const statusMap = {
      NOT_FOUND:            404,
      FROZEN:               403,
      INSUFFICIENT_BALANCE: 422,
      TYPE_MISMATCH:        422,
      SELF_TRANSFER:        400,
      INVALID_AMOUNT:       400,
    };
    return json({ error: err.message || 'Transfer failed.' }, { status: statusMap[err.code] || 500 });
  }
}

// ── GET /api/banking/accounts/search?q= ───────────────────────────
// Live-search for recipient accounts. Excludes treasury and frozen.
export async function searchAccounts(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return json({ error: 'Authentication required.' }, { status: 401 });

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return json([]);

  const accounts = await store.listBankingAccounts(env, { search: q });
  const safe = accounts
    .filter(a => a.type !== 'treasury' && !a.frozen)
    .map(({ key, name, type, color }) => ({ key, name, type, color }))
    .slice(0, 10);
  return json(safe);
}

// ── GET /api/banking/companies ────────────────────────────────────
// Public list of all company accounts with price-per-share.
export async function listCompanies(request, env) {
  const accounts = await store.listBankingAccounts(env, { type: 'company' });
  return json(accounts.map(a => ({
    key:           a.key,
    name:          a.name,
    balance:       a.balance,
    shares:        a.shares,
    color:         a.color,
    pricePerShare: a.shares > 0 ? Math.round((a.balance / a.shares) * 100) / 100 : 0,
  })));
}

// ── GET /api/banking/companies/top ────────────────────────────────
// Top 10 companies by balance with 24 h change %.
export async function getTopCompanies(request, env) {
  const top = await store.getTopCompanies(env, 10);
  return json(top.map(co => ({
    key:           co.key,
    name:          co.name,
    balance:       co.balance,
    shares:        co.shares,
    pricePerShare: co.shares > 0 ? Math.round((co.balance / co.shares) * 100) / 100 : 0,
    change:        co.change,
  })));
}

// ── GET /api/banking/companies/:key/shareholders ──────────────────
// Public shareholder list for a company.
export async function getCompanyShareholders(request, env, key) {
  const account = await store.findBankingAccountByKey(env, key);
  if (!account || account.type !== 'company') {
    return json({ error: 'Company not found.' }, { status: 404 });
  }
  const shareholders = await store.listShareholders(env, key);
  return json(shareholders);
}

// ── GET /api/banking/me/portfolio ─────────────────────────────────
// All share holdings for the current user's linked account.
export async function getMyPortfolio(request, env) {
  const result = await requireLinkedAccount(request, env);
  if (result.error) return result.error;

  const { results: holdings } = await env.DB.prepare(
    `SELECT bs.company_key, bs.shares,
            ba.name, ba.balance, ba.shares AS total_shares, ba.color
     FROM   banking_shareholders bs
     JOIN   banking_accounts ba ON ba.key = bs.company_key
     WHERE  bs.holder_key = ? AND bs.shares > 0
     ORDER  BY ba.balance DESC`
  ).bind(result.account.key).all();

  return json(holdings.map(h => ({
    companyKey:     h.company_key,
    companyName:    h.name,
    shares:         h.shares,
    totalShares:    h.total_shares,
    companyBalance: h.balance,
    color:          h.color,
    pricePerShare:  h.total_shares > 0 ? Math.round((h.balance / h.total_shares) * 100) / 100 : 0,
    estimatedValue: h.total_shares > 0
      ? Math.round((h.balance / h.total_shares) * h.shares * 100) / 100
      : 0,
  })));
}
