/* ============================================================
   Regnum Aeternum — Worker
   Pure D1 data access. No filesystem, no in-memory cache — each
   call hits the database directly, since a Worker request may run
   in a fresh isolate with no memory of any previous request.
   ============================================================ */

function nowIso() {
  return new Date().toISOString();
}

// ---------- users ----------

export async function findUserByUsername(env, username) {
  const lower = String(username || '').toLowerCase();
  return env.DB.prepare('SELECT * FROM users WHERE username_lower = ?').bind(lower).first();
}

export async function findUserById(env, id) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(id)).first();
}

export async function anyAdminExists(env) {
  // Role is now comma-separated, e.g. "admin,banker"
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM users WHERE ',' || role || ',' LIKE '%,admin,%'"
  ).first();
  return !!(row && row.c > 0);
}

export async function listUsers(env) {
  const { results } = await env.DB
    .prepare('SELECT id, username, role, created_at FROM users ORDER BY id ASC')
    .all();
  return results;
}

export async function insertUser(env, { username, passwordHash, role }) {
  const lower = username.toLowerCase();
  const created_at = nowIso();
  try {
    const result = await env.DB.prepare(
      'INSERT INTO users (username, username_lower, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(username, lower, passwordHash, role || 'citizen', created_at).run();
    return findUserById(env, result.meta.last_row_id);
  } catch (err) {
    // D1/SQLite surfaces the UNIQUE constraint violation in err.message
    if (String(err && err.message || '').toUpperCase().includes('UNIQUE')) {
      const e = new Error('Username already exists.');
      e.code = 'DUPLICATE';
      throw e;
    }
    throw err;
  }
}

export async function updateUser(env, id, fields) {
  const sets = [];
  const binds = [];
  if (fields.role) { sets.push('role = ?'); binds.push(fields.role); }
  if (fields.passwordHash) { sets.push('password_hash = ?'); binds.push(fields.passwordHash); }
  if (!sets.length) return findUserById(env, id);
  binds.push(Number(id));
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findUserById(env, id);
}

export async function deleteUserById(env, id) {
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(Number(id)).run();
}

export async function updateUserUsername(env, id, newUsername) {
  const lower = newUsername.toLowerCase();
  try {
    await env.DB.prepare(
      'UPDATE users SET username = ?, username_lower = ? WHERE id = ?'
    ).bind(newUsername, lower, Number(id)).run();
    return findUserById(env, id);
  } catch (err) {
    if (String(err && err.message || '').toUpperCase().includes('UNIQUE')) {
      const e = new Error('Username already exists.');
      e.code = 'DUPLICATE';
      throw e;
    }
    throw err;
  }
}

/**
 * Finds a personal banking account linked to a user, excluding the given key.
 * Returns null if no such account exists — meaning the user is free to link.
 */
export async function findPersonalAccountByUserIdExcluding(env, userId, excludeKey) {
  const row = await env.DB.prepare(
    "SELECT key FROM banking_accounts WHERE user_id = ? AND type = 'personal' AND key != ?"
  ).bind(Number(userId), excludeKey).first();
  return row || null;
}

// ---------- sessions ----------
// Sessions are real rows, not a stateless signed token — this means
// "Sign out" actually revokes the session server-side (the old
// in-memory express-session store could not do this across restarts
// at all, and Workers have no persistent memory between requests).

export async function createSession(env, userId, ttlSeconds) {
  const token = crypto.randomUUID();
  const expires_at = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, userId, nowIso(), expires_at).run();
  return { token, expires_at };
}

export async function getSession(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.token, s.user_id, s.expires_at, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await deleteSession(env, token);
    return null;
  }
  return row;
}

export async function deleteSession(env, token) {
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

// ---------- articles ----------

export async function listPublishedArticles(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM articles WHERE status = 'published' ORDER BY published_at DESC"
  ).all();
  return results;
}

export async function listAllArticles(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, title, subtitle, author, status, created_at, published_at FROM articles ORDER BY created_at DESC'
  ).all();
  return results;
}

export async function findArticleById(env, id) {
  return env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(Number(id)).first();
}

export async function insertArticle(env, { title, subtitle, content, author }) {
  const created_at = nowIso();
  const result = await env.DB.prepare(
    'INSERT INTO articles (title, subtitle, content, author, status, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
  ).bind(title, subtitle || '', content, author, 'draft', created_at).run();
  return findArticleById(env, result.meta.last_row_id);
}

export async function updateArticle(env, id, fields) {
  const sets = [];
  const binds = [];
  ['title', 'subtitle', 'content', 'status', 'published_at'].forEach((k) => {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); binds.push(fields[k]); }
  });
  if (!sets.length) return findArticleById(env, id);
  binds.push(Number(id));
  await env.DB.prepare(`UPDATE articles SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findArticleById(env, id);
}

export async function deleteArticleById(env, id) {
  await env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(Number(id)).run();
}

// ---------- legal: acts ----------

export async function listLegalActs(env) {
  const { results } = await env.DB.prepare('SELECT * FROM legal_acts ORDER BY slug ASC').all();
  return results;
}

export async function findLegalActBySlug(env, slug) {
  return env.DB.prepare('SELECT * FROM legal_acts WHERE slug = ?').bind(slug).first();
}

export async function insertLegalAct(env, { slug, title, shortTitle, category, status, dataJson }) {
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO legal_acts (slug, title, short_title, category, status, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(slug, title, shortTitle, category, status, dataJson, now, now).run();
  } catch (err) {
    if (String(err && err.message || '').toUpperCase().includes('UNIQUE')) {
      const e = new Error('An act with that slug already exists.');
      e.code = 'DUPLICATE';
      throw e;
    }
    throw err;
  }
  return findLegalActBySlug(env, slug);
}

export async function updateLegalAct(env, slug, { title, shortTitle, category, status, dataJson }) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE legal_acts SET title = ?, short_title = ?, category = ?, status = ?, data = ?, updated_at = ? WHERE slug = ?`
  ).bind(title, shortTitle, category, status, dataJson, now, slug).run();
  return findLegalActBySlug(env, slug);
}

export async function deleteLegalActBySlug(env, slug) {
  await env.DB.prepare('DELETE FROM legal_acts WHERE slug = ?').bind(slug).run();
}

// ---------- legal: case law ----------

export async function listLegalCaseLaw(env) {
  const { results } = await env.DB.prepare('SELECT * FROM legal_case_law ORDER BY slug ASC').all();
  return results;
}

export async function findLegalCaseBySlug(env, slug) {
  return env.DB.prepare('SELECT * FROM legal_case_law WHERE slug = ?').bind(slug).first();
}

export async function insertLegalCase(env, { slug, title, refNumber, dataJson }) {
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO legal_case_law (slug, title, ref_number, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(slug, title, refNumber, dataJson, now, now).run();
  } catch (err) {
    if (String(err && err.message || '').toUpperCase().includes('UNIQUE')) {
      const e = new Error('A case with that slug already exists.');
      e.code = 'DUPLICATE';
      throw e;
    }
    throw err;
  }
  return findLegalCaseBySlug(env, slug);
}

export async function updateLegalCase(env, slug, { title, refNumber, dataJson }) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE legal_case_law SET title = ?, ref_number = ?, data = ?, updated_at = ? WHERE slug = ?`
  ).bind(title, refNumber, dataJson, now, slug).run();
  return findLegalCaseBySlug(env, slug);
}

export async function deleteLegalCaseBySlug(env, slug) {
  await env.DB.prepare('DELETE FROM legal_case_law WHERE slug = ?').bind(slug).run();
}

// ---------- legal: drafts (adapter workflow) ----------

export async function listLegalDrafts(env) {
  const { results } = await env.DB.prepare('SELECT * FROM legal_drafts ORDER BY id DESC').all();
  return results;
}

export async function findLegalDraftById(env, id) {
  return env.DB.prepare('SELECT * FROM legal_drafts WHERE id = ?').bind(Number(id)).first();
}

export async function insertLegalDraft(env, { kind, targetSlug, title, author, payloadJson }) {
  const now = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO legal_drafts (kind, target_slug, title, status, author, payload, reviewer_note, reviewed_by, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, NULL, NULL, ?, ?)`
  ).bind(kind, targetSlug || null, title, author, payloadJson, now, now).run();
  return findLegalDraftById(env, result.meta.last_row_id);
}

export async function updateLegalDraft(env, id, fields) {
  const sets = [];
  const binds = [];
  if (fields.kind !== undefined)          { sets.push('kind = ?');          binds.push(fields.kind); }
  if (fields.targetSlug !== undefined)    { sets.push('target_slug = ?');    binds.push(fields.targetSlug || null); }
  if (fields.title !== undefined)         { sets.push('title = ?');          binds.push(fields.title); }
  if (fields.status !== undefined)        { sets.push('status = ?');         binds.push(fields.status); }
  if (fields.payload !== undefined)       { sets.push('payload = ?');        binds.push(fields.payload); }
  if (fields.reviewerNote !== undefined)  { sets.push('reviewer_note = ?');  binds.push(fields.reviewerNote || null); }
  if (fields.reviewedBy !== undefined)    { sets.push('reviewed_by = ?');    binds.push(fields.reviewedBy || null); }
  if (!sets.length) return findLegalDraftById(env, id);
  sets.push('updated_at = ?');
  binds.push(nowIso(), Number(id));
  await env.DB.prepare(`UPDATE legal_drafts SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findLegalDraftById(env, id);
}

export async function deleteLegalDraftById(env, id) {
  await env.DB.prepare('DELETE FROM legal_drafts WHERE id = ?').bind(Number(id)).run();
}

// ---------- land registry: plots ----------

export async function listLandPlots(env) {
  const { results } = await env.DB
    .prepare('SELECT * FROM land_plots ORDER BY division_code ASC, book_number ASC, control_digit ASC')
    .all();
  return results;
}

export async function findLandPlotByNumber(env, registerNumber) {
  return env.DB.prepare('SELECT * FROM land_plots WHERE register_number = ?').bind(registerNumber).first();
}

// Highest existing book number on file for a division, as a plain
// integer (0 if the division has no plots yet) — used by the admin
// panel's "Next Book Number" button so book numbers are assigned
// sequentially per division without two admins racing for the same
// one (the create call still re-checks uniqueness at the DB level).
export async function maxBookNumberForDivision(env, divisionCode) {
  const row = await env.DB.prepare(
    "SELECT MAX(CAST(book_number AS INTEGER)) AS maxNum FROM land_plots WHERE division_code = ?"
  ).bind(divisionCode).first();
  return (row && row.maxNum) || 0;
}

export async function insertLandPlot(env, fields) {
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO land_plots
         (register_number, division_code, book_number, control_digit, world, owner, resident, is_rented, y_lower, y_upper, status, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      fields.registerNumber, fields.divisionCode, fields.bookNumber, fields.controlDigit,
      fields.world || '', fields.owner || '', fields.resident || '', fields.isRented ? 1 : 0,
      fields.yLower, fields.yUpper, fields.status || 'registered', fields.dataJson, now, now
    ).run();
  } catch (err) {
    if (String(err && err.message || '').toUpperCase().includes('UNIQUE')) {
      const e = new Error('A plot with that register number already exists.');
      e.code = 'DUPLICATE';
      throw e;
    }
    throw err;
  }
  return findLandPlotByNumber(env, fields.registerNumber);
}

// division_code/book_number/control_digit are deliberately NOT
// updatable here — they compose the register_number primary key
// (same convention as legal_acts.slug). An admin who needs to
// change them deletes the record and creates it again under the
// correct number.
export async function updateLandPlot(env, registerNumber, fields) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE land_plots
        SET world = ?, owner = ?, resident = ?, is_rented = ?, y_lower = ?, y_upper = ?, status = ?, data = ?, updated_at = ?
      WHERE register_number = ?`
  ).bind(
    fields.world || '', fields.owner || '', fields.resident || '', fields.isRented ? 1 : 0,
    fields.yLower, fields.yUpper, fields.status || 'registered', fields.dataJson, now, registerNumber
  ).run();
  return findLandPlotByNumber(env, registerNumber);
}

export async function deleteLandPlotByNumber(env, registerNumber) {
  await env.DB.prepare('DELETE FROM land_plots WHERE register_number = ?').bind(registerNumber).run();
}

// ════════════════════════════════════════════════════════════
// BANKING — Fiducia Banking System
// All functions interact with the banking_* tables created
// in migrations/0006_banking.sql.
// ════════════════════════════════════════════════════════════

// ---------- 2A: settings ----------

export async function getBankingSettings(env) {
  const row = await env.DB.prepare('SELECT * FROM banking_settings WHERE id = 1').first();
  if (!row) throw new Error('banking_settings singleton row not found.');
  return { ...row, currency_prices: JSON.parse(row.currency_prices || '{}') };
}

export async function updateBankingSettings(env, fields) {
  const allowed = [
    'currency_prices', 'cumulative_limit', 'cumulative_price', 'bank_owner_key',
    'tax_enabled', 'tax_rate_personal', 'tax_rate_company', 'tax_threshold',
    'tax_period_days', 'tax_last_run_at',
  ];
  const sets = [];
  const binds = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    binds.push(k === 'currency_prices' ? JSON.stringify(v) : v);
  }
  if (!sets.length) return getBankingSettings(env);
  sets.push('updated_at = ?');
  binds.push(nowIso(), 1);
  await env.DB.prepare(`UPDATE banking_settings SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return getBankingSettings(env);
}

// ---------- 2B: account key generation ----------

export async function generateAccountKey(env) {
  // Format: '1000' + 4-digit zero-padded sequential + 8 random digits
  // matches the CC Bank Server format exactly for card compatibility.
  const row = await env.DB.prepare(
    "SELECT MAX(CAST(SUBSTR(key, 5, 4) AS INTEGER)) AS maxSeq FROM banking_accounts WHERE SUBSTR(key, 1, 4) = '1000'"
  ).first();
  const nextSeq = ((row && row.maxSeq) || 0) + 1;
  if (nextSeq > 9999) throw new Error('Account number limit reached (max 9999).');
  const seqStr = String(nextSeq).padStart(4, '0');
  const randomPart = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
  const key = '1000' + seqStr + randomPart;
  // Collision guard (astronomically unlikely with 8 random digits, but correct)
  const existing = await env.DB.prepare('SELECT key FROM banking_accounts WHERE key = ?').bind(key).first();
  if (existing) {
    const rp2 = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
    return '1000' + seqStr + rp2;
  }
  return key;
}

// ---------- 2C: accounts CRUD ----------

// password_hash is intentionally excluded from all public-facing SELECTs.
// Use findBankingAccountByKeyWithHash only for internal password verification.
const ACCOUNT_COLS = 'id, key, name, balance, color, type, owner_key, treasury_key, shares, tag, frozen, cumulative, user_id, state_owned, created_at, updated_at';

export async function listBankingAccounts(env, filters = {}) {
  const { type, treasuryKey, frozen, search } = filters;
  const conditions = [];
  const binds = [];
  if (type)                                              { conditions.push('type = ?');                    binds.push(type); }
  if (treasuryKey !== undefined && treasuryKey !== null) { conditions.push('treasury_key = ?');            binds.push(treasuryKey); }
  if (frozen !== undefined)                              { conditions.push('frozen = ?');                  binds.push(frozen ? 1 : 0); }
  if (search)                                            { conditions.push('(name LIKE ? OR key LIKE ?)'); binds.push(`%${search}%`, `%${search}%`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results } = await env.DB.prepare(
    `SELECT ${ACCOUNT_COLS} FROM banking_accounts ${where} ORDER BY name COLLATE NOCASE ASC`
  ).bind(...binds).all();
  return results;
}

export async function findBankingAccountByKey(env, key) {
  return env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM banking_accounts WHERE key = ?`).bind(key).first();
}

export async function findBankingAccountByKeyWithHash(env, key) {
  // Internal use only — for password verification. Never expose to API responses.
  return env.DB.prepare('SELECT * FROM banking_accounts WHERE key = ?').bind(key).first();
}

export async function findBankingAccountByUserId(env, userId) {
  return env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM banking_accounts WHERE user_id = ?`).bind(Number(userId)).first();
}

/** Returns true if another company (bank account or exchange listing) already
 *  uses the given name, case-insensitively. excludeKey skips the company being
 *  renamed so it can keep its own name. */
export async function companyNameExists(env, name, excludeKey = '') {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;

  const bank = await env.DB.prepare(
    "SELECT key FROM banking_accounts WHERE type = 'company' AND name = ? COLLATE NOCASE AND key != ? LIMIT 1"
  ).bind(trimmed, excludeKey).first();
  if (bank) return true;

  const fdx = await env.DB.prepare(
    "SELECT id FROM fdx_companies WHERE name = ? COLLATE NOCASE AND COALESCE(linked_bank_account, '') != ? LIMIT 1"
  ).bind(trimmed, excludeKey).first();
  return !!fdx;
}

export async function findBankingAccountsByTreasury(env, treasuryKey) {
  const { results } = await env.DB.prepare(
    `SELECT ${ACCOUNT_COLS} FROM banking_accounts WHERE treasury_key = ? ORDER BY name COLLATE NOCASE ASC`
  ).bind(treasuryKey).all();
  return results;
}

export async function insertBankingAccount(env, {
  key, name, balance = 0, color = 16384, type = 'personal',
  ownerKey = '', treasuryKey = '', passwordHash = '', shares = 0, tag = '',
  stateOwned = 0,
}) {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO banking_accounts
       (key, name, balance, color, type, owner_key, treasury_key, password_hash, shares, tag, frozen, cumulative, state_owned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
  ).bind(key, name, balance, color, type, ownerKey, treasuryKey, passwordHash, shares, String(tag).toUpperCase(), stateOwned ? 1 : 0, now, now).run();
  return findBankingAccountByKey(env, key);
}

export async function updateBankingAccount(env, key, fields) {
  const allowed = ['name', 'color', 'frozen', 'shares', 'tag', 'cumulative', 'password_hash', 'treasury_key', 'state_owned'];
  const sets = [];
  const binds = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    binds.push(k === 'tag' ? String(v).toUpperCase() : v);
  }
  if (!sets.length) return findBankingAccountByKey(env, key);
  sets.push('updated_at = ?');
  binds.push(nowIso(), key);
  await env.DB.prepare(`UPDATE banking_accounts SET ${sets.join(', ')} WHERE key = ?`).bind(...binds).run();
  return findBankingAccountByKey(env, key);
}

export async function deleteBankingAccount(env, key) {
  // Company accounts double as exchange listings. Remove the listing (and its
  // dependent exchange rows) first so a deleted company disappears from the
  // companies tab and every public listing instead of lingering as an orphan.
  const account = await env.DB.prepare('SELECT type FROM banking_accounts WHERE key = ?').bind(key).first();
  if (account && account.type === 'company') {
    await deleteCompanyListing(env, key);
  }
  await env.DB.prepare('DELETE FROM banking_accounts WHERE key = ?').bind(key).run();
}

/**
 * Deletes a company's exchange listing and all dependent rows (orders, trades,
 * holdings, candles, dividends, reports, halts, watchlist, shareholders, value
 * history) so the company is fully removed. No-op if there is no linked listing.
 */
export async function deleteCompanyListing(env, bankKey) {
  const company = await env.DB.prepare(
    'SELECT id FROM fdx_companies WHERE linked_bank_account = ?'
  ).bind(bankKey).first();
  if (!company) return;

  const id = company.id;
  // Children before parents so the delete succeeds even with FKs enforced.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM fdx_trades WHERE company_id = ?').bind(id),
    env.DB.prepare('DELETE FROM fdx_orders WHERE company_id = ?').bind(id),
    env.DB.prepare('DELETE FROM fdx_portfolios WHERE company_id = ?').bind(id),
    env.DB.prepare('DELETE FROM fdx_candles WHERE company_id = ?').bind(id),
    env.DB.prepare('DELETE FROM fdx_dividends WHERE company_id = ?').bind(id),
    env.DB.prepare('DELETE FROM fdx_company_reports WHERE company_id = ?').bind(id),
    env.DB.prepare('DELETE FROM fdx_halt_log WHERE company_id = ?').bind(id),
    env.DB.prepare('DELETE FROM fdx_watchlist WHERE company_id = ?').bind(id),
    env.DB.prepare('DELETE FROM banking_shareholders WHERE company_key = ?').bind(bankKey),
    env.DB.prepare('DELETE FROM banking_value_history WHERE company_key = ?').bind(bankKey),
  ]);
  await env.DB.prepare('DELETE FROM fdx_companies WHERE id = ?').bind(id).run();
}

export async function linkBankingAccountToUser(env, accountKey, userId) {
  await env.DB.prepare('UPDATE banking_accounts SET user_id = ?, updated_at = ? WHERE key = ?')
    .bind(userId != null ? Number(userId) : null, nowIso(), accountKey).run();
}

// ---------- 2D: transactions ----------

export async function getBankingTransactionLog(env, accountKey, { limit = 50, offset = 0 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM banking_transactions
     WHERE from_key = ? OR to_key = ?
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(accountKey, accountKey, limit, offset).all();
  // Annotate with role and CC-compatible aliases so routes don't need to reshape
  return results.map(row => {
    const isDebit = row.from_key === accountKey;
    return {
      ...row,
      role:        isDebit ? 'debit' : 'credit',
      other_key:   isDebit ? row.to_key   : row.from_key,
      // CC-compatible aliases used by the banking-cc bridge
      other:       isDebit ? row.to_key   : row.from_key,
      amount:      isDebit ? -row.amount  : row.amount,
      balance:     isDebit ? row.from_balance_after : row.to_balance_after,
      time:        row.created_at,
      description: row.description,
    };
  });
}

export async function getGlobalBankingTransactionLog(env, { limit = 100, offset = 0 } = {}) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM banking_transactions ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();
  return results;
}

// ---------- 2E: atomic balance operations ----------

// Internal helper: transfers balance directly without triggering a
// recursive cumulative-fee check. Used by checkAndApplyCumulativeFee
// and applyTaxes to prevent infinite loops.
async function _directTransfer(env, { fromKey, toKey, amount, description, initiatedBy }) {
  const now = nowIso();
  const [from, to] = await Promise.all([
    env.DB.prepare('SELECT balance FROM banking_accounts WHERE key = ?').bind(fromKey).first(),
    env.DB.prepare('SELECT balance FROM banking_accounts WHERE key = ?').bind(toKey).first(),
  ]);
  if (!from || !to || from.balance < amount) return false;
  const fromAfter = Math.round((from.balance - amount) * 100) / 100;
  const toAfter   = Math.round((to.balance   + amount) * 100) / 100;
  await env.DB.batch([
    env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(fromAfter, now, fromKey),
    env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(toAfter,   now, toKey),
    env.DB.prepare(
      'INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(fromKey, toKey, amount, fromAfter, toAfter, description, initiatedBy, now),
  ]);
  return true;
}

export async function checkAndApplyCumulativeFee(env, accountKey, amountMoved) {
  let settings;
  try { settings = await getBankingSettings(env); } catch { return; }
  const { cumulative_limit, cumulative_price, bank_owner_key } = settings;
  if (!cumulative_limit || !cumulative_price || !bank_owner_key) return;

  const account = await env.DB.prepare(
    'SELECT key, balance, cumulative, type FROM banking_accounts WHERE key = ?'
  ).bind(accountKey).first();
  if (!account) return;

  // Treasury accounts are the fee sink — never charge them recursively
  if (account.type === 'treasury' || accountKey === bank_owner_key) {
    const newCumulative = (account.cumulative || 0) + amountMoved;
    await env.DB.prepare('UPDATE banking_accounts SET cumulative = ?, updated_at = ? WHERE key = ?')
      .bind(newCumulative, nowIso(), accountKey).run();
    return;
  }

  let cumulative = (account.cumulative || 0) + amountMoved;
  let fee = 0;
  let remaining = cumulative;
  while (remaining >= cumulative_limit) { fee += cumulative_price; remaining -= cumulative_limit; }

  if (fee > 0 && account.balance >= fee) {
    const ownerExists = await env.DB.prepare('SELECT key FROM banking_accounts WHERE key = ?').bind(bank_owner_key).first();
    if (ownerExists) {
      const ok = await _directTransfer(env, {
        fromKey: accountKey, toKey: bank_owner_key,
        amount: fee, description: 'Fiducia expenses', initiatedBy: 'system:fee',
      });
      if (ok) cumulative = remaining;
    }
  }

  await env.DB.prepare('UPDATE banking_accounts SET cumulative = ?, updated_at = ? WHERE key = ?')
    .bind(cumulative, nowIso(), accountKey).run();
}

export async function atomicTransfer(env, { fromKey, toKey, amount, description = '', initiatedBy = 'system' }) {
  if (fromKey === toKey) {
    const e = new Error('Cannot transfer to the same account.'); e.code = 'SELF_TRANSFER'; throw e;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    const e = new Error('Invalid amount.'); e.code = 'INVALID_AMOUNT'; throw e;
  }

  const [from, to] = await Promise.all([
    env.DB.prepare('SELECT key, balance, type, frozen FROM banking_accounts WHERE key = ?').bind(fromKey).first(),
    env.DB.prepare('SELECT key, balance, type, frozen FROM banking_accounts WHERE key = ?').bind(toKey).first(),
  ]);

  if (!from) { const e = new Error('Source account not found.');      e.code = 'NOT_FOUND'; throw e; }
  if (!to)   { const e = new Error('Destination account not found.'); e.code = 'NOT_FOUND'; throw e; }
  if (from.frozen) { const e = new Error('Source account is frozen.');      e.code = 'FROZEN'; throw e; }
  if (to.frozen)   { const e = new Error('Destination account is frozen.'); e.code = 'FROZEN'; throw e; }
  if (from.balance < amount) { const e = new Error('Insufficient balance.'); e.code = 'INSUFFICIENT_BALANCE'; throw e; }

  // Type transfer rules — matches CC Bank Server exactly
  const ft = from.type, tt = to.type;
  let allowed = false;
  if (ft === 'personal') allowed = tt === 'personal' || tt === 'treasury';
  if (ft === 'company')  allowed = tt === 'personal' || tt === 'company'  || tt === 'treasury';
  if (ft === 'treasury') allowed = tt === 'personal' || tt === 'company';
  if (!allowed) {
    const e = new Error('Transfer between these account types is not permitted.'); e.code = 'TYPE_MISMATCH'; throw e;
  }

  const now = nowIso();
  const fromBalanceAfter = Math.round((from.balance - amount) * 100) / 100;
  const toBalanceAfter   = Math.round((to.balance   + amount) * 100) / 100;

  await env.DB.batch([
    env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(fromBalanceAfter, now, fromKey),
    env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(toBalanceAfter,   now, toKey),
    env.DB.prepare(
      'INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(fromKey, toKey, amount, fromBalanceAfter, toBalanceAfter, description, initiatedBy, now),
  ]);

  await checkAndApplyCumulativeFee(env, fromKey, amount);
  await checkAndApplyCumulativeFee(env, toKey,   amount);

  return { success: true, fromBalanceAfter, toBalanceAfter };
}

export async function atomicDeposit(env, { accountKey, amount, description = 'Deposit', initiatedBy = 'system' }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    const e = new Error('Invalid amount.'); e.code = 'INVALID_AMOUNT'; throw e;
  }
  const account = await env.DB.prepare('SELECT key, balance, frozen FROM banking_accounts WHERE key = ?').bind(accountKey).first();
  if (!account)       { const e = new Error('Account not found.'); e.code = 'NOT_FOUND'; throw e; }
  if (account.frozen) { const e = new Error('Account is frozen.'); e.code = 'FROZEN';    throw e; }

  const now = nowIso();
  const balanceAfter = Math.round((account.balance + amount) * 100) / 100;

  await env.DB.batch([
    env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(balanceAfter, now, accountKey),
    env.DB.prepare(
      'INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind('__deposit__', accountKey, amount, 0, balanceAfter, description, initiatedBy, now),
  ]);

  await checkAndApplyCumulativeFee(env, accountKey, amount);
  return { success: true, balanceAfter };
}

export async function atomicWithdraw(env, { accountKey, amount, description = 'Withdrawal', initiatedBy = 'system' }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    const e = new Error('Invalid amount.'); e.code = 'INVALID_AMOUNT'; throw e;
  }
  const account = await env.DB.prepare('SELECT key, balance, frozen FROM banking_accounts WHERE key = ?').bind(accountKey).first();
  if (!account)              { const e = new Error('Account not found.'); e.code = 'NOT_FOUND';            throw e; }
  if (account.frozen)        { const e = new Error('Account is frozen.'); e.code = 'FROZEN';               throw e; }
  if (account.balance < amount) { const e = new Error('Insufficient balance.'); e.code = 'INSUFFICIENT_BALANCE'; throw e; }

  const now = nowIso();
  const balanceAfter = Math.round((account.balance - amount) * 100) / 100;

  await env.DB.batch([
    env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(balanceAfter, now, accountKey),
    env.DB.prepare(
      'INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(accountKey, '__withdraw__', amount, balanceAfter, 0, description, initiatedBy, now),
  ]);

  await checkAndApplyCumulativeFee(env, accountKey, amount);
  return { success: true, balanceAfter };
}

// ---------- 2F: cards ----------

export async function listBankingCards(env, accountKey) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM banking_cards WHERE account_key = ? ORDER BY created_at DESC'
  ).bind(accountKey).all();
  return results;
}

export async function findBankingCard(env, cardId) {
  return env.DB.prepare('SELECT * FROM banking_cards WHERE card_id = ?').bind(cardId).first();
}

export async function insertBankingCard(env, { cardId, accountKey, issuedBy = '' }) {
  const account = await findBankingAccountByKey(env, accountKey);
  if (!account) { const e = new Error('Account not found.'); e.code = 'NOT_FOUND'; throw e; }

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM banking_cards WHERE account_key = ? AND status = 'active'"
  ).bind(accountKey).first();
  const activeCount = (countRow && countRow.c) || 0;

  if (account.type === 'treasury' && activeCount >= 1) {
    const e = new Error('Treasury accounts may only have 1 active card.'); e.code = 'CARD_LIMIT'; throw e;
  }
  if (account.type === 'company' && activeCount >= 2) {
    const e = new Error('Company accounts may only have 2 active cards.'); e.code = 'CARD_LIMIT'; throw e;
  }

  const now = nowIso();
  await env.DB.prepare(
    'INSERT INTO banking_cards (card_id, account_key, status, issued_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(cardId, accountKey, 'active', issuedBy, now, now).run();

  // Issuing a new card fulfils any pending reissue requests for this account.
  await env.DB.prepare(
    "UPDATE banking_cards SET reissue_requested = 0, updated_at = ? WHERE account_key = ? AND reissue_requested = 1"
  ).bind(now, accountKey).run();

  return { cardId, accountKey, status: 'active', issuedBy, created_at: now };
}

export async function updateBankingCard(env, cardId, fields) {
  const allowed = ['status'];
  const sets = [];
  const binds = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`); binds.push(v);
  }
  if (!sets.length) return findBankingCard(env, cardId);
  sets.push('updated_at = ?');
  binds.push(nowIso(), cardId);
  await env.DB.prepare(`UPDATE banking_cards SET ${sets.join(', ')} WHERE card_id = ?`).bind(...binds).run();
  return findBankingCard(env, cardId);
}

export async function deleteBankingCard(env, cardId) {
  await env.DB.prepare('DELETE FROM banking_cards WHERE card_id = ?').bind(cardId).run();
}

export async function deleteBankingCardById(env, id) {
  await env.DB.prepare('DELETE FROM banking_cards WHERE id = ?').bind(Number(id)).run();
}

export async function reportBankingCardLost(env, accountKey, cardId, reason = '') {
  const card = await env.DB.prepare(
    'SELECT * FROM banking_cards WHERE card_id = ? AND account_key = ?'
  ).bind(cardId, accountKey).first();
  if (!card) return null;
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE banking_cards SET status = 'canceled', reissue_requested = 1, reissue_reason = ?, reissue_requested_at = ?, updated_at = ?
     WHERE card_id = ?`
  ).bind(String(reason || 'Reported lost').slice(0, 200), now, now, cardId).run();
  return findBankingCard(env, cardId);
}

export async function validateBankingCard(env, accountKey, cardId) {
  const card = await env.DB.prepare(
    "SELECT * FROM banking_cards WHERE card_id = ? AND account_key = ? AND status = 'active'"
  ).bind(cardId, accountKey).first();
  if (!card) return false;
  const account = await env.DB.prepare('SELECT frozen FROM banking_accounts WHERE key = ?').bind(accountKey).first();
  return !!(account && !account.frozen);
}

// ---------- 2G: shareholders ----------

export async function listShareholders(env, companyKey) {
  const { results } = await env.DB.prepare(
    `SELECT bs.company_key, bs.holder_key, bs.shares, ba.name
     FROM banking_shareholders bs
     JOIN banking_accounts ba ON ba.key = bs.holder_key
     WHERE bs.company_key = ?
     ORDER BY bs.shares DESC`
  ).bind(companyKey).all();
  return results;
}

export async function getShareholderEntry(env, companyKey, holderKey) {
  return env.DB.prepare(
    'SELECT * FROM banking_shareholders WHERE company_key = ? AND holder_key = ?'
  ).bind(companyKey, holderKey).first();
}

export async function upsertShareholder(env, companyKey, holderKey, deltaShares) {
  const now = nowIso();
  const existing = await getShareholderEntry(env, companyKey, holderKey);
  if (existing) {
    const newShares = Math.max(0, (existing.shares || 0) + deltaShares);
    await env.DB.prepare(
      'UPDATE banking_shareholders SET shares = ?, updated_at = ? WHERE company_key = ? AND holder_key = ?'
    ).bind(newShares, now, companyKey, holderKey).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO banking_shareholders (company_key, holder_key, shares, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(companyKey, holderKey, Math.max(0, deltaShares), now, now).run();
  }
}

export async function atomicIssueShares(env, { issuerKey, companyKey, buyerKey, shareCount }) {
  if (!Number.isInteger(shareCount) || shareCount <= 0) {
    const e = new Error('Share count must be a positive integer.'); e.code = 'INVALID_AMOUNT'; throw e;
  }
  if (companyKey === buyerKey) {
    const e = new Error('A company cannot buy its own newly issued shares.'); e.code = 'SELF_TRANSFER'; throw e;
  }

  const [company, buyer] = await Promise.all([
    env.DB.prepare('SELECT key, type, owner_key, balance, shares FROM banking_accounts WHERE key = ?').bind(companyKey).first(),
    env.DB.prepare('SELECT key, type, balance, frozen FROM banking_accounts WHERE key = ?').bind(buyerKey).first(),
  ]);

  if (!company || company.type !== 'company') { const e = new Error('Invalid company account.'); e.code = 'NOT_FOUND';   throw e; }
  if (company.owner_key !== issuerKey)         { const e = new Error('Only the company owner can issue shares.'); e.code = 'FORBIDDEN'; throw e; }
  if (!buyer)                                  { const e = new Error('Buyer account not found.'); e.code = 'NOT_FOUND';  throw e; }
  if (buyer.type !== 'personal' && buyer.type !== 'company') {
    const e = new Error('Buyer must be a personal or company account.'); e.code = 'TYPE_MISMATCH'; throw e;
  }
  if (buyer.frozen) { const e = new Error('Buyer account is frozen.'); e.code = 'FROZEN'; throw e; }

  // Price per share: 0 if no shares outstanding yet (founder / first issuance is free)
  const currentShares = company.shares || 0;
  const pricePerShare = currentShares > 0 ? Math.round((company.balance / currentShares) * 100) / 100 : 0;
  const totalPrice    = Math.round(pricePerShare * shareCount * 100) / 100;

  if (totalPrice > 0 && buyer.balance < totalPrice) {
    const e = new Error('Buyer has insufficient balance.'); e.code = 'INSUFFICIENT_BALANCE'; throw e;
  }

  const now = nowIso();
  const newShares = currentShares + shareCount;
  const existing  = await getShareholderEntry(env, companyKey, buyerKey);
  const newHolderShares = ((existing && existing.shares) || 0) + shareCount;

  const batch = [];

  if (totalPrice > 0) {
    const buyerAfter = Math.round((buyer.balance  - totalPrice) * 100) / 100;
    const coAfter    = Math.round((company.balance + totalPrice) * 100) / 100;
    batch.push(
      env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(buyerAfter, now, buyerKey),
      env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(coAfter,    now, companyKey),
      env.DB.prepare(
        'INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(buyerKey, companyKey, totalPrice, buyerAfter, coAfter, 'Share issuance', 'system', now)
    );
  }

  batch.push(env.DB.prepare('UPDATE banking_accounts SET shares = ?, updated_at = ? WHERE key = ?').bind(newShares, now, companyKey));

  if (existing) {
    batch.push(env.DB.prepare(
      'UPDATE banking_shareholders SET shares = ?, updated_at = ? WHERE company_key = ? AND holder_key = ?'
    ).bind(newHolderShares, now, companyKey, buyerKey));
  } else {
    batch.push(env.DB.prepare(
      'INSERT INTO banking_shareholders (company_key, holder_key, shares, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(companyKey, buyerKey, newHolderShares, now, now));
  }

  await env.DB.batch(batch);
  if (totalPrice > 0) await checkAndApplyCumulativeFee(env, buyerKey, totalPrice);

  return { success: true, pricePerShare, totalPrice, newShares, newHolderShares };
}

// ---------- 2H: company value history ----------

export async function insertCompanyValueSnapshot(env, companyKey, value) {
  const now    = nowIso();
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO banking_value_history (company_key, value, recorded_at) VALUES (?, ?, ?)').bind(companyKey, value, now),
    env.DB.prepare('DELETE FROM banking_value_history WHERE company_key = ? AND recorded_at < ?').bind(companyKey, cutoff),
  ]);
}

export async function getCompanyValueHistory(env, companyKey, sinceISO) {
  const { results } = sinceISO
    ? await env.DB.prepare('SELECT value, recorded_at FROM banking_value_history WHERE company_key = ? AND recorded_at >= ? ORDER BY recorded_at ASC').bind(companyKey, sinceISO).all()
    : await env.DB.prepare('SELECT value, recorded_at FROM banking_value_history WHERE company_key = ? ORDER BY recorded_at ASC').bind(companyKey).all();
  return results;
}

// ---------- 2I: top companies ----------

export async function getTopCompanies(env, limit = 10) {
  const { results } = await env.DB.prepare(
    "SELECT key, name, balance, shares FROM banking_accounts WHERE type = 'company' ORDER BY balance DESC LIMIT ?"
  ).bind(limit).all();

  const cutoff24h = new Date(Date.now() - 86400000).toISOString();

  return Promise.all(results.map(async (co) => {
    const histRow = await env.DB.prepare(
      'SELECT value FROM banking_value_history WHERE company_key = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1'
    ).bind(co.key, cutoff24h).first();
    const change = (histRow && histRow.value > 0)
      ? Math.round(((co.balance - histRow.value) / histRow.value) * 10000) / 100
      : null;
    return { ...co, change };
  }));
}

// ---------- 2J: tax application ----------

export async function applyTaxes(env, initiatedBy = 'system:cron') {
  const settings = await getBankingSettings(env);
  if (!settings.tax_enabled) return { applied: 0, totalCollected: 0 };

  const { tax_rate_personal, tax_rate_company, tax_threshold } = settings;

  // Fetch all non-treasury, non-frozen accounts at or above the threshold
  const { results: accounts } = await env.DB.prepare(
    "SELECT key, balance, type, treasury_key FROM banking_accounts WHERE type != 'treasury' AND frozen = 0 AND balance >= ?"
  ).bind(tax_threshold || 0).all();

  let applied = 0;
  let totalCollected = 0;
  const now = nowIso();

  for (const account of accounts) {
    const rate = account.type === 'company' ? (tax_rate_company || 0) : (tax_rate_personal || 0);
    if (rate <= 0) continue;

    const taxAmount = Math.floor((account.balance * rate / 100) * 100) / 100;
    if (taxAmount <= 0 || account.balance < taxAmount) continue;

    const fromAfter = Math.round((account.balance - taxAmount) * 100) / 100;

    if (account.treasury_key) {
      const treasury = await env.DB.prepare(
        "SELECT key, balance FROM banking_accounts WHERE key = ? AND type = 'treasury'"
      ).bind(account.treasury_key).first();
      if (treasury) {
        const toAfter = Math.round((treasury.balance + taxAmount) * 100) / 100;
        await env.DB.batch([
          env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(fromAfter, now, account.key),
          env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(toAfter,   now, account.treasury_key),
          env.DB.prepare(
            'INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(account.key, account.treasury_key, taxAmount, fromAfter, toAfter, 'Taxes', initiatedBy, now),
        ]);
        applied++;
        totalCollected = Math.round((totalCollected + taxAmount) * 100) / 100;
        continue;
      }
    }

    // No treasury sink — deduct without crediting anywhere (money destroyed)
    await env.DB.batch([
      env.DB.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(fromAfter, now, account.key),
      env.DB.prepare(
        'INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(account.key, '__system__', taxAmount, fromAfter, 0, 'Taxes', initiatedBy, now),
    ]);
    applied++;
    totalCollected = Math.round((totalCollected + taxAmount) * 100) / 100;
  }

  await env.DB.prepare('UPDATE banking_settings SET tax_last_run_at = ?, updated_at = ? WHERE id = 1').bind(now, now).run();
  return { applied, totalCollected };
}

// ---------- 2K: banker assignments ----------

export async function getBankerAssignment(env, userId) {
  return env.DB.prepare(
    `SELECT bba.user_id, bba.treasury_key, bba.assigned_at,
            ba.name AS treasury_name, ba.tag AS treasury_tag, ba.color AS treasury_color
     FROM banking_banker_assignments bba
     JOIN banking_accounts ba ON ba.key = bba.treasury_key
     WHERE bba.user_id = ?`
  ).bind(Number(userId)).first();
}

export async function upsertBankerAssignment(env, { userId, treasuryKey, assignedBy }) {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO banking_banker_assignments (user_id, treasury_key, assigned_by, assigned_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       treasury_key = excluded.treasury_key,
       assigned_by  = excluded.assigned_by,
       assigned_at  = excluded.assigned_at`
  ).bind(Number(userId), treasuryKey, assignedBy ? Number(assignedBy) : null, now).run();
}

export async function deleteBankerAssignment(env, userId) {
  await env.DB.prepare('DELETE FROM banking_banker_assignments WHERE user_id = ?').bind(Number(userId)).run();
}

export async function listBankerAssignments(env) {
  const { results } = await env.DB.prepare(
    `SELECT bba.user_id, bba.treasury_key, bba.assigned_at,
            u.username,
            ba.name AS treasury_name, ba.tag AS treasury_tag, ba.color AS treasury_color
     FROM banking_banker_assignments bba
     JOIN users u              ON u.id  = bba.user_id
     JOIN banking_accounts ba  ON ba.key = bba.treasury_key
     ORDER BY u.username ASC`
  ).all();
  return results;
}

// ---------- 2L: CC tokens ----------

export async function findCCToken(env, tokenHash) {
  const row = await env.DB.prepare('SELECT * FROM banking_cc_tokens WHERE token_hash = ?').bind(tokenHash).first();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null; // expired
  return row;
}

export async function insertCCToken(env, { tokenHash, terminalType, computerLabel = '', treasuryKey = '', createdBy, expiresAt = '' }) {
  const now = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO banking_cc_tokens
       (token_hash, terminal_type, computer_label, treasury_key, created_by, last_used_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?)`
  ).bind(tokenHash, terminalType, computerLabel, treasuryKey, createdBy ? Number(createdBy) : null, expiresAt, now).run();
  return result.meta.last_row_id;
}

export async function updateCCTokenLastUsed(env, tokenHash) {
  await env.DB.prepare('UPDATE banking_cc_tokens SET last_used_at = ? WHERE token_hash = ?')
    .bind(nowIso(), tokenHash).run();
}

export async function deleteCCToken(env, tokenHash) {
  await env.DB.prepare('DELETE FROM banking_cc_tokens WHERE token_hash = ?').bind(tokenHash).run();
}

export async function deleteCCTokenById(env, id) {
  await env.DB.prepare('DELETE FROM banking_cc_tokens WHERE id = ?').bind(Number(id)).run();
}

export async function listCCTokens(env) {
  // token_hash intentionally excluded — it is a one-way hash, never returned to callers
  const { results } = await env.DB.prepare(
    `SELECT id, terminal_type, computer_label, treasury_key, created_by, last_used_at, expires_at, created_at
     FROM banking_cc_tokens ORDER BY created_at DESC`  ).all();
  return results;
}

// ---------- newspapers ----------

export async function listPublishedNewspapers(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM newspapers WHERE status = 'published' ORDER BY published_at DESC"
  ).all();
  return results;
}

export async function listAllNewspapers(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, slug, title, author, status, created_at, published_at FROM newspapers ORDER BY created_at DESC'
  ).all();
  return results;
}

export async function findNewspaperById(env, id) {
  return env.DB.prepare('SELECT * FROM newspapers WHERE id = ?').bind(Number(id)).first();
}

export async function findNewspaperBySlug(env, slug) {
  return env.DB.prepare('SELECT * FROM newspapers WHERE slug = ?').bind(slug).first();
}

export async function insertNewspaper(env, { slug, title, author, layoutJson }) {
  const now = nowIso();
  try {
    const result = await env.DB.prepare(
      'INSERT INTO newspapers (slug, title, author, status, layout_json, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
    ).bind(slug, title, author, 'draft', layoutJson, now, now).run();
    return findNewspaperById(env, result.meta.last_row_id);
  } catch (err) {
    if (String(err && err.message || '').toUpperCase().includes('UNIQUE')) {
      const e = new Error('A newspaper with that slug already exists.');
      e.code = 'DUPLICATE';
      throw e;
    }
    throw err;
  }
}

export async function updateNewspaper(env, id, fields) {
  const sets = [];
  const binds = [];
  if (fields.title !== undefined)      { sets.push('title = ?');      binds.push(fields.title); }
  if (fields.layoutJson !== undefined) { sets.push('layout_json = ?'); binds.push(fields.layoutJson); }
  if (fields.status !== undefined)     { sets.push('status = ?');      binds.push(fields.status); }
  if (fields.published_at !== undefined) { sets.push('published_at = ?'); binds.push(fields.published_at); }
  sets.push('updated_at = ?');
  binds.push(nowIso(), Number(id));
  await env.DB.prepare(`UPDATE newspapers SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findNewspaperById(env, id);
}

export async function deleteNewspaperById(env, id) {
  await env.DB.prepare('DELETE FROM newspapers WHERE id = ?').bind(Number(id)).run();
}

// ---------- ballistics: static cannons ----------

export async function findCannonById(env, id) {
  return env.DB.prepare('SELECT * FROM ballistics_cannons WHERE id = ?').bind(Number(id)).first();
}

export async function findCannonByComputerId(env, computerId) {
  return env.DB.prepare('SELECT * FROM ballistics_cannons WHERE computer_id = ?').bind(String(computerId)).first();
}

// First ping from an unknown computer → a 'pending' registration request.
export async function insertCannon(env, { computerId, name, x, y, z, length, facing, sublevel, message, shipYaw }) {
  const now = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO ballistics_cannons
       (computer_id, name, x, y, z, length, facing, sublevel, message, ship_yaw, status,
        last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).bind(computerId, String(name || '').slice(0, 80), x, y, z, length, facing, sublevel ? 1 : 0, message,
         shipYaw == null ? null : Number(shipYaw), now, now, now).run();
  return findCannonById(env, result.meta.last_row_id);
}

// Refresh a cannon's registration fields on a ping. Used while a request is
// still pending, and for sublevel (mobile) cannons on every ping so their
// GPS coordinates keep the map dot moving even after acceptance.
export async function refreshCannonFromComputer(env, id, { name, x, y, z, length, facing, sublevel, message, shipYaw }) {
  const sets = ['x = ?', 'y = ?', 'z = ?', 'length = ?', 'facing = ?', 'sublevel = ?', 'message = ?',
                'ship_yaw = ?', 'last_seen_at = ?', 'updated_at = ?'];
  const binds = [x, y, z, length, facing, sublevel ? 1 : 0, message,
                 shipYaw == null ? null : Number(shipYaw), nowIso(), nowIso()];
  // A name is only ever taken from a computer while its request is still
  // pending — after that the website owns the name, so an officer's rename is
  // never overwritten by the next ping. The caller decides whether to pass it.
  if (name !== undefined) { sets.push('name = ?'); binds.push(String(name || '').slice(0, 80)); }
  binds.push(Number(id));
  await env.DB.prepare(`UPDATE ballistics_cannons SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findCannonById(env, id);
}

// Heartbeat for any cannon (pending or active): refresh last_seen + aim state,
// plus the two things the cannon reports on every poll but that are not worth a
// query of their own — its reload mechanism (0020) and its GPS network health
// snapshot (0015).
//
// Both are appended to the heartbeat's single UPDATE rather than being written
// separately, which is what keeps a cannon's write volume flat as the network
// grows: one statement per poll, with or without these. Each group is dropped,
// newest first, if its migration is outstanding — a missing column must never
// cost the heartbeat itself.
export async function heartbeatCannon(env, id, { yaw, pitch, reloadType, reloadTime, gpsReport } = {}) {
  const now = nowIso();
  const base = ['last_seen_at = ?', 'last_yaw = ?', 'last_pitch = ?', 'updated_at = ?'];
  const values = [now, Number(yaw) || 0, Number(pitch) || 0, now];
  const write = async (extra) => env.DB.prepare(
    `UPDATE ballistics_cannons SET ${base.concat(extra.sets).join(', ')} WHERE id = ?`
  ).bind(...values.concat(extra.binds, Number(id))).run();

  const profile = reloadProfileColumns(reloadType, reloadTime);
  const gps = gpsReportColumns(gpsReport);
  const full = { sets: [...profile.sets, ...gps.sets], binds: [...profile.binds, ...gps.binds] };

  try {
    await write(full);
  } catch (err) {
    if (!full.sets.length) throw err;
    try {
      await write(profile);
    } catch (inner) {
      if (!profile.sets.length) throw inner;
      await write({ sets: [], binds: [] });
    }
  }
  return findCannonById(env, id);
}

export async function listCannons(env) {
  const { results } = await env.DB.prepare('SELECT * FROM ballistics_cannons ORDER BY id ASC').all();
  return results;
}

// Default names are "Cannon 1", "Cannon 2", … — pick the next free number by
// scanning the highest existing default number (renames and deletes don't matter).
export async function nextCannonName(env) {
  const { results } = await env.DB.prepare('SELECT name FROM ballistics_cannons').all();
  let max = 0;
  for (const row of results || []) {
    const m = String(row.name || '').match(/^Cannon\s+(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'Cannon ' + (max + 1);
}

// Names are not unique in the schema — an officer may rename a cannon to
// anything, duplicates included. This is only used to decide whether a name a
// computer proposed can be honoured or whether it must fall back to a default.
async function cannonNameIsFree(env, name, exceptId) {
  const row = await env.DB.prepare('SELECT id FROM ballistics_cannons WHERE name = ? AND id != ? LIMIT 1')
    .bind(String(name), Number(exceptId)).first();
  return !row;
}

// Accepting a request keeps the name the computer proposed when it registered
// — the cannon naming itself — unless it proposed nothing or the name is
// already in use, in which case it takes the next free default.
export async function acceptCannon(env, id) {
  const cannon = await findCannonById(env, id);
  if (!cannon || cannon.status !== 'pending') return null;
  const proposed = String(cannon.name || '').trim();
  const name = (proposed && await cannonNameIsFree(env, proposed, id))
    ? proposed
    : await nextCannonName(env);
  await env.DB.prepare(
    `UPDATE ballistics_cannons SET status = 'active', name = ?, updated_at = ? WHERE id = ?`
  ).bind(name, nowIso(), Number(id)).run();
  return findCannonById(env, id);
}

// Website-side edit (name / coords / length / facing / sublevel / charges).
// `charges` is the gun's own powder count and lands in migration 0021; a cannon
// whose database predates it keeps every other edit rather than failing whole.
export async function updateCannon(env, id, fields) {
  const run = async (withCharges, withHidden) => {
    const sets = [];
    const binds = [];
    if (fields.name !== undefined)     { sets.push('name = ?');     binds.push(String(fields.name).slice(0, 80)); }
    if (fields.x !== undefined)        { sets.push('x = ?');        binds.push(Number(fields.x) || 0); }
    if (fields.y !== undefined)        { sets.push('y = ?');        binds.push(Number(fields.y) || 0); }
    if (fields.z !== undefined)        { sets.push('z = ?');        binds.push(Number(fields.z) || 0); }
    if (fields.length !== undefined)   { sets.push('length = ?');   binds.push(Math.max(1, Math.min(64, Math.round(Number(fields.length) || 4)))); }
    if (fields.facing !== undefined)   { sets.push('facing = ?');   binds.push(Number(fields.facing) || 0); }
    if (fields.sublevel !== undefined) { sets.push('sublevel = ?'); binds.push(fields.sublevel ? 1 : 0); }
    if (withCharges)                   { sets.push('charges = ?');  binds.push(clampCharges(fields.charges)); }
    if (withHidden)                    { sets.push('hidden = ?');   binds.push(fields.hidden ? 1 : 0); }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    binds.push(nowIso(), Number(id));
    await env.DB.prepare(`UPDATE ballistics_cannons SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  };
  // `charges` (0021) and `hidden` (0023) are each a column of their own, and an
  // unapplied migration must cost only that field, never the rest of the edit —
  // renaming a cannon on a database that predates 0023 still has to work. So each
  // optional column is dropped, newest first, and the write is retried.
  let withCharges = fields.charges !== undefined;
  let withHidden  = fields.hidden  !== undefined;
  for (;;) {
    try {
      await run(withCharges, withHidden);
      break;
    } catch (err) {
      if (withHidden) {
        withHidden = false;
        console.warn('Cannon hidden flag unavailable (run migration 0023?) — keeping the other edits.', err);
        continue;
      }
      if (withCharges) {
        withCharges = false;
        console.warn('Cannon charges unavailable (run migration 0021?) — keeping the other edits.', err);
        continue;
      }
      throw err;
    }
  }
  return findCannonById(env, id);
}

// A powder count is a small positive whole number. 99 is a ceiling, not a
// suggestion: it exists so a nonsense value cannot become a muzzle velocity of
// a thousand blocks a tick and hang the solver.
function clampCharges(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CHARGES;
  return Math.max(1, Math.min(99, n));
}

// What a gun is fired with when nothing on record says otherwise — the value
// the old page-wide slider started at.
export const DEFAULT_CHARGES = 3;

export async function deleteCannon(env, id) {
  await env.DB.prepare('DELETE FROM ballistics_cannons WHERE id = ?').bind(Number(id)).run();
}

export async function dispatchCannonFire(env, id, { yaw, pitch }) {
  const cannon = await findCannonById(env, id);
  if (!cannon || cannon.status !== 'active') return null;
  const next = (Number(cannon.command_sequence) || 0) + 1;
  await env.DB.prepare(
    `UPDATE ballistics_cannons
        SET command_sequence = ?, command_yaw = ?, command_pitch = ?, command_fire = 1,
            command_at = ?, updated_at = ?
      WHERE id = ?`
  ).bind(next, Number(yaw), Number(pitch), nowIso(), nowIso(), Number(id)).run();
  return findCannonById(env, id);
}

// A cannon reports the last sequence it executed on every poll, so the same ack
// arrives over and over. It is only worth doing anything when the ack is new:
// close the plan shot that sequence was handed out as, then hand the gun its
// NEXT shot within this same request, so a burst has no idle poll between
// shots. Returns the refreshed cannon (with any newly promoted command on it).
// `firedAt` is the instant the cannon says it actually fired, in epoch ms. It
// arrives on the poll AFTER the ack, because the ack means "I have claimed this
// sequence" and the firing happens several seconds into it — so this is stamped
// on a later poll of the same sequence, and only once. It is a display value:
// an implausible clock is ignored rather than trusted.
//
// `reloadMs` rides along with it — the cannon's own answer to "how long after
// that instant will I be loaded again", or 0 when it left itself unloaded — and
// is stamped in the same statement so a shot can never end up with a fire time
// and a reload window that came from different reports.
//
// 0 and "never reported" are deliberately different values: 0 is a cannon saying
// it stayed unloaded, and null is a cannon that did not say anything (an older
// installer), which the map reports as unknown rather than as unloaded.
export async function recordShotFiredAt(env, cannonId, sequence, firedAt, reloadMs) {
  const ms = Number(firedAt);
  if (!Number.isFinite(ms) || ms <= 0) return;
  // Within two minutes of our own clock, or it is not a time we can use.
  if (Math.abs(Date.now() - ms) > 120000) return;
  const reload = reloadMs == null ? NaN : Number(reloadMs);
  try {
    await env.DB.prepare(
      `UPDATE ballistics_fire_queue SET fired_at = ?, reload_ms = ?
        WHERE cannon_id = ? AND sequence = ? AND fired_at IS NULL`
    ).bind(new Date(ms).toISOString(),
           Number.isFinite(reload) ? Math.max(0, Math.round(reload)) : null,
           Number(cannonId), Number(sequence)).run();
  } catch (err) {
    // 0020 not applied: record the fire time alone (the map still draws its
    // shells), or 0019 not applied either and there is nothing to record.
    try {
      await env.DB.prepare(
        `UPDATE ballistics_fire_queue SET fired_at = ?
          WHERE cannon_id = ? AND sequence = ? AND fired_at IS NULL`
      ).bind(new Date(ms).toISOString(), Number(cannonId), Number(sequence)).run();
    } catch (inner) {
      console.warn('Could not record the fire time (run migration 0019?)', inner);
    }
  }
}

// A cannon's reload mechanism, as extra columns on a write that is happening
// anyway. It is reported on every poll, so giving it a statement of its own
// would double a cannon's writes for a display label — and the GPS side of this
// system is careful about exactly that. `reload_type`/`reload_time` are simply
// appended to the caller's SET list, and if 0020 is not applied the columns do
// not exist, so the caller retries without them rather than losing the write.
//
// Returns the extra SET fragments and bind values, or empty arrays when there is
// no profile to store.
function reloadProfileColumns(reloadType, reloadTime) {
  const sets = [];
  const binds = [];
  const kind = reloadType === 'arm' || reloadType === 'autoloader' ? reloadType : null;
  const time = Number(reloadTime);
  if (kind) { sets.push('reload_type = ?'); binds.push(kind); }
  if (Number.isFinite(time) && time >= 0) { sets.push('reload_time = ?'); binds.push(time); }
  return { sets, binds };
}

export async function ackCannonCommand(env, id, sequence, firedAt, reloadMs) {
  const seq = Number(sequence) || 0;
  const before = await findCannonById(env, id);
  if (!before) return null;

  await recordShotFiredAt(env, id, seq, firedAt, reloadMs);

  if (seq <= Number(before.acked_sequence || 0)) return before;

  await env.DB.prepare(
    `UPDATE ballistics_cannons SET acked_sequence = MAX(acked_sequence, ?), updated_at = ? WHERE id = ?`
  ).bind(seq, nowIso(), Number(id)).run();

  try {
    await env.DB.prepare(
      `UPDATE ballistics_fire_queue SET state = 'done', done_at = ?
        WHERE cannon_id = ? AND sequence = ? AND state = 'delivered'`
    ).bind(nowIso(), Number(id), seq).run();
  } catch (err) {
    console.warn('Ack: fire queue unavailable (run migration 0018?)', err);
    return findCannonById(env, id);
  }
  return promoteQueuedShot(env, id);
}

// How recently a cannon must have checked in for a queued shot to be handed to
// it. Matches the page's own "online" window, so a gun the operator can see as
// offline never fires a shot that was aimed before it went quiet.
const PROMOTE_FRESH_MS = 30000;

function planGunIds(gunsJson) {
  try {
    const guns = JSON.parse(gunsJson || '[]');
    return Array.isArray(guns) ? guns.map((g) => Number(g && g.cannonId)).filter(Boolean) : [];
  } catch { return []; }
}

// ---------- ballistics: fire plans (bombardment modes) ----------

// A plan is one ordered firing order — Normal, Constant or Multi-Target — and
// its queue is the individual shots it is made of. The queue lives server-side
// rather than in the cannon's single command slot because a cannon only acks a
// sequence after it has fired it, so the next shot must be ready the instant
// that ack lands. That keeps a multi-gun sequence synchronous without the
// operator's page having to take part between shots, and it keeps a plan
// draining if the page is closed.
//
// Shots are appended by the operator's page (which is the only place the
// ballistics solver lives) and handed out one at a time by promoteQueuedShot.

export async function insertFirePlan(env, { mode, cycles, targets, guns, crew, drag, charges, trajectory, unsynced }) {
  const now = nowIso();
  const values = [
    mode, Math.max(1, Math.min(999, Math.round(Number(cycles) || 1))),
    JSON.stringify(targets || []), JSON.stringify(guns || []),
    crew == null ? null : String(crew).slice(0, 80),
    // The launch parameters the shots were worked out with. Stored so the map
    // can replay the flight — its shape and its duration — from the plan alone,
    // and so a second officer's sliders cannot misrepresent what was fired.
    //
    // Guarded against null before the conversion: Number(null) is 0, which is a
    // number, so an absent value would otherwise be stored as a real zero — and
    // a drag of zero is a shell that stops dead at the muzzle.
    drag == null ? null : (Number.isFinite(Number(drag)) ? Number(drag) : null),
    charges == null ? null : (Number.isFinite(Number(charges)) ? Math.round(Number(charges)) : null),
    trajectory == null ? null : String(trajectory).slice(0, 16),
    now, now,
  ];
  const insert = (withUnsynced) => env.DB.prepare(
    withUnsynced
      ? `INSERT INTO ballistics_fire_plans
           (mode, state, cycles, targets, guns, crew, drag, charges, trajectory, unsynced, created_at, updated_at)
         VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO ballistics_fire_plans
           (mode, state, cycles, targets, guns, crew, drag, charges, trajectory, created_at, updated_at)
         VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  // `values` is mode, cycles, targets, guns, crew, drag, charges, trajectory,
  // created_at, updated_at. The unsynced variant puts the flag between
  // trajectory and the two timestamps, so the split is after trajectory (index
  // 7) — take the first eight, insert the flag, then the two `now`s. Getting
  // this split wrong is silent and nasty: the flag lands on `created_at` and the
  // timestamp on `unsynced`, which D1 rejects as a type mismatch.
  ).bind(...(withUnsynced
    ? values.slice(0, 8).concat(unsynced ? 1 : 0, values.slice(8))
    : values));

  let result;
  try {
    // .run(), not just awaiting the bound statement: a D1PreparedStatement is
    // not thenable, so awaiting it hands back the statement itself and every
    // column below reads `undefined`. The statement has to be executed.
    result = await insert(true).run();
  } catch (err) {
    // 0024 not applied: the share/every-gun choice cannot be recorded, so the
    // order falls back to the shared queue this page has always used.
    console.warn('Fire plan unsynced flag unavailable (run migration 0024?) — the queue stays shared.', err);
    result = await insert(false).run();
  }
  return findFirePlanById(env, result.meta.last_row_id);
}

export async function findFirePlanById(env, id) {
  return env.DB.prepare('SELECT * FROM ballistics_fire_plans WHERE id = ?').bind(Number(id)).first();
}

// Plans that are still live, newest first — how a page that was reloaded
// mid-barrage finds the order it was running.
//
// An order opened by a scheduled attack is deliberately NOT in this list. This
// is what resumeBombardment() adopts, and a page must not adopt a barrage the
// Worker is feeding: the page would apply its own completion rule to it, and its
// rule reads a deep server-side queue as "every gun has finished" — which would
// close a scheduled attack the moment an officer happened to open the
// calculator. Officers watch those from the Secret Panel instead.
export async function listActiveFirePlans(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT p.* FROM ballistics_fire_plans p
        WHERE p.state IN ('running', 'paused')
          AND NOT EXISTS (
            SELECT 1 FROM ballistics_attack_plans a
             WHERE a.fire_plan_id = p.id AND a.state = 'running')
        ORDER BY p.id DESC LIMIT 20`
    ).all();
    return results;
  } catch (err) {
    // 0024 not applied: nothing is scheduled, so every live order is adoptable.
    console.warn('Scheduled attack plans unavailable (run migration 0024?) — listing every live order.', err);
    const { results } = await env.DB.prepare(
      "SELECT * FROM ballistics_fire_plans WHERE state IN ('running', 'paused') ORDER BY id DESC LIMIT 20"
    ).all();
    return results;
  }
}

// The missing-column warning is worth saying once per worker, not once per shot.
let warnedShotCharges = false;

// Queue a batch of shots, then hand one to every gun that is idle right now.
// The sweep at the end is what makes a fresh plan start immediately instead of
// waiting for the gun's next poll to notice its queue is no longer empty.
export async function appendPlanShots(env, planId, shots) {
  const now = nowIso();
  const ids = [];
  for (const shot of shots) {
    // The count the shot was SOLVED with, recorded on the shot itself: one order
    // can fire guns loaded with different amounts of powder, and the map replays
    // each flight from this number. A missing column (0021 not applied yet) costs
    // one retry and then heals: the outcome is never cached, because caching it
    // would keep leaving the count out of every later shot in that worker's life.
    const charges = clampCharges(shot.charges);
    const withCharges = shot.charges !== undefined;
    const insert = (withCol) => env.DB.prepare(
      withCol
        ? `INSERT INTO ballistics_fire_queue
             (plan_id, cannon_id, yaw, pitch, target_key, charges, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
        : `INSERT INTO ballistics_fire_queue
             (plan_id, cannon_id, yaw, pitch, target_key, state, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(
      ...(withCol
        ? [Number(planId), Number(shot.cannonId), Number(shot.yaw), Number(shot.pitch),
           shot.targetKey == null ? null : String(shot.targetKey).slice(0, 48), charges, now]
        : [Number(planId), Number(shot.cannonId), Number(shot.yaw), Number(shot.pitch),
           shot.targetKey == null ? null : String(shot.targetKey).slice(0, 48), now])
    );
    let result;
    try {
      result = await insert(withCharges).run();
    } catch (err) {
      if (!withCharges) throw err;
      if (!warnedShotCharges) {
        warnedShotCharges = true;
        console.warn('Shot charges unavailable (run migration 0021?) — the order\'s own value stands in.', err);
      }
      result = await insert(false).run();
    }
    ids.push(result.meta.last_row_id);
  }
  // Feeding an order counts as activity on it. This is what the history sweep
  // reads to tell a live barrage apart from one whose operator closed the page:
  // shots arriving keep the plan fresh even while every shot is in flight.
  await env.DB.prepare('UPDATE ballistics_fire_plans SET updated_at = ? WHERE id = ?')
    .bind(now, Number(planId)).run();

  for (const cannonId of new Set(shots.map((s) => Number(s.cannonId)))) {
    await promoteQueuedShot(env, cannonId);
  }
  return ids;
}

// Hand a cannon the next shot of its queue, if it is idle and the plan is
// running. `burst` and `more` are decided here rather than by the caller:
//  • burst  — a shot in a multi-shot run (Constant / Multi-Target). A cannon in
//             one of those modes must not repeat its full disassemble/assemble
//             cycle between shots when a mechanical arm only needs its reload.
//  • more   — another shot for this gun is already queued, so the cannon is left
//             assembled at the end of this one. Derived from the queue itself,
//             which is the only authoritative answer at hand-out time.
export async function promoteQueuedShot(env, cannonId) {
  const cannon = await findCannonById(env, cannonId);
  if (!cannon || cannon.status !== 'active') return cannon;
  // Still firing the shot it already has.
  if (Number(cannon.acked_sequence) < Number(cannon.command_sequence)) return cannon;
  // And only hand a shot to a gun that is actually there. A stale aim fired on
  // reconnect is worse than a missed one — a moving ship's coordinates have
  // moved on — so a cannon that has not checked in recently is left waiting
  // until its next poll.
  const seen = Date.parse(cannon.last_seen_at || '');
  if (!Number.isFinite(seen) || Date.now() - seen > PROMOTE_FRESH_MS) return cannon;

  let row, next;
  try {
    row = await env.DB.prepare(
      `SELECT q.id, q.plan_id, q.yaw, q.pitch, p.mode
         FROM ballistics_fire_queue q
         JOIN ballistics_fire_plans p ON p.id = q.plan_id
        WHERE q.cannon_id = ? AND q.state = 'pending' AND p.state = 'running'
        ORDER BY q.id ASC LIMIT 1`
    ).bind(Number(cannonId)).first();
    if (!row) return cannon;
    next = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM ballistics_fire_queue
        WHERE cannon_id = ? AND plan_id = ? AND state = 'pending' AND id > ?`
    ).bind(Number(cannonId), row.plan_id, row.id).first();
  } catch (err) {
    console.warn('Fire queue unavailable (run migration 0018?)', err);
    return cannon;
  }

  const more = (next && Number(next.c) > 0) ? 1 : 0;
  const burst = row.mode === 'normal' ? 0 : 1;
  const seq = (Number(cannon.command_sequence) || 0) + 1;
  const now = nowIso();

  const claimed = await env.DB.prepare(
    `UPDATE ballistics_fire_queue
        SET state = 'delivered', burst = ?, more = ?, sequence = ?, delivered_at = ?
      WHERE id = ? AND state = 'pending'`
  ).bind(burst, more, seq, now, row.id).run();
  // Someone else claimed it between the SELECT and the UPDATE — they will have
  // written the command, so leave this poll alone rather than double-assign.
  if (claimed.meta && Number(claimed.meta.changes) === 0) return findCannonById(env, cannonId);

  await env.DB.prepare(
    `UPDATE ballistics_cannons
        SET command_sequence = ?, command_yaw = ?, command_pitch = ?, command_fire = 1,
            command_at = ?, updated_at = ?
      WHERE id = ?`
  ).bind(seq, Number(row.yaw), Number(row.pitch), now, now, Number(cannonId)).run();
  return findCannonById(env, cannonId);
}

// Pause holds the rest of the queue where it is; the plan state alone stops
// promoteQueuedShot handing any of it out, and the shot a gun is already
// holding still finishes.
//
// Stop is the hard one: a shot that has been handed to a gun but not yet acked
// is withdrawn from the cannon as well, so a tube that is offline this minute
// does not fire the moment it reconnects.
export async function setFirePlanState(env, id, state) {
  const now = nowIso();
  const plan = await findFirePlanById(env, id);
  if (!plan) return null;
  await env.DB.prepare('UPDATE ballistics_fire_plans SET state = ?, updated_at = ? WHERE id = ?')
    .bind(state, now, Number(id)).run();

  // Resuming sweeps the queue: any shot that was appended while the order was
  // paused is still waiting, and an idle gun would otherwise not be offered one
  // until it acked something new — which it never will.
  if (state === 'running') {
    for (const cannonId of planGunIds(plan.guns)) await promoteQueuedShot(env, cannonId);
    return findFirePlanById(env, id);
  }

  if (state === 'stopped' || state === 'done') {
    const { results } = await env.DB.prepare(
      "SELECT id, cannon_id, sequence FROM ballistics_fire_queue WHERE plan_id = ? AND state = 'delivered'"
    ).bind(Number(id)).all();
    await env.DB.prepare(
      "UPDATE ballistics_fire_queue SET state = 'cancelled' WHERE plan_id = ? AND state = 'pending'"
    ).bind(Number(id)).run();

    for (const row of results || []) {
      const c = await findCannonById(env, row.cannon_id);
      if (!c) continue;
      if (Number(c.command_sequence) !== Number(row.sequence)) continue;
      if (Number(c.acked_sequence) >= Number(row.sequence)) continue;  // already fired it
      await env.DB.prepare(
        `UPDATE ballistics_cannons
            SET command_sequence = acked_sequence, command_fire = 0, updated_at = ?
          WHERE id = ?`
      ).bind(now, Number(c.id)).run();
      await env.DB.prepare(
        `UPDATE ballistics_fire_queue SET state = 'cancelled' WHERE id = ?`
      ).bind(Number(row.id)).run();
    }
  }
  return findFirePlanById(env, id);
}

// The shot a cannon is currently holding, so the CC bridge can tell the cannon
// whether it belongs to a multi-shot run (and whether another shot follows)
// without those plan fields having to live on the cannon row itself.
export async function findDeliveredShot(env, cannonId, sequence) {
  try {
    return await env.DB.prepare(
      `SELECT burst, more, target_key FROM ballistics_fire_queue
        WHERE cannon_id = ? AND sequence = ? AND state = 'delivered'`
    ).bind(Number(cannonId), Number(sequence)).first();
  } catch (err) {
    return null;   // 0018 not applied yet: no plan shots exist
  }
}

// Same, for every gun of one vehicle in a single query.
export async function listDeliveredShotsForVehicle(env, vehicleId) {
  const out = {};
  try {
    const { results } = await env.DB.prepare(
      `SELECT q.cannon_id, q.burst, q.more, q.target_key
         FROM ballistics_fire_queue q
         JOIN ballistics_cannons c ON c.id = q.cannon_id
        WHERE c.vehicle_id = ? AND q.state = 'delivered'`
    ).bind(Number(vehicleId)).all();
    for (const row of results || []) out[Number(row.cannon_id)] = row;
  } catch (err) {
    // 0018 not applied yet: ships simply fire whole cycles as before.
  }
  return out;
}

// The shot each gun of a plan is on, and the one it fired most recently — what
// the live map draws.
//
// Only two rows per gun, never the whole queue: a barrage can be thousands of
// shots long and the map only ever cares about the shot in hand and the shell
// still in the air. Both are the newest rows for that gun, so this stays a small
// bounded read however long the order runs.
//
// `firedAt` is absent until migration 0019 is applied; the map falls back to the
// ack time and reports the timing as estimated. `reloadMs` arrives with it (0020)
// and drives the per-gun reload ring — the rows come back with whatever columns
// exist rather than failing, so an unapplied migration just means no ring.
export async function listPlanCurrentShots(env, planId) {
  const out = {};
  const id = Number(planId);
  const lastOfGun = `FROM ballistics_fire_queue q
                       JOIN (SELECT cannon_id, MAX(id) AS id FROM ballistics_fire_queue
                              WHERE plan_id = ? AND state = 'done' GROUP BY cannon_id) m
                         ON m.id = q.id`;
  const baseCols = 'q.cannon_id, q.sequence, q.yaw, q.pitch, q.target_key, q.done_at';

  // Each column arrived in its own migration, so the query is tried richest
  // first and falls back one column at a time. A missing column reads as NULL,
  // which every consumer already treats as "not reported".
  const pick = async (variants) => {
    for (const sql of variants) {
      try { return await env.DB.prepare(sql).bind(id).all(); }
      catch (err) { /* try the next, poorer, shape */ }
    }
    return null;
  };
  const shotCols = ['q.charges', 'NULL AS charges'];
  const lastCols = [];
  for (const fired of ['q.fired_at', 'NULL AS fired_at']) {
    for (const reload of ['q.reload_ms', 'NULL AS reload_ms']) {
      for (const charges of shotCols) {
        lastCols.push(`SELECT ${baseCols}, ${fired}, ${reload}, ${charges} ${lastOfGun}`);
      }
    }
  }

  const bucket = (cannonId) => {
    const key = String(cannonId);
    if (!out[key]) out[key] = { delivered: null, last: null };
    return out[key];
  };

  try {
    const delivered = await pick([
      `SELECT cannon_id, sequence, yaw, pitch, target_key, charges
         FROM ballistics_fire_queue WHERE plan_id = ? AND state = 'delivered'`,
      `SELECT cannon_id, sequence, yaw, pitch, target_key, NULL AS charges
         FROM ballistics_fire_queue WHERE plan_id = ? AND state = 'delivered'`,
    ]);
    for (const row of (delivered && delivered.results) || []) {
      bucket(row.cannon_id).delivered = {
        sequence: Number(row.sequence),
        yaw: Number(row.yaw),
        pitch: Number(row.pitch),
        targetKey: row.target_key == null ? null : String(row.target_key),
        charges: row.charges == null ? null : Number(row.charges),
      };
    }

    const last = await pick(lastCols);
    for (const row of (last && last.results) || []) {
      bucket(row.cannon_id).last = {
        sequence: Number(row.sequence),
        yaw: Number(row.yaw),
        pitch: Number(row.pitch),
        targetKey: row.target_key == null ? null : String(row.target_key),
        firedAt: row.fired_at || null,
        doneAt: row.done_at || null,
        // 0 means the cannon left itself unloaded, null that it never said.
        reloadMs: row.reload_ms == null ? null : Number(row.reload_ms),
        // The powder count the shot was solved with; null on a shot queued
        // before 0021, which falls back to the order's own value.
        charges: row.charges == null ? null : Number(row.charges),
      };
    }
  } catch (err) {
    console.warn('Could not read plan shots (run migration 0018?)', err);
  }
  return out;
}

// What the operator's page needs to keep the guns fed and to show progress:
// per gun how much is still waiting, and per target how many shots it has
// already been given. A cancelled shot does not count towards a target, so a
// stopped run reports the truth about what was actually fired.
export async function firePlanProgress(env, planId) {
  const guns = {};
  const targets = {};
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT cannon_id, state, target_key, COUNT(*) AS n
         FROM ballistics_fire_queue WHERE plan_id = ?
        GROUP BY cannon_id, state, target_key`
    ).bind(Number(planId)).all();
    rows = res.results || [];
  } catch (err) {
    console.warn('Fire queue unavailable (run migration 0018?)', err);
    return { guns, targets };
  }
  for (const row of rows) {
    const id = String(row.cannon_id);
    const n = Number(row.n) || 0;
    guns[id] = guns[id] || { pending: 0, delivered: 0, done: 0 };
    if (row.state === 'pending') guns[id].pending += n;
    else if (row.state === 'delivered') guns[id].delivered += n;
    else if (row.state === 'done') guns[id].done += n;
    if (row.state !== 'cancelled' && row.target_key != null) {
      const key = String(row.target_key);
      targets[key] = (targets[key] || 0) + n;
    }
  }
  return { guns, targets };
}

// An order that is never formally closed — an operator closes the tab on a
// Constant run instead of pressing Stop — would otherwise stay 'running' for
// ever. That is worse than untidy: it never reaches the log below, and because
// resumeBombardment() reattaches to the newest live order, the operator's next
// page load would pick up a barrage nobody is firing.
//
// So an order is treated as abandoned when it is running, has nothing queued or
// in flight, and has not been fed for this long. Paused orders are deliberately
// left alone: pausing was a click, and the operator is still holding the order.
// `updated_at` is left untouched, so the log shows when it was last active
// rather than when the sweep happened to notice.
//
// The window is a deployment choice rather than a law of the system — half an
// hour of silence is abandoned, five minutes might not be — so it can be set
// with a FIRE_PLAN_STALE_MS var and defaults to 30 minutes.
const DEFAULT_STALE_PLAN_MS = 30 * 60 * 1000;

function stalePlanMs(env) {
  const n = Number(env && env.FIRE_PLAN_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_PLAN_MS;
}

export async function sweepStaleFirePlans(env) {
  const cutoff = new Date(Date.now() - stalePlanMs(env)).toISOString();
  try {
    const { results } = await env.DB.prepare(
      `SELECT p.id FROM ballistics_fire_plans p
        WHERE p.state = 'running' AND p.updated_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM ballistics_fire_queue q
             WHERE q.plan_id = p.id AND q.state IN ('pending', 'delivered'))`
    ).bind(cutoff).all();
    for (const row of results || []) {
      await env.DB.prepare("UPDATE ballistics_fire_plans SET state = 'done' WHERE id = ?")
        .bind(Number(row.id)).run();
    }
    return (results || []).length;
  } catch (err) {
    console.warn('Could not sweep stale fire plans (run migration 0018?)', err);
    return 0;
  }
}

function parseJsonList(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Every firing order that has ended, newest first, with what it actually fired.
//
// "What was fired" is the queue, not the request: a shot only counts once the
// cannon acked it ('done'). A Stop withdraws shots that were handed out but
// never acked, and those are reported as withdrawn instead — so a stopped
// barrage cannot appear to have fired rounds it never did.
//
// Names come from each order's own snapshot, which is what was true when it was
// fired for; a cannon renamed since does not rewrite history.
export async function listFirePlanHistory(env, limit) {
  const cap = Math.max(1, Math.min(200, Math.round(Number(limit) || 50)));
  let plans = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM ballistics_fire_plans WHERE state IN ('stopped', 'done') ORDER BY id DESC LIMIT ?"
    ).bind(cap).all();
    plans = results || [];
  } catch (err) {
    console.warn('Fire plan history unavailable (run migration 0018?)', err);
    return [];
  }
  if (!plans.length) return [];

  const ids = plans.map((p) => Number(p.id));
  let rows = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT plan_id, cannon_id, state, target_key, COUNT(*) AS n
         FROM ballistics_fire_queue
        WHERE plan_id IN (${ids.map(() => '?').join(',')})
        GROUP BY plan_id, cannon_id, state, target_key`
    ).bind(...ids).all();
    rows = results || [];
  } catch (err) {
    console.warn('Could not read fired shots (run migration 0018?)', err);
  }

  const tally = new Map();
  const vehicleIds = new Set();
  for (const row of rows) {
    const planId = Number(row.plan_id);
    const gunId = Number(row.cannon_id);
    const n = Number(row.n) || 0;
    if (!tally.has(planId)) tally.set(planId, { guns: new Map(), targets: new Map(), fired: 0, withdrawn: 0 });
    const t = tally.get(planId);
    const gun = t.guns.get(gunId) || { cannonId: gunId, fired: 0, withdrawn: 0 };
    if (row.state === 'done') { gun.fired += n; t.fired += n; }
    else if (row.state === 'cancelled') { gun.withdrawn += n; t.withdrawn += n; }
    t.guns.set(gunId, gun);
    if (row.state === 'done' && row.target_key != null) {
      const key = String(row.target_key);
      t.targets.set(key, (t.targets.get(key) || 0) + n);
    }
  }

  for (const plan of plans) {
    for (const gun of parseJsonList(plan.guns)) {
      if (gun && gun.vehicleId != null) vehicleIds.add(Number(gun.vehicleId));
    }
  }

  // Ship names, so a gun reads as "on Dreadnought" rather than a bare id. The
  // order's snapshot predates a rename, so the current name is the useful one.
  const vehicleNames = new Map();
  if (vehicleIds.size) {
    const list = [...vehicleIds];
    try {
      const { results } = await env.DB.prepare(
        `SELECT id, name FROM ballistics_vehicles WHERE id IN (${list.map(() => '?').join(',')})`
      ).bind(...list).all();
      for (const v of results || []) vehicleNames.set(Number(v.id), v.name || '');
    } catch (err) {
      console.warn('Could not read vehicle names for the firing log', err);
    }
  }

  return plans.map((plan) => {
    const t = tally.get(Number(plan.id)) || { guns: new Map(), targets: new Map(), fired: 0, withdrawn: 0 };
    const targets = parseJsonList(plan.targets);
    const labels = new Map(targets.map((x) => [String(x.key), x.label || String(x.key)]));
    const guns = parseJsonList(plan.guns).map((g) => {
      const gid = Number(g && g.cannonId);
      const gun = t.guns.get(gid) || { fired: 0, withdrawn: 0 };
      const vehicleId = (g && g.vehicleId == null) ? null : Number(g.vehicleId);
      return {
        cannonId: gid,
        name: (g && g.name) || ('Cannon ' + gid),
        vehicleId,
        vehicleName: vehicleId == null ? null : (vehicleNames.get(vehicleId) || null),
        fired: gun.fired,
        withdrawn: gun.withdrawn,
      };
    });
    return {
      id:        Number(plan.id),
      mode:      plan.mode,
      state:     plan.state,
      cycles:    Number(plan.cycles) || 1,
      crew:      plan.crew || null,
      created_at: plan.created_at,
      ended_at:  plan.updated_at,
      targets:   targets.map((x) => ({ key: String(x.key), x: x.x, y: x.y, z: x.z, label: x.label || String(x.key) })),
      guns,
      fired:     t.fired,
      withdrawn: t.withdrawn,
      byTarget:  [...t.targets.entries()].map(([key, n]) => ({ key, label: labels.get(key) || key, fired: n })),
    };
  });
}

// ---------- ballistics: GPS network ----------

// The latest GPS health snapshot from a cannon, as extra columns on a write
// that is already happening.
//
// It is rewritten every poll, so giving it a statement of its own would double
// a cannon's writes for a status line — which is exactly what the GPS side of
// this system is careful not to do. `gps_report` is simply appended to the
// caller's SET list; if migration 0015 is not applied the caller retries
// without it rather than losing the heartbeat.
function gpsReportColumns(report) {
  if (!report || typeof report !== 'object') return { sets: [], binds: [] };
  return { sets: ['gps_report = ?'], binds: [JSON.stringify(report)] };
}

// How long an exclusion stays "recent". The website's warning is driven by
// this window rather than by the lifetime total, because a tower left out of
// ONE fix — however long ago — is not a fault: geometry, a slow tick or a
// single bad measurement can all do that, and a badge that never clears is a
// badge nobody can act on.
const GPS_EXCLUDE_WINDOW = '+10 minutes';

// Upsert the towers a receiver has heard from RECENTLY. Clients only send the
// towers they are still hearing (and only when that list changes, or once a
// minute as a safety net), so this is touched a handful of times rather than
// once a second: a tower that has gone quiet simply stops appearing, its
// last_seen_at stops moving, and it ages off the website's list instead of
// sitting there as a ghost that is forever "heard" and forever blamed.
export async function recordGpsTowers(env, towers, reportedBy, excludedKeys) {
  if (!Array.isArray(towers) || towers.length === 0) return 0;
  const now = nowIso();
  const excluded = new Set((Array.isArray(excludedKeys) ? excludedKeys : []).map(String));
  const seen = new Set();
  const rows = [];

  for (const t of towers.slice(0, 64)) {
    const x = Math.round(Number(t && t.x));
    const y = Math.round(Number(t && t.y));
    const z = Math.round(Number(t && t.z));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const key = `${x},${y},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, x, y, z, excluded: excluded.has(key) ? 1 : 0 });
  }
  if (!rows.length) return 0;

  const by = String(reportedBy || '').slice(0, 64);
  const insert = 'INSERT INTO ballistics_gps_towers '
    + '(tower_key, x, y, z, sightings, excluded_count, reported_by, '
    + ' first_seen_at, last_seen_at, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)';

  // Two forms of the same upsert: the full one keeps the recent window, and a
  // reduced one that still records the sighting if 0022 has not been applied.
  // A cannon's GPS health must never be able to break a poll.
  const build = (withRecent) => env.DB.prepare(
    `${insert}
     ON CONFLICT(tower_key) DO UPDATE SET
       last_seen_at   = excluded.last_seen_at,
       sightings      = sightings + 1,
       excluded_count = excluded_count + excluded.excluded_count,`
    + (withRecent
      ? `
       excluded_at    = CASE WHEN excluded.excluded_count > 0
                             THEN excluded.last_seen_at ELSE excluded_at END,
       excluded_recent = CASE
           WHEN recent_at IS NULL
             OR julianday(excluded.last_seen_at) > julianday(recent_at, '${GPS_EXCLUDE_WINDOW}')
           THEN excluded.excluded_count
           ELSE excluded_recent + excluded.excluded_count END,
       recent_at = CASE
           WHEN recent_at IS NULL
             OR julianday(excluded.last_seen_at) > julianday(recent_at, '${GPS_EXCLUDE_WINDOW}')
           THEN excluded.last_seen_at ELSE recent_at END,`
      : '')
    + `
       reported_by    = excluded.reported_by,
       updated_at     = excluded.updated_at`
  );

  const bind = (stmt, r) => stmt.bind(r.key, r.x, r.y, r.z, r.excluded, by, now, now, now, now);
  const statements = (withRecent) => rows.map((r) => bind(build(withRecent), r));

  try {
    await env.DB.batch(statements(true));
  } catch (err) {
    console.warn('GPS towers: recent-window columns unavailable (run migration 0022?)', err);
    await env.DB.batch(statements(false));
  }
  return rows.length;
}

// Towers that have been heard recently. Anything silent for a month is left
// out: those rows are history, not part of the network, and keeping them on
// the page only makes a working network look broken.
export async function listGpsTowers(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ballistics_gps_towers
      WHERE last_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
      ORDER BY last_seen_at DESC, y DESC, x ASC`
  ).all();
  return results;
}

// ---------- ballistics: reload presets ----------

// Named reload mechanisms saved on the website, so a cannon computer can pull
// the list at setup instead of every operator typing timings at the cannon.
// Solved here, reused at every cannon: see migration 0017.

export async function listReloadPresets(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM ballistics_reload_presets ORDER BY name ASC'
  ).all();
  return results;
}

export async function findReloadPresetById(env, id) {
  return env.DB.prepare('SELECT * FROM ballistics_reload_presets WHERE id = ?').bind(Number(id)).first();
}

// 'between' reloads between disassemble and assemble (the auto-loader's
// placement), 'after' reloads once the cannon is assembled again (the
// mechanical arm's). Coerced here as well as by the table's CHECK so a bad
// value can never reach a cannon.
function presetKind(v) {
  return v === 'after' ? 'after' : 'between';
}

function presetSeconds(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(3600, Math.round(n * 100) / 100);
}

export async function insertReloadPreset(env, { name, kind, reloadTime, pulse, notes }) {
  const now = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO ballistics_reload_presets
       (name, kind, reload_time, pulse, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(String(name).slice(0, 60), presetKind(kind), presetSeconds(reloadTime, 1),
         presetSeconds(pulse, 0.5), String(notes || '').slice(0, 240), now, now).run();
  return findReloadPresetById(env, result.meta.last_row_id);
}

export async function updateReloadPreset(env, id, fields) {
  const sets = [];
  const binds = [];
  if (fields.name !== undefined)       { sets.push('name = ?');        binds.push(String(fields.name).slice(0, 60)); }
  if (fields.kind !== undefined)       { sets.push('kind = ?');        binds.push(presetKind(fields.kind)); }
  if (fields.reloadTime !== undefined) { sets.push('reload_time = ?'); binds.push(presetSeconds(fields.reloadTime, 1)); }
  if (fields.pulse !== undefined)      { sets.push('pulse = ?');       binds.push(presetSeconds(fields.pulse, 0.5)); }
  if (fields.notes !== undefined)      { sets.push('notes = ?');       binds.push(String(fields.notes).slice(0, 240)); }
  if (!sets.length) return findReloadPresetById(env, id);
  sets.push('updated_at = ?');
  binds.push(nowIso(), Number(id));
  await env.DB.prepare(`UPDATE ballistics_reload_presets SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findReloadPresetById(env, id);
}

export async function deleteReloadPreset(env, id) {
  await env.DB.prepare('DELETE FROM ballistics_reload_presets WHERE id = ?').bind(Number(id)).run();
}

// ---------- ballistics: sublevel vehicles ----------

// A vehicle computer coordinates every Sublevel Cannon Computer on one ship.
// It self-registers exactly like a cannon does: first poll creates a 'pending'
// row, and an officer accepts it from the Vehicle Registry tab.

export async function findVehicleById(env, id) {
  return env.DB.prepare('SELECT * FROM ballistics_vehicles WHERE id = ?').bind(Number(id)).first();
}

export async function findVehicleByComputerId(env, computerId) {
  return env.DB.prepare('SELECT * FROM ballistics_vehicles WHERE computer_id = ?').bind(String(computerId)).first();
}

// First ping from an unknown vehicle computer → a 'pending' registration.
export async function insertVehicle(env, { computerId, name, message, shipYaw }) {
  const now = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO ballistics_vehicles
       (computer_id, name, message, status, ship_yaw, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).bind(computerId, String(name || '').slice(0, 80), message, shipYaw == null ? null : Number(shipYaw), now, now, now).run();
  return findVehicleById(env, result.meta.last_row_id);
}

// Every ping refreshes the vehicle's heartbeat, its notes and the ship heading
// it has derived, whatever its status (so a pending vehicle still looks alive).
export async function refreshVehicleFromComputer(env, id, { name, message, shipYaw }) {
  const sets = ['message = ?', 'ship_yaw = ?', 'last_seen_at = ?', 'updated_at = ?'];
  const binds = [message, shipYaw == null ? null : Number(shipYaw), nowIso(), nowIso()];
  // Same rule as a cannon: a proposed name only counts while the request is
  // pending, so an officer's rename survives the next ping.
  if (name !== undefined) { sets.push('name = ?'); binds.push(String(name || '').slice(0, 80)); }
  binds.push(Number(id));
  await env.DB.prepare(`UPDATE ballistics_vehicles SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findVehicleById(env, id);
}

export async function listVehicles(env) {
  const { results } = await env.DB.prepare('SELECT * FROM ballistics_vehicles ORDER BY id ASC').all();
  return results;
}

export async function listCannonsByVehicle(env, vehicleId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM ballistics_cannons WHERE vehicle_id = ? ORDER BY id ASC'
  ).bind(Number(vehicleId)).all();
  return results;
}

// Default names are "Vehicle 1", "Vehicle 2", … — same scheme as cannons.
export async function nextVehicleName(env) {
  const { results } = await env.DB.prepare('SELECT name FROM ballistics_vehicles').all();
  let max = 0;
  for (const row of results || []) {
    const m = String(row.name || '').match(/^Vehicle\s+(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'Vehicle ' + (max + 1);
}

async function vehicleNameIsFree(env, name, exceptId) {
  const row = await env.DB.prepare('SELECT id FROM ballistics_vehicles WHERE name = ? AND id != ? LIMIT 1')
    .bind(String(name), Number(exceptId)).first();
  return !row;
}

// Same as acceptCannon: the vehicle names itself on registration, and the
// officer can rename it afterwards.
export async function acceptVehicle(env, id) {
  const vehicle = await findVehicleById(env, id);
  if (!vehicle || vehicle.status !== 'pending') return null;
  const proposed = String(vehicle.name || '').trim();
  const name = (proposed && await vehicleNameIsFree(env, proposed, id))
    ? proposed
    : await nextVehicleName(env);
  await env.DB.prepare(
    `UPDATE ballistics_vehicles SET status = 'active', name = ?, updated_at = ? WHERE id = ?`
  ).bind(name, nowIso(), Number(id)).run();
  return findVehicleById(env, id);
}

export async function updateVehicle(env, id, fields) {
  const run = async (withHidden) => {
    const sets = [];
    const binds = [];
    if (fields.name !== undefined)    { sets.push('name = ?');    binds.push(String(fields.name).slice(0, 80)); }
    if (fields.message !== undefined) { sets.push('message = ?'); binds.push(String(fields.message).slice(0, 200)); }
    // The secret panel's hide/show toggle. Dropped and retried if 0023 is not
    // applied, so a rename still lands on a database without the column.
    if (withHidden)                   { sets.push('hidden = ?');  binds.push(fields.hidden ? 1 : 0); }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    binds.push(nowIso(), Number(id));
    await env.DB.prepare(`UPDATE ballistics_vehicles SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  };
  try {
    await run(fields.hidden !== undefined);
  } catch (err) {
    if (fields.hidden === undefined) throw err;
    console.warn('Vehicle hidden flag unavailable (run migration 0023?) — keeping the other edits.', err);
    await run(false);
  }
  return findVehicleById(env, id);
}

// Deleting a vehicle releases its cannons rather than removing them: the
// cannons are real hardware and go back to running standalone, with their own
// heading and their own command loop.
export async function deleteVehicle(env, id) {
  await env.DB.batch([
    env.DB.prepare('UPDATE ballistics_cannons SET vehicle_id = NULL, updated_at = ? WHERE vehicle_id = ?')
      .bind(nowIso(), Number(id)),
    env.DB.prepare('DELETE FROM ballistics_vehicles WHERE id = ?').bind(Number(id)),
  ]);
}

// Assign a cannon to a vehicle, or pass null to release it back to standalone.
export async function assignCannonToVehicle(env, cannonId, vehicleId) {
  await env.DB.prepare(
    'UPDATE ballistics_cannons SET vehicle_id = ?, updated_at = ? WHERE id = ?'
  ).bind(vehicleId == null ? null : Number(vehicleId), nowIso(), Number(cannonId)).run();
  return findCannonById(env, cannonId);
}

// Position + aim report for a cannon whose vehicle computer is reporting on its
// behalf. A sublevel cannon that has no GPS fix yet reports the 0 fallback, so
// gpsOk gates the coordinates exactly as it does on the cannon's own poll.
//
// The gun's reload mechanism rides along when the vehicle forwards one (the
// cannon reports it, the vehicle passes it through), appended to this same write
// for the same reason it is appended to the heartbeat.
export async function updateCannonTelemetry(env, id, { x, y, z, gpsOk, yaw, pitch, reloadType, reloadTime } = {}) {
  const now = nowIso();
  const base = gpsOk
    ? ['x = ?', 'y = ?', 'z = ?', 'last_yaw = ?', 'last_pitch = ?', 'last_seen_at = ?', 'updated_at = ?']
    : ['last_yaw = ?', 'last_pitch = ?', 'last_seen_at = ?', 'updated_at = ?'];
  const values = gpsOk
    ? [Number(x) || 0, Number(y) || 0, Number(z) || 0, Number(yaw) || 0, Number(pitch) || 0, now, now]
    : [Number(yaw) || 0, Number(pitch) || 0, now, now];
  const write = async (extra) => env.DB.prepare(
    `UPDATE ballistics_cannons SET ${base.concat(extra.sets).join(', ')} WHERE id = ?`
  ).bind(...values.concat(extra.binds, Number(id))).run();

  const profile = reloadProfileColumns(reloadType, reloadTime);
  try {
    await write(profile);
  } catch (err) {
    // 0020 not applied: the report still has to land.
    if (!profile.sets.length) throw err;
    await write({ sets: [], binds: [] });
  }
  return findCannonById(env, id);
}

// ---------- named targets (ballistics) ----------
//
// A target is a place, given a name so it can be picked off a list instead of
// retyped: the calculator's "select one" dropdown for Normal and Constant, the
// tickbox list that fills the Multi-Target queue, and the scheduled attack plans
// in the secret panel, which have no page to read coordinates from.
//
// `hidden` (0023) takes a target out of every response to a reader without the
// 'ballistics-secret' role. The filtering is done by the routes, which is the
// only layer that knows who is asking; this layer returns whole rows.
export async function listTargets(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM ballistics_targets ORDER BY name COLLATE NOCASE ASC, id ASC'
  ).all();
  return results;
}

export async function findTargetById(env, id) {
  return env.DB.prepare('SELECT * FROM ballistics_targets WHERE id = ?').bind(Number(id)).first();
}

export async function insertTarget(env, { name, x, y, z, hidden, createdBy }) {
  const now = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO ballistics_targets (name, x, y, z, hidden, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    String(name || '').slice(0, 80),
    Number(x) || 0, targetY(y), Number(z) || 0,
    hidden ? 1 : 0,
    createdBy == null ? null : String(createdBy).slice(0, 80),
    now, now
  ).run();
  return findTargetById(env, result.meta.last_row_id);
}

export async function updateTarget(env, id, fields) {
  const sets = [];
  const binds = [];
  if (fields.name !== undefined)   { sets.push('name = ?');   binds.push(String(fields.name).slice(0, 80)); }
  if (fields.x !== undefined)      { sets.push('x = ?');      binds.push(Number(fields.x) || 0); }
  if (fields.y !== undefined)      { sets.push('y = ?');      binds.push(targetY(fields.y)); }
  if (fields.z !== undefined)      { sets.push('z = ?');      binds.push(Number(fields.z) || 0); }
  if (fields.hidden !== undefined) { sets.push('hidden = ?'); binds.push(fields.hidden ? 1 : 0); }
  if (!sets.length) return findTargetById(env, id);
  sets.push('updated_at = ?');
  binds.push(nowIso(), Number(id));
  await env.DB.prepare(`UPDATE ballistics_targets SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findTargetById(env, id);
}

export async function deleteTarget(env, id) {
  await env.DB.prepare('DELETE FROM ballistics_targets WHERE id = ?').bind(Number(id)).run();
}

// A target with no height given is at sea level, which is what the calculator
// itself assumes when an officer leaves Y blank.
function targetY(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 64;
}

// ---------- scheduled attack plans (ballistics, secret panel) ----------
//
// A standing order: guns, targets, mode, and the moment it should open fire.
// Launched by an authorised officer early, or by the cron when its moment comes
// with nobody watching — see worker/lib/attack-scheduler.js, which does the
// aiming that a closed calculator page cannot.
//
// Launching opens a row in ballistics_fire_plans and stores its id here, so the
// attack drains through the ordinary queue: it draws on the live map and lands
// in the Firing Log exactly like a hand-fired order, with one place that decides
// how shots are handed out.
export async function listAttackPlans(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM ballistics_attack_plans ORDER BY scheduled_at ASC, id ASC'
  ).all();
  return results;
}

export async function findAttackPlanById(env, id) {
  return env.DB.prepare('SELECT * FROM ballistics_attack_plans WHERE id = ?').bind(Number(id)).first();
}

// Only the plans whose moment has come. The cron's hot query, hence the index
// on (state, scheduled_at) in migration 0024.
export async function listDueAttackPlans(env, now) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM ballistics_attack_plans WHERE state = 'scheduled' AND scheduled_at != '' AND scheduled_at <= ? ORDER BY scheduled_at ASC"
  ).bind(String(now)).all();
  return results;
}

// Launched plans the cron is still feeding.
export async function listRunningAttackPlans(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM ballistics_attack_plans WHERE state = 'running' ORDER BY id ASC"
  ).all();
  return results;
}

export async function insertAttackPlan(env, fields) {
  const now = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO ballistics_attack_plans
       (name, mode, cycles, targets, guns, trajectory, drag, charges, unsynced,
        scheduled_at, state, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`
  ).bind(
    String(fields.name || '').slice(0, 80),
    fields.mode === 'constant' || fields.mode === 'multi' ? fields.mode : 'normal',
    Math.max(1, Math.min(999, Math.round(Number(fields.cycles) || 1))),
    JSON.stringify(fields.targets || []),
    JSON.stringify(fields.guns || []),
    fields.trajectory === 'direct' ? 'direct' : 'optimal',
    fields.drag == null ? null : (Number.isFinite(Number(fields.drag)) ? Number(fields.drag) : null),
    fields.charges == null ? null : (Number.isFinite(Number(fields.charges)) ? Math.round(Number(fields.charges)) : null),
    fields.unsynced ? 1 : 0,
    String(fields.scheduledAt || '').slice(0, 40),
    fields.createdBy == null ? null : String(fields.createdBy).slice(0, 80),
    now, now
  ).run();
  return findAttackPlanById(env, result.meta.last_row_id);
}

// Editing a plan. Callers only ever edit one that has not launched, but the
// state check is repeated here so no route can rewrite a plan that is already
// firing.
export async function updateAttackPlan(env, id, fields) {
  const plan = await findAttackPlanById(env, id);
  if (!plan || plan.state !== 'scheduled') return plan || null;
  const sets = [];
  const binds = [];
  if (fields.name !== undefined)        { sets.push('name = ?');        binds.push(String(fields.name).slice(0, 80)); }
  if (fields.mode !== undefined)        { sets.push('mode = ?');        binds.push(fields.mode === 'constant' || fields.mode === 'multi' ? fields.mode : 'normal'); }
  if (fields.cycles !== undefined)      { sets.push('cycles = ?');      binds.push(Math.max(1, Math.min(999, Math.round(Number(fields.cycles) || 1)))); }
  if (fields.targets !== undefined)     { sets.push('targets = ?');     binds.push(JSON.stringify(fields.targets || [])); }
  if (fields.guns !== undefined)        { sets.push('guns = ?');        binds.push(JSON.stringify(fields.guns || [])); }
  if (fields.trajectory !== undefined)  { sets.push('trajectory = ?');  binds.push(fields.trajectory === 'direct' ? 'direct' : 'optimal'); }
  if (fields.drag !== undefined)        { sets.push('drag = ?');        binds.push(fields.drag == null ? null : Number(fields.drag)); }
  if (fields.charges !== undefined)     { sets.push('charges = ?');     binds.push(fields.charges == null ? null : Math.round(Number(fields.charges))); }
  if (fields.unsynced !== undefined)    { sets.push('unsynced = ?');    binds.push(fields.unsynced ? 1 : 0); }
  if (fields.scheduledAt !== undefined) { sets.push('scheduled_at = ?'); binds.push(String(fields.scheduledAt).slice(0, 40)); }
  if (!sets.length) return plan;
  sets.push('updated_at = ?');
  binds.push(nowIso(), Number(id));
  await env.DB.prepare(`UPDATE ballistics_attack_plans SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findAttackPlanById(env, id);
}

// Move a plan through its life. `firePlanId` is written once, when the plan
// launches, and is what ties the standing order to the live one.
//
// `reason` is for the endings that are neither "fired out" nor "called off":
// the scheduler writes why an unattended order gave up (see
// worker/lib/attack-scheduler.js), and the panel shows it. It is a separate
// statement so that a database which has not yet run migration 0025 still
// closes the plan — it just closes it without a note.
export async function setAttackPlanState(env, id, state, firePlanId, reason) {
  const sets = ['state = ?', 'updated_at = ?'];
  const binds = [String(state), nowIso()];
  if (firePlanId !== undefined) { sets.push('fire_plan_id = ?', 'launched_at = ?'); binds.push(firePlanId == null ? null : Number(firePlanId), nowIso()); }
  binds.push(Number(id));
  await env.DB.prepare(`UPDATE ballistics_attack_plans SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  if (reason !== undefined) {
    try {
      await env.DB.prepare('UPDATE ballistics_attack_plans SET closed_reason = ? WHERE id = ?')
        .bind(String(reason || '').slice(0, 300), Number(id)).run();
    } catch (err) {
      console.warn('Could not record why attack plan #' + id + ' closed (run migration 0025?)', err);
    }
  }
  return findAttackPlanById(env, id);
}

export async function deleteAttackPlan(env, id) {
  await env.DB.prepare('DELETE FROM ballistics_attack_plans WHERE id = ?').bind(Number(id)).run();
}

