/* ============================================================
   Regnum Aeternum — Worker
   Banking System: Admin and Banker API routes.

   Bankers (role = 'banker') are scoped to their assigned Treasury
   and can manage accounts within it. Admins have full access.
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser, hasRole } from './auth.js';
import { hash } from '../lib/passwords.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

/**
 * Resolves the current user as banker or admin.
 * Returns { user, isAdmin, isBanker, treasuryKey } on success,
 * or { error: Response } on failure.
 * treasuryKey is only populated for bankers.
 */
async function requireBankerOrAdmin(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) {
    return { error: json({ error: 'Authentication required.' }, { status: 401 }) };
  }
  if (!hasRole(user, 'admin') && !hasRole(user, 'banker')) {
    return { error: json({ error: 'Banker or admin access required.' }, { status: 403 }) };
  }
  const isAdmin  = hasRole(user, 'admin');
  const isBanker = hasRole(user, 'banker');
  let treasuryKey = null;
  if (isBanker) {
    const assignment = await store.getBankerAssignment(env, user.id);
    if (!assignment) {
      return {
        error: json(
          { error: 'No treasury assigned to your banker account. Contact an administrator.' },
          { status: 403 }
        ),
      };
    }
    treasuryKey = assignment.treasury_key;
  }
  return { user, isAdmin, isBanker, treasuryKey };
}

/**
 * Returns a 403 Response if the resolved auth is not an admin, null otherwise.
 * Must only be called after auth.error has already been checked.
 */
function requireAdminOnly(auth) {
  if (!auth.isAdmin) return json({ error: 'Admin access required.' }, { status: 403 });
  return null;
}

/** Returns true if the resolved banker/admin may operate on an account. */
function bankerCanAccess(auth, account) {
  if (auth.isAdmin) return true;
  if (!auth.isBanker) return false;
  if (account.treasury_key === auth.treasuryKey) return true;
  if (account.type === 'treasury' && account.key === auth.treasuryKey) return true;
  return false;
}

// ════════════════════════════════════════════════════════════
// TICKER GENERATION
// ════════════════════════════════════════════════════════════

const TICKER_STOP_WORDS = new Set([
  'THE', 'OF', 'AND', 'A', 'AN', 'CO', 'INC', 'LTD', 'LLC', 'CORP',
  'CORPORATION', 'COMPANY', 'GROUP', 'HOLDINGS', 'INDUSTRIES',
]);

/**
 * Derives a 1-4 letter uppercase ticker from a company name: the initials
 * of up to four significant words, falling back to the first few letters
 * of a single-word name.
 */
function tickerFromName(name) {
  const words = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const significant = words.filter(w => !TICKER_STOP_WORDS.has(w));
  const pool = significant.length ? significant : words;

  let base = pool.slice(0, 4).map(w => w[0]).join('');
  if (base.length < 2 && pool.length) {
    base = pool[0].replace(/[^A-Z]/g, '').slice(0, 4);
  }
  if (base.length < 2) base = 'CO';
  return base.slice(0, 4);
}

/** Returns the first available ticker starting from the given base. */
async function findAvailableTicker(env, base) {
  const { results } = await env.DB.prepare('SELECT ticker FROM fdx_companies').all();
  const taken = new Set((results || []).map(r => String(r.ticker).toUpperCase()));

  const fits = t => /^[A-Z]{1,4}$/.test(t) && !taken.has(t);
  if (fits(base)) return base;

  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  // Extend the base with a single letter if there is room.
  if (base.length < 4) {
    for (const ch of A) {
      if (fits(base + ch)) return base + ch;
    }
  }

  // Otherwise mutate the last letter, then the second-to-last.
  for (const ch of A) {
    const cand = base.slice(0, -1) + ch;
    if (fits(cand)) return cand;
  }
  if (base.length >= 2) {
    for (const ch of A) {
      const cand = base.slice(0, -2) + ch + base.slice(-1);
      if (fits(cand)) return cand;
    }
  }

  // Last resort: first available 2- or 3-letter combination.
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      if (fits(A[i] + A[j])) return A[i] + A[j];
    }
  }
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      for (let k = 0; k < 26; k++) {
        if (fits(A[i] + A[j] + A[k])) return A[i] + A[j] + A[k];
      }
    }
  }

  return base; // unreachable in practice
}

// ════════════════════════════════════════════════════════════
// ACCOUNT MANAGEMENT
// ════════════════════════════════════════════════════════════

// GET /api/banking/admin/accounts
export async function listAccounts(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const filters = {
    type:        url.searchParams.get('type') || undefined,
    frozen:      url.searchParams.has('frozen') ? url.searchParams.get('frozen') === 'true' : undefined,
    search:      url.searchParams.get('search') || undefined,
    // Bankers are always scoped to their treasury; admins may pass ?treasury=
    treasuryKey: auth.isBanker
      ? auth.treasuryKey
      : (url.searchParams.get('treasury') || undefined),
  };

  const accounts = await store.listBankingAccounts(env, filters);
  return json(accounts);
}

// POST /api/banking/admin/accounts
export async function createAccount(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { name, color = 16384, type = 'personal', ownerKey = '', shares = 0, tag = '', password, userId,
          sector, ipoPrice, totalShares, publicSharesPct, listingStatus, stateOwned } = body;

  // Patch 8: For personal accounts with a linked web user, the name
  // comes from the web user's username — don't require a separate name.
  if (!(type === 'personal' && userId) && (!name || !String(name).trim())) {
    return json({ error: 'Account name is required.' }, { status: 400 });
  }
  if (!['personal', 'company', 'treasury'].includes(type)) {
    return json({ error: 'type must be personal, company, or treasury.' }, { status: 400 });
  }
  if (auth.isBanker && type === 'treasury') {
    return json({ error: 'Bankers cannot create treasury accounts.' }, { status: 403 });
  }
  if (type === 'company' && !ownerKey) {
    return json({ error: 'ownerKey is required for company accounts.' }, { status: 400 });
  }
  if (type === 'treasury' && !password) {
    return json({ error: 'password is required for treasury accounts.' }, { status: 400 });
  }

  let linkedUserId = null;
  let passwordHash = '';

  // Patch 8: Personal accounts are created from existing web users.
  // The web user's username becomes the account name, and their
  // password hash is copied so terminal login uses the same credential.
  if (type === 'personal' && userId) {
    const webUser = await store.findUserById(env, Number(userId));
    if (!webUser) {
      return json({ error: 'Web user not found.' }, { status: 404 });
    }
    // Check the user isn't already linked to a different personal account
    const existingLinked = await store.findPersonalAccountByUserIdExcluding(env, Number(userId), '');
    if (existingLinked) {
      return json({ error: 'This user is already linked to a personal banking account.' }, { status: 409 });
    }
    // Use web username as the account name (overrides any passed-in name)
    body.name = webUser.username;
    // Copy the web password hash for universal terminal login
    passwordHash = webUser.password_hash;
    linkedUserId = webUser.id;
  } else if (type === 'personal' && !userId) {
    // Personal account WITHOUT a web user — name is required and provided
    body.name = String(name).trim();
  }

  if (password) {
    passwordHash = await hash(String(password));
  }

  let tickerNorm = '';
  let sectorNorm = 'SERVICES';
  let ipoPriceNum = 0;
  let totalSharesNum = 1000000;
  let floatSharesNum = 750000;
  let listingStatusNorm = 'public';

  if (type === 'company') {
    const owner = await store.findBankingAccountByKey(env, ownerKey);
    if (!owner) return json({ error: 'Owner account not found.' }, { status: 404 });
    if (owner.type !== 'personal') {
      return json({ error: 'Company owner must be a personal account.' }, { status: 400 });
    }

    // Ticker is generated automatically from the company name.
    tickerNorm = await findAvailableTicker(env, tickerFromName(body.name));
    if (sector) sectorNorm = String(sector).trim().toUpperCase();

    if (listingStatus === 'private') listingStatusNorm = 'private';

    totalSharesNum = parseInt(totalShares, 10);
    if (!Number.isFinite(totalSharesNum) || totalSharesNum <= 0) totalSharesNum = 1000000;

    if (listingStatusNorm === 'private') {
      // Private companies aren't listed yet: offering price and public shares
      // are set later when the company is taken public via an offering.
      ipoPriceNum = 0;
      floatSharesNum = 0;
    } else {
      ipoPriceNum = parseFloat(ipoPrice);
      if (!Number.isFinite(ipoPriceNum) || ipoPriceNum <= 0) {
        return json({ error: 'A positive offering price is required for company accounts.' }, { status: 400 });
      }

      // Public shares is a percentage of total shares; round up to a whole
      // number if a fractional value was supplied, then to whole shares.
      const pct = Math.ceil(parseFloat(publicSharesPct));
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        return json({ error: 'Public shares must be a percentage between 1 and 100.' }, { status: 400 });
      }
      floatSharesNum = Math.ceil(totalSharesNum * pct / 100);
      if (floatSharesNum > totalSharesNum) floatSharesNum = totalSharesNum;
    }
  }

  const treasuryKey = type === 'treasury'
    ? ''
    : (auth.isBanker ? auth.treasuryKey : (body.treasuryKey || ''));

  try {
    const key     = await store.generateAccountKey(env);
    const account = await store.insertBankingAccount(env, {
      key,
      name:        String(body.name).trim(),
      balance:     0,
      color:       Number(color) || 16384,
      type,
      ownerKey:    type === 'company' ? ownerKey : '',
      treasuryKey,
      passwordHash,
      shares:      type === 'company' ? totalSharesNum : 0,
      tag:         type === 'treasury' ? String(tag).toUpperCase().slice(0, 4) : '',
      stateOwned:  type === 'company' && listingStatusNorm !== 'private' && !!stateOwned ? 1 : 0,
    });

    // Link the web user to the new personal account
    if (linkedUserId) {
      await store.linkBankingAccountToUser(env, key, linkedUserId);
    }

    // Company accounts and exchange listings are the same entity: create the
    // linked fdx_companies row so the bank and the exchange stay in sync.
    if (type === 'company') {
      try {
        await env.DB.prepare(
          `INSERT INTO fdx_companies
             (ticker, name, sector, description, logo_emoji, linked_bank_account,
              total_shares, shares_in_float, ipo_price, current_price, status)
           VALUES (?, ?, ?, '', '🏢', ?, ?, ?, ?, ?, ?)`
        ).bind(tickerNorm, String(body.name).trim(), sectorNorm, key,
               totalSharesNum, floatSharesNum, ipoPriceNum, ipoPriceNum,
               listingStatusNorm === 'private' ? 'private' : 'active').run();
      } catch (fdxErr) {
        // Roll back the bank account so a failed listing never orphans it
        await store.deleteBankingAccount(env, key);
        if (String(fdxErr && fdxErr.message || '').toUpperCase().includes('UNIQUE')) {
          return json({ error: 'Ticker already exists.' }, { status: 409 });
        }
        throw fdxErr;
      }
    }

    return json(account, { status: 201 });
  } catch (err) {
    console.error(err);
    return json({ error: 'Server error creating account.' }, { status: 500 });
  }
}

// GET /api/banking/admin/accounts/:key
export async function getAccount(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });
  if (!bankerCanAccess(auth, account)) return json({ error: 'Access denied.' }, { status: 403 });

  return json(account);
}

// PUT /api/banking/admin/accounts/:key
export async function updateAccount(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });
  if (!bankerCanAccess(auth, account)) return json({ error: 'Access denied.' }, { status: 403 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = {};
  if (body.name  !== undefined) fields.name  = String(body.name).trim();
  if (body.color !== undefined) fields.color = Number(body.color) || account.color;
  if (body.shares !== undefined && account.type === 'company') {
    fields.shares = Math.max(0, Number(body.shares) || 0);
  }
  if (body.stateOwned !== undefined && account.type === 'company') {
    const newVal = !!body.stateOwned;
    // Removing state ownership (unticking) is restricted to admins.
    if (!newVal && account.state_owned && !auth.isAdmin) {
      return json({ error: 'Only admins can remove state ownership from a company.' }, { status: 403 });
    }
    fields.state_owned = newVal ? 1 : 0;
  }
  if (body.tag !== undefined && account.type === 'treasury') {
    fields.tag = String(body.tag).toUpperCase().slice(0, 4);
  }
  if (body.treasuryKey !== undefined && account.type !== 'treasury') {
    // Admin-only: reassign account to a different treasury
    if (!auth.isAdmin) return json({ error: 'Only admins can reassign treasury.' }, { status: 403 });
    if (body.treasuryKey) {
      const tre = await store.findBankingAccountByKey(env, body.treasuryKey);
      if (!tre || tre.type !== 'treasury') return json({ error: 'Invalid treasury key.' }, { status: 400 });
    }
    fields.treasury_key = body.treasuryKey || '';
  }

  const updated = await store.updateBankingAccount(env, key, fields);
  return json(updated);
}

// DELETE /api/banking/admin/accounts/:key?force=true
export async function deleteAccount(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });
  if (account.type === 'treasury') {
    return json({ error: 'Use the treasury management endpoints to delete treasury accounts.' }, { status: 400 });
  }

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === 'true';

  if (!force && account.balance > 0) {
    return json(
      { error: `Account has a non-zero balance ($${account.balance}). Pass ?force=true to confirm.` },
      { status: 409 }
    );
  }

  // Company accounts: must have no outstanding shareholders (or use force)
  if (account.type === 'company') {
    const shareholders = await store.listShareholders(env, key);
    if (shareholders.length > 0 && !force) {
      return json(
        { error: `Company has ${shareholders.length} outstanding shareholder(s). Pass ?force=true to confirm deletion.` },
        { status: 409 }
      );
    }
  }

  await store.deleteBankingAccount(env, key);
  return json({ ok: true });
}

// PUT /api/banking/admin/accounts/:key/freeze
export async function freezeAccount(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });
  if (!bankerCanAccess(auth, account)) return json({ error: 'Access denied.' }, { status: 403 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  await store.updateBankingAccount(env, key, { frozen: body.frozen ? 1 : 0 });
  return json({ ok: true, frozen: !!body.frozen });
}

// PUT /api/banking/admin/accounts/:key/password-reset
export async function resetPasswordAdmin(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });
  if (!bankerCanAccess(auth, account)) return json({ error: 'Access denied.' }, { status: 403 });

  const newHash = await hash('1234');
  await store.updateBankingAccount(env, key, { password_hash: newHash });
  return json({ ok: true });
}

// GET /api/banking/admin/accounts/:key/log
export async function getAccountLog(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });
  if (!bankerCanAccess(auth, account)) return json({ error: 'Access denied.' }, { status: 403 });

  const url    = new URL(request.url);
  const limit  = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit')  || '50', 10) || 50));
  const offset = Math.max(0,              parseInt(url.searchParams.get('offset') || '0',  10) || 0);
  const log    = await store.getBankingTransactionLog(env, key, { limit, offset });
  return json(log);
}

// PUT /api/banking/admin/accounts/:key/link-user
export async function linkUser(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const targetUserId = body.userId ? Number(body.userId) : null;

  // Patch 8: Prevent linking a user to multiple personal accounts
  if (targetUserId && account.type === 'personal') {
    const existingLinked = await store.findPersonalAccountByUserIdExcluding(env, targetUserId, key);
    if (existingLinked) {
      return json({ error: 'This user is already linked to a different personal banking account.' }, { status: 409 });
    }
  }

  await store.linkBankingAccountToUser(env, key, targetUserId);

  // Patch 8: Sync web password to banking account for universal terminal login
  if (targetUserId) {
    const webUser = await store.findUserById(env, targetUserId);
    if (webUser) {
      await store.updateBankingAccount(env, key, { password_hash: webUser.password_hash });
    }
  }

  return json({ ok: true });
}

// DELETE /api/banking/admin/accounts/:key/link-user
export async function unlinkUser(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });

  await store.linkBankingAccountToUser(env, key, null);
  return json({ ok: true });
}

// ════════════════════════════════════════════════════════════
// CARD MANAGEMENT
// ════════════════════════════════════════════════════════════

function generateCardId() {
  return 'C' + Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
}

// GET /api/banking/admin/accounts/:key/cards
export async function listCards(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });
  if (!bankerCanAccess(auth, account)) return json({ error: 'Access denied.' }, { status: 403 });

  return json(await store.listBankingCards(env, key));
}

// POST /api/banking/admin/accounts/:key/cards
export async function issueCard(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });
  if (!bankerCanAccess(auth, account)) return json({ error: 'Access denied.' }, { status: 403 });

  let cardId = generateCardId();
  for (let i = 0; i < 10; i++) {
    const existing = await store.findBankingCard(env, cardId);
    if (!existing) break;
    cardId = generateCardId();
  }

  try {
    const card = await store.insertBankingCard(env, {
      cardId,
      accountKey: key,
      issuedBy:   String(auth.user.id),
    });
    return json({ ok: true, cardId: card.cardId, accountKey: key }, { status: 201 });
  } catch (err) {
    if (err.code === 'CARD_LIMIT') return json({ error: err.message }, { status: 409 });
    console.error(err);
    return json({ error: 'Server error.' }, { status: 500 });
  }
}

// PUT /api/banking/admin/accounts/:key/cards/:cardId/cancel
export async function cancelCard(request, env, key, cardId) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });
  if (!bankerCanAccess(auth, account)) return json({ error: 'Access denied.' }, { status: 403 });

  const card = await store.findBankingCard(env, cardId);
  if (!card || card.account_key !== key) return json({ error: 'Card not found.' }, { status: 404 });

  await store.updateBankingCard(env, cardId, { status: 'canceled' });
  return json({ ok: true });
}

// DELETE /api/banking/admin/accounts/:key/cards/:cardId
export async function deleteCard(request, env, key, cardId) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  const card = await store.findBankingCard(env, cardId);
  if (!card || card.account_key !== key) return json({ error: 'Card not found.' }, { status: 404 });

  await store.deleteBankingCard(env, cardId);
  return json({ ok: true });
}

// ════════════════════════════════════════════════════════════
// TRANSACTIONS
// ════════════════════════════════════════════════════════════

// POST /api/banking/admin/transaction
export async function adminTransfer(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { fromKey, toKey, amount, description = '' } = body;
  if (!fromKey || !toKey) {
    return json({ error: 'fromKey and toKey are required.' }, { status: 400 });
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return json({ error: 'Invalid amount.' }, { status: 400 });
  }

  if (auth.isBanker) {
    const [fromAcc, toAcc] = await Promise.all([
      store.findBankingAccountByKey(env, fromKey),
      store.findBankingAccountByKey(env, toKey),
    ]);
    if (!bankerCanAccess(auth, fromAcc || {}) && !bankerCanAccess(auth, toAcc || {})) {
      return json({ error: 'Neither account is within your treasury scope.' }, { status: 403 });
    }
  }

  try {
    const result = await store.atomicTransfer(env, {
      fromKey,
      toKey,
      amount:      amt,
      description: String(description).slice(0, 100),
      initiatedBy: `web:${auth.user.id}`,
    });
    return json({ ok: true, fromBalanceAfter: result.fromBalanceAfter, toBalanceAfter: result.toBalanceAfter });
  } catch (err) {
    const statusMap = {
      NOT_FOUND: 404, FROZEN: 403, INSUFFICIENT_BALANCE: 422,
      TYPE_MISMATCH: 422, SELF_TRANSFER: 400,
    };
    return json({ error: err.message }, { status: statusMap[err.code] || 500 });
  }
}

// POST /api/banking/admin/fine
export async function adminFine(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { accountKey, amount, description = 'Fine' } = body;
  if (!accountKey) return json({ error: 'accountKey is required.' }, { status: 400 });
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return json({ error: 'Invalid amount.' }, { status: 400 });

  let sinkKey;
  if (auth.isBanker) {
    sinkKey = auth.treasuryKey;
  } else {
    const settings = await store.getBankingSettings(env);
    if (!settings.bank_owner_key) {
      return json({ error: 'No bank owner treasury configured. Set bank_owner_key in settings.' }, { status: 422 });
    }
    sinkKey = settings.bank_owner_key;
  }

  const account = await store.findBankingAccountByKey(env, accountKey);
  if (!account) return json({ error: 'Account not found.' }, { status: 404 });
  if (!bankerCanAccess(auth, account)) return json({ error: 'Access denied.' }, { status: 403 });

  try {
    const result = await store.atomicTransfer(env, {
      fromKey:     accountKey,
      toKey:       sinkKey,
      amount:      amt,
      description: String(description).slice(0, 100),
      initiatedBy: `web:${auth.user.id}`,
    });
    return json({ ok: true, fromBalanceAfter: result.fromBalanceAfter });
  } catch (err) {
    const statusMap = {
      NOT_FOUND: 404, FROZEN: 403, INSUFFICIENT_BALANCE: 422,
      TYPE_MISMATCH: 422, SELF_TRANSFER: 400,
    };
    return json({ error: err.message }, { status: statusMap[err.code] || 500 });
  }
}

// ════════════════════════════════════════════════════════════
// SETTINGS (admin only)
// ════════════════════════════════════════════════════════════

// GET /api/banking/admin/settings
export async function getSettings(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  return json(await store.getBankingSettings(env));
}

// PUT /api/banking/admin/settings
export async function updateSettings(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  if (body.currency_prices && typeof body.currency_prices !== 'object') {
    return json({ error: 'currency_prices must be an object.' }, { status: 400 });
  }
  for (const field of ['tax_rate_personal', 'tax_rate_company']) {
    if (body[field] !== undefined && (typeof body[field] !== 'number' || body[field] < 0 || body[field] > 100)) {
      return json({ error: `${field} must be a number between 0 and 100.` }, { status: 400 });
    }
  }

  return json(await store.updateBankingSettings(env, body));
}

// ════════════════════════════════════════════════════════════
// TREASURIES (admin only)
// ════════════════════════════════════════════════════════════

// GET /api/banking/admin/treasuries
export async function listTreasuries(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  return json(await store.listBankingAccounts(env, { type: 'treasury' }));
}

// POST /api/banking/admin/treasuries
export async function createTreasury(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { name, color = 16384, tag = '', password } = body;
  if (!name || !String(name).trim()) return json({ error: 'name is required.' }, { status: 400 });
  if (!tag  || !String(tag).trim())  return json({ error: 'tag is required (2-4 letters).' }, { status: 400 });
  if (!password)                     return json({ error: 'password is required.' }, { status: 400 });

  const passwordHash = await hash(String(password));

  try {
    const key     = await store.generateAccountKey(env);
    const account = await store.insertBankingAccount(env, {
      key,
      name:        String(name).trim(),
      balance:     0,
      color:       Number(color) || 16384,
      type:        'treasury',
      ownerKey:    '',
      treasuryKey: '',
      passwordHash,
      shares:      0,
      tag:         String(tag).toUpperCase().slice(0, 4),
    });

    // Auto-assign as bank_owner_key if none is set yet
    const settings = await store.getBankingSettings(env);
    if (!settings.bank_owner_key) {
      await store.updateBankingSettings(env, { bank_owner_key: key });
    }

    return json(account, { status: 201 });
  } catch (err) {
    console.error(err);
    return json({ error: 'Server error.' }, { status: 500 });
  }
}

// PUT /api/banking/admin/treasuries/:key
export async function updateTreasury(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account || account.type !== 'treasury') {
    return json({ error: 'Treasury account not found.' }, { status: 404 });
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = {};
  if (body.name     !== undefined) fields.name  = String(body.name).trim();
  if (body.color    !== undefined) fields.color = Number(body.color) || account.color;
  if (body.tag      !== undefined) fields.tag   = String(body.tag).toUpperCase().slice(0, 4);
  if (body.password)               fields.password_hash = await hash(String(body.password));

  return json(await store.updateBankingAccount(env, key, fields));
}

// DELETE /api/banking/admin/treasuries/:key?force=true
export async function deleteTreasury(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account || account.type !== 'treasury') {
    return json({ error: 'Treasury account not found.' }, { status: 404 });
  }

  // Cannot delete the bank_owner_key treasury unless a new one is set
  const settings = await store.getBankingSettings(env);
  if (settings.bank_owner_key === key) {
    return json({ error: 'This treasury is the bank owner. Set a different bank_owner_key in settings before deleting.' }, { status: 409 });
  }

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === 'true';

  // Must have zero balance (or force)
  if (!force && account.balance > 0) {
    return json(
      { error: `Treasury has a non-zero balance ($${account.balance}). Pass ?force=true to confirm.` },
      { status: 409 }
    );
  }

  // Must have no sub-accounts (or force)
  const subAccounts = await store.findBankingAccountsByTreasury(env, key);
  if (subAccounts.length > 0 && !force) {
    return json(
      { error: `Treasury has ${subAccounts.length} sub-account(s). Reassign or delete them first, or pass ?force=true.` },
      { status: 409 }
    );
  }

  await store.deleteBankingAccount(env, key);
  return json({ ok: true });
}

// ════════════════════════════════════════════════════════════
// BANKER ASSIGNMENTS (admin only)
// ════════════════════════════════════════════════════════════

// GET /api/banking/admin/banker-assignments
export async function listBankerAssignmentsRoute(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  return json(await store.listBankerAssignments(env));
}

// PUT /api/banking/admin/banker-assignments/:userId
export async function upsertBankerAssignmentRoute(request, env, userId) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  if (!body.treasuryKey) {
    return json({ error: 'treasuryKey is required.' }, { status: 400 });
  }

  const treasury = await store.findBankingAccountByKey(env, body.treasuryKey);
  if (!treasury || treasury.type !== 'treasury') {
    return json({ error: 'Treasury account not found.' }, { status: 404 });
  }

  await store.upsertBankerAssignment(env, {
    userId:      Number(userId),
    treasuryKey: body.treasuryKey,
    assignedBy:  auth.user.id,
  });
  return json({ ok: true });
}

// DELETE /api/banking/admin/banker-assignments/:userId
export async function deleteBankerAssignmentRoute(request, env, userId) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  await store.deleteBankerAssignment(env, Number(userId));
  return json({ ok: true });
}

// ════════════════════════════════════════════════════════════
// TAXES (admin only)
// ════════════════════════════════════════════════════════════

// POST /api/banking/admin/taxes/run
export async function runTaxes(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  const result = await store.applyTaxes(env, `web:${auth.user.id}`);
  return json({ ok: true, ...result });
}

// ════════════════════════════════════════════════════════════
// COMPANIES & SHARES
// ════════════════════════════════════════════════════════════

// GET /api/banking/admin/companies
export async function listCompaniesAdmin(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const filters = auth.isBanker
    ? { type: 'company', treasuryKey: auth.treasuryKey }
    : { type: 'company' };

  const companies = await store.listBankingAccounts(env, filters);
  return json(companies.map(a => ({
    ...a,
    pricePerShare: a.shares > 0 ? Math.round((a.balance / a.shares) * 100) / 100 : 0,
  })));
}

// GET /api/banking/admin/companies/:key/shareholders
export async function getCompanyShareholdersAdmin(request, env, key) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  const account = await store.findBankingAccountByKey(env, key);
  if (!account || account.type !== 'company') {
    return json({ error: 'Company not found.' }, { status: 404 });
  }
  return json(await store.listShareholders(env, key));
}

// POST /api/banking/admin/shares/issue
export async function issueSharesAdmin(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { issuerKey, companyKey, buyerKey, shareCount } = body;
  if (!issuerKey || !companyKey || !buyerKey || !shareCount) {
    return json({ error: 'issuerKey, companyKey, buyerKey, and shareCount are required.' }, { status: 400 });
  }
  if (!Number.isInteger(Number(shareCount)) || Number(shareCount) <= 0) {
    return json({ error: 'shareCount must be a positive integer.' }, { status: 400 });
  }

  try {
    const result = await store.atomicIssueShares(env, {
      issuerKey,
      companyKey,
      buyerKey,
      shareCount: Number(shareCount),
    });
    return json({ ok: true, ...result });
  } catch (err) {
    const statusMap = {
      NOT_FOUND: 404, FORBIDDEN: 403, INSUFFICIENT_BALANCE: 422,
      TYPE_MISMATCH: 422, SELF_TRANSFER: 400, INVALID_AMOUNT: 400,
    };
    return json({ error: err.message }, { status: statusMap[err.code] || 500 });
  }
}

// ════════════════════════════════════════════════════════════
// CC TOKEN MANAGEMENT (admin only)
// ════════════════════════════════════════════════════════════

async function sha256hex(text) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateSecret(bytes = 32) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// GET /api/banking/admin/cc-tokens
export async function listCCTokens(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  return json(await store.listCCTokens(env));
}

// POST /api/banking/admin/cc-tokens
export async function issueCCToken(request, env) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const VALID_TYPES = ['atm', 'admin', 'app', 'clerk', 'stock_exchange'];
  if (!VALID_TYPES.includes(body.terminalType)) {
    return json({ error: `terminalType must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 });
  }
  if (body.terminalType === 'admin' && !body.treasuryKey) {
    return json({ error: 'treasuryKey is required for admin-type tokens.' }, { status: 400 });
  }
  if (body.terminalType === 'admin') {
    const treasury = await store.findBankingAccountByKey(env, body.treasuryKey);
    if (!treasury || treasury.type !== 'treasury') {
      return json({ error: 'Treasury account not found.' }, { status: 404 });
    }
  }

  const plaintext = generateSecret(32);
  const tokenHash = await sha256hex(plaintext);

  const id = await store.insertCCToken(env, {
    tokenHash,
    terminalType:  body.terminalType,
    computerLabel: String(body.computerLabel || '').slice(0, 80),
    treasuryKey:   body.terminalType === 'admin' ? (body.treasuryKey || '') : '',
    createdBy:     auth.user.id,
    expiresAt:     body.expiresAt || '',
  });

  return json({
    ok:           true,
    id,
    terminalType: body.terminalType,
    secret:       plaintext,
    note:         'Save this secret immediately — it cannot be recovered.',
  }, { status: 201 });
}

// DELETE /api/banking/admin/cc-tokens/:id
export async function revokeCCToken(request, env, id) {
  const auth = await requireBankerOrAdmin(request, env);
  if (auth.error) return auth.error;
  const deny = requireAdminOnly(auth);
  if (deny) return deny;

  await store.deleteCCTokenById(env, Number(id));
  return json({ ok: true });
}
