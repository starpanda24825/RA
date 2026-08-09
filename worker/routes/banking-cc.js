/* ============================================================
   Regnum Aeternum — Worker
   Banking System: ComputerCraft HTTP Bridge

   Mirrors the CC Bank Server's processRequest dispatch so CC
   terminals can use HTTP instead of RedNet. Auth uses a Bearer
   token whose SHA-256 hash is stored in banking_cc_tokens.
   ============================================================ */

import * as store from '../lib/store.js';
import { hash, compare } from '../lib/passwords.js';

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

async function authenticateCC(request, env, requiredType = null) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return { error: ccJson(false, 'Missing Authorization header.') };
  const tokenHash = await sha256hex(m[1].trim());
  const token = await store.findCCToken(env, tokenHash);
  if (!token) return { error: ccJson(false, 'Invalid or expired token.') };
  if (requiredType && token.terminal_type !== requiredType && token.terminal_type !== 'admin') {
    return { error: ccJson(false, `Requires '${requiredType}' or 'admin' token.`) };
  }
  store.updateCCTokenLastUsed(env, tokenHash).catch(() => {});
  return { token };
}

async function buildServerData(env) {
  const settings = await store.getBankingSettings(env);
  const defs = {
    diamond:   [
      { id: 'minecraft:diamond',       value: 1,  name: 'Diamond',       plural: 'Diamonds',       short: 'D',  uprecipe: { need: 9, yield: 1, result: 'minecraft:diamond_block' } },
      { id: 'minecraft:diamond_block', value: 9,  name: 'Diamond Block', plural: 'Diamond Blocks', short: 'Bl', downrecipe: { need: 1, yield: 9, result: 'minecraft:diamond' } },
    ],
    gold: [
      { id: 'minecraft:gold_nugget', value: 1,  name: 'Gold Nugget', plural: 'Gold Nuggets', short: 'N',  uprecipe: { need: 9, yield: 1, result: 'minecraft:gold_ingot' } },
      { id: 'minecraft:gold_ingot',  value: 9,  name: 'Gold Ingot',  plural: 'Gold Ingots',  short: 'I',  downrecipe: { need: 1, yield: 9, result: 'minecraft:gold_nugget' }, uprecipe: { need: 9, yield: 1, result: 'minecraft:gold_block' } },
      { id: 'minecraft:gold_block',  value: 81, name: 'Gold Block',  plural: 'Gold Blocks',  short: 'B',  downrecipe: { need: 1, yield: 9, result: 'minecraft:gold_ingot' } },
    ],
    emerald: [
      { id: 'minecraft:emerald',       value: 1, name: 'Emerald',       plural: 'Emeralds',       short: 'E',  uprecipe: { need: 9, yield: 1, result: 'minecraft:emerald_block' } },
      { id: 'minecraft:emerald_block', value: 9, name: 'Emerald Block', plural: 'Emerald Blocks', short: 'Bl', downrecipe: { need: 1, yield: 9, result: 'minecraft:emerald' } },
    ],
    netherite: [
      { id: 'minecraft:netherite_ingot', value: 1, name: 'Netherite Ingot', plural: 'Netherite Ingots', short: 'I', uprecipe: { need: 9, yield: 1, result: 'minecraft:netherite_block' } },
      { id: 'minecraft:netherite_block', value: 9, name: 'Netherite Block', plural: 'Netherite Blocks', short: 'B', downrecipe: { need: 1, yield: 9, result: 'minecraft:netherite_ingot' } },
    ],
  };
  const prices = settings.currency_prices || {};
  const baseIdx = { diamond: 0, gold: 1, emerald: 0, netherite: 0 };
  const merged = [];
  for (const [t, items] of Object.entries(defs)) {
    const price = prices[t] || 0;
    if (price <= 0) continue;
    const mul = price / items[baseIdx[t] || 0].value;
    for (const item of items) merged.push({ ...item, value: item.value * mul });
  }
  merged.sort((a, b) => a.value - b.value);
  return {
    currency: merged, valueMultiplier: 1,
    cumulativeLimit: settings.cumulative_limit,
    cumulativePrice: settings.cumulative_price,
    taxes: {
      enabled: !!settings.tax_enabled,
      ratePercentPersonal: settings.tax_rate_personal,
      ratePercentCompany: settings.tax_rate_company,
      threshold: settings.tax_threshold,
      periodDays: settings.tax_period_days,
      lastRunAt: settings.tax_last_run_at,
    },
  };
}

// POST /api/banking/cc/server-data — no auth required
export async function ccServerData(request, env) {
  return ccJson(true, await buildServerData(env));
}

// POST /api/banking/cc/client-data
export async function ccClientData(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;
  const accounts = await store.listBankingAccounts(env, {});
  const out = {};
  for (const a of accounts) {
    out[a.key] = {
      name: a.name, balance: a.balance, color: a.color, type: a.type,
      owner: a.owner_key || '', treasury: a.treasury_key || '',
      shares: a.shares, tag: a.tag, frozen: !!a.frozen, cumulative: a.cumulative,
    };
  }
  return ccJson(true, out);
}

// POST /api/banking/cc/transaction
export async function ccTransaction(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  const { from, to, amount, description = '' } = body;
  const amt = Number(amount);
  if (!from || !to || !Number.isFinite(amt) || amt <= 0) return ccJson(false, 'from, to, amount required.');
  try {
    await store.atomicTransfer(env, { fromKey: String(from), toKey: String(to), amount: amt, description: String(description).slice(0, 100), initiatedBy: `cc:${auth.token.terminal_type}:${auth.token.id}` });
    return ccJson(true, 'Transaction successful');
  } catch (err) { return ccJson(false, err.message || 'Transaction failed.'); }
}

// POST /api/banking/cc/deposit
export async function ccDeposit(request, env) {
  const auth = await authenticateCC(request, env, 'atm');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  const amt = Number(body.amount);
  if (!body.key || !Number.isFinite(amt) || amt <= 0) return ccJson(false, 'key and amount required.');
  try {
    const r = await store.atomicDeposit(env, { accountKey: String(body.key), amount: amt, description: 'Deposit', initiatedBy: `cc:atm:${auth.token.id}` });
    return ccJson(true, r.balanceAfter);
  } catch (err) { return ccJson(false, err.message || 'Deposit failed.'); }
}

// POST /api/banking/cc/withdraw
export async function ccWithdraw(request, env) {
  const auth = await authenticateCC(request, env, 'atm');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  const amt = Number(body.amount);
  if (!body.key || !Number.isFinite(amt) || amt <= 0) return ccJson(false, 'key and amount required.');
  try {
    const r = await store.atomicWithdraw(env, { accountKey: String(body.key), amount: amt, description: 'Withdrawal', initiatedBy: `cc:atm:${auth.token.id}` });
    return ccJson(true, r.balanceAfter);
  } catch (err) { return ccJson(false, err.message || 'Withdrawal failed.'); }
}

// POST /api/banking/cc/transaction-log
export async function ccTransactionLog(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.key) return ccJson(false, 'key required.');
  const log = await store.getBankingTransactionLog(env, String(body.key), { limit: 50, offset: 0 });
  return ccJson(true, log.map(r => ({ other: r.other_key || r.other, amount: r.amount, balance: r.balance, time: r.created_at, description: r.description })));
}

// POST /api/banking/cc/validate-card
export async function ccValidateCard(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.key || !body.id) return ccJson(false, 'key and id required.');
  const valid = await store.validateBankingCard(env, String(body.key), String(body.id));
  return valid ? ccJson(true, 'Card active') : ccJson(false, 'Invalid or disabled card');
}

// POST /api/banking/cc/register-card
export async function ccRegisterCard(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.key) return ccJson(false, 'key required.');
  let cardId = 'C' + Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
  for (let i = 0; i < 10; i++) {
    if (!await store.findBankingCard(env, cardId)) break;
    cardId = 'C' + Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
  }
  try {
    await store.insertBankingCard(env, { cardId, accountKey: String(body.key), issuedBy: `cc:${auth.token.id}` });
    return ccJson(true, cardId);
  } catch (err) { return ccJson(false, err.message || 'Could not register card.'); }
}

// POST /api/banking/cc/cancel-card
export async function ccCancelCard(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.key || !body.id) return ccJson(false, 'key and id required.');
  const card = await store.findBankingCard(env, String(body.id));
  if (!card || card.account_key !== String(body.key)) return ccJson(false, 'Card not found.');
  await store.updateBankingCard(env, String(body.id), { status: 'canceled' });
  return ccJson(true, 'Card cancelled');
}

// POST /api/banking/cc/list-cards
export async function ccListCards(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.key) return ccJson(false, 'key required.');
  const cards = await store.listBankingCards(env, String(body.key));
  return ccJson(true, cards.map(c => ({ id: c.card_id, date: c.created_at, status: c.status })));
}

// POST /api/banking/cc/new-account
export async function ccNewAccount(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.name || !String(body.name).trim()) return ccJson(false, 'name required.');
  try {
    const key = await store.generateAccountKey(env);
    await store.insertBankingAccount(env, { key, name: String(body.name).trim(), balance: 0, color: Number(body.color) || 16384, type: 'personal', ownerKey: '', treasuryKey: body.treasury ? String(body.treasury) : (auth.token.treasury_key || ''), passwordHash: '', shares: 0, tag: '' });
    return ccJson(true, 'Account created successfully');
  } catch (err) { return ccJson(false, err.message || 'Failed to create account.'); }
}

// POST /api/banking/cc/new-company
export async function ccNewCompany(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.name || !body.owner) return ccJson(false, 'name and owner required.');
  const ownerAcc = await store.findBankingAccountByKey(env, String(body.owner));
  if (!ownerAcc) return ccJson(false, 'Invalid owner account');
  try {
    const key = await store.generateAccountKey(env);
    await store.insertBankingAccount(env, { key, name: String(body.name).trim(), balance: 0, color: Number(body.color) || 16384, type: 'company', ownerKey: String(body.owner), treasuryKey: ownerAcc.treasury_key || '', passwordHash: '', shares: Number(body.shares) || 0, tag: '' });
    return ccJson(true, 'Account created successfully');
  } catch (err) { return ccJson(false, err.message || 'Failed to create company.'); }
}

// POST /api/banking/cc/delete-account
export async function ccDeleteAccount(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.key) return ccJson(false, 'key required.');
  const account = await store.findBankingAccountByKey(env, String(body.key));
  if (!account) return ccJson(false, 'Account not found.');
  if (account.type === 'treasury') return ccJson(false, 'Treasury accounts cannot be deleted via this endpoint.');
  if (auth.token.treasury_key && account.treasury_key !== auth.token.treasury_key) return ccJson(false, 'Account is outside this terminal\'s treasury scope.');
  await store.deleteBankingAccount(env, String(body.key));
  return ccJson(true, 'Account deleted successfully');
}

// POST /api/banking/cc/set-password
// Stores in PBKDF2 format; Patch 8 adds ASHA-512 dual-hash for full CC compatibility.
export async function ccSetPassword(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.key || body.password === undefined) return ccJson(false, 'key and password required.');
  await store.updateBankingAccount(env, String(body.key), { password_hash: await hash(String(body.password)) });
  return ccJson(true, 'Update successful');
}

// POST /api/banking/cc/change-password
export async function ccChangePassword(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.key || !body.current || !body.new) return ccJson(false, 'key, current, and new required.');
  const account = await store.findBankingAccountByKeyWithHash(env, String(body.key));
  if (!account) return ccJson(false, 'Account not found.');
  if (!account.password_hash) return ccJson(false, 'No password set.');
  const ok = await compare(String(body.current), account.password_hash);
  if (!ok) return ccJson(false, 'Incorrect password');
  await store.updateBankingAccount(env, String(body.key), { password_hash: await hash(String(body.new)) });
  return ccJson(true, 'Update successful');
}

// POST /api/banking/cc/reset-password
export async function ccResetPassword(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.key) return ccJson(false, 'key required.');
  await store.updateBankingAccount(env, String(body.key), { password_hash: await hash('1234') });
  return ccJson(true, 'Update successful');
}

// POST /api/banking/cc/freeze-account
export async function ccFreezeAccount(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.key) return ccJson(false, 'key required.');
  const account = await store.findBankingAccountByKey(env, String(body.key));
  if (!account) return ccJson(false, 'Account not found.');
  if (auth.token.treasury_key && account.treasury_key !== auth.token.treasury_key) return ccJson(false, 'Account outside terminal treasury scope.');
  await store.updateBankingAccount(env, String(body.key), { frozen: body.frozen ? 1 : 0 });
  return ccJson(true, `Account ${body.frozen ? 'frozen' : 'unfrozen'}`);
}

// POST /api/banking/cc/list-shareholders
export async function ccListShareholders(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.company) return ccJson(false, 'company required.');
  const account = await store.findBankingAccountByKey(env, String(body.company));
  if (!account || account.type !== 'company') return ccJson(false, 'Invalid company account.');
  return ccJson(true, await store.listShareholders(env, String(body.company)));
}

// POST /api/banking/cc/issue-shares
export async function ccIssueShares(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.issuer || !body.company || !body.buyer || !body.count) return ccJson(false, 'issuer, company, buyer, count required.');
  try {
    const r = await store.atomicIssueShares(env, { issuerKey: String(body.issuer), companyKey: String(body.company), buyerKey: String(body.buyer), shareCount: Number(body.count) });
    return ccJson(true, r);
  } catch (err) { return ccJson(false, err.message || 'Failed to issue shares.'); }
}

// POST /api/banking/cc/get-portfolio
export async function ccGetPortfolio(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;
  let body; try { body = await request.json(); } catch { return ccJson(false, 'Invalid body.'); }
  if (!body.account) return ccJson(false, 'account required.');
  const { results } = await env.DB.prepare(
    `SELECT bs.company_key, bs.shares, ba.name, ba.balance, ba.shares AS total_shares
     FROM banking_shareholders bs JOIN banking_accounts ba ON ba.key = bs.company_key
     WHERE bs.holder_key = ? AND bs.shares > 0`
  ).bind(String(body.account)).all();
  return ccJson(true, results.map(h => ({ company: h.company_key, name: h.name, shares: h.shares, estimated_value: h.total_shares > 0 ? Math.round((h.balance / h.total_shares) * h.shares * 100) / 100 : 0 })));
}

// POST /api/banking/cc/top-companies
export async function ccTopCompanies(request, env) {
  const auth = await authenticateCC(request, env);
  if (auth.error) return auth.error;
  return ccJson(true, await store.getTopCompanies(env, 10));
}

// POST /api/banking/cc/apply-taxes
export async function ccApplyTaxes(request, env) {
  const auth = await authenticateCC(request, env, 'admin');
  if (auth.error) return auth.error;
  return ccJson(true, await store.applyTaxes(env, `cc:admin:${auth.token.id}`));
}
