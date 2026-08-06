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
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").first();
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
const ACCOUNT_COLS = 'id, key, name, balance, color, type, owner_key, treasury_key, shares, tag, frozen, cumulative, user_id, created_at, updated_at';

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

export async function findBankingAccountsByTreasury(env, treasuryKey) {
  const { results } = await env.DB.prepare(
    `SELECT ${ACCOUNT_COLS} FROM banking_accounts WHERE treasury_key = ? ORDER BY name COLLATE NOCASE ASC`
  ).bind(treasuryKey).all();
  return results;
}

export async function insertBankingAccount(env, {
  key, name, balance = 0, color = 16384, type = 'personal',
  ownerKey = '', treasuryKey = '', passwordHash = '', shares = 0, tag = '',
}) {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO banking_accounts
       (key, name, balance, color, type, owner_key, treasury_key, password_hash, shares, tag, frozen, cumulative, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).bind(key, name, balance, color, type, ownerKey, treasuryKey, passwordHash, shares, String(tag).toUpperCase(), now, now).run();
  return findBankingAccountByKey(env, key);
}

export async function updateBankingAccount(env, key, fields) {
  const allowed = ['name', 'color', 'frozen', 'shares', 'tag', 'cumulative', 'password_hash'];
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
  await env.DB.prepare('DELETE FROM banking_accounts WHERE key = ?').bind(key).run();
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

