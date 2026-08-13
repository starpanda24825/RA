/* ============================================================
   Regnum Aeternum — Worker
   Auth routes. Same accounts table powers public citizen
   registration AND the existing /ballistics/ and /admin/ login
   gates — role is what changes what an account can reach.
   ============================================================ */

import * as store from '../lib/store.js';
import { hash, compare } from '../lib/passwords.js';
import { parseCookies, serializeCookie } from '../lib/cookies.js';

const SESSION_COOKIE = 'ra_session';
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

export { USERNAME_RE };

/** Check whether a user object (with a .role string) has a specific role.
 *  Roles are stored as a comma-separated string, e.g. "admin,banker". */
export function hasRole(user, role) {
  if (!user || !user.role) return false;
  return user.role.split(',').map(r => r.trim()).includes(role);
}

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function isHttps(request) {
  return new URL(request.url).protocol === 'https:';
}

export async function getCurrentUser(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await store.getSession(env, token);
  if (!session) return null;
  return { id: session.user_id, username: session.username, role: session.role };
}

export async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!USERNAME_RE.test(username)) {
    return json({ error: 'Username must be 3-32 characters: letters, numbers, underscore, hyphen, or period.' }, { status: 400 });
  }
  if (password.length < 8) {
    return json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  }

  const existing = await store.findUserByUsername(env, username);
  if (existing) return json({ error: 'That username is already taken.' }, { status: 409 });

  let user;
  try {
    const passwordHash = await hash(password);
    // Public registration always creates a "citizen" — role can never
    // be supplied by the client. Elevated roles are admin-only (see
    // routes/admin.js) or the one-time setup bootstrap (routes/setup.js).
    user = await store.insertUser(env, { username, passwordHash, role: 'citizen' });
  } catch (err) {
    if (err.code === 'DUPLICATE') return json({ error: 'That username is already taken.' }, { status: 409 });
    console.error(err);
    return json({ error: 'Server error.' }, { status: 500 });
  }

  const { token } = await store.createSession(env, user.id, SESSION_TTL);
  const headers = new Headers();
  headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL, secure: isHttps(request) }));
  return json({ id: user.id, username: user.username, role: user.role }, { status: 201, headers });
}

export async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return json({ error: 'Username and password required.' }, { status: 400 });

  const user = await store.findUserByUsername(env, username);
  if (!user) return json({ error: 'Invalid credentials.' }, { status: 401 });

  const ok = await compare(password, user.password_hash);
  if (!ok) return json({ error: 'Invalid credentials.' }, { status: 401 });

  const { token } = await store.createSession(env, user.id, SESSION_TTL);
  const headers = new Headers();
  headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL, secure: isHttps(request) }));
  return json({ id: user.id, username: user.username, role: user.role }, { headers });
}

export async function handleLogout(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE];
  if (token) await store.deleteSession(env, token);
  const headers = new Headers();
  headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: isHttps(request) }));
  return json({ ok: true }, { headers });
}

export async function handleMe(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return json({ error: 'Not authenticated.' }, { status: 401 });
  return json(user);
}

// ── PUT /api/auth/username ────────────────────────────────────────
export async function handleChangeUsername(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return json({ error: 'Not authenticated.' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const newUsername = String(body.username || '').trim();
  if (!USERNAME_RE.test(newUsername)) {
    return json({ error: 'Username must be 3-32 characters: letters, numbers, underscore, hyphen, or period.' }, { status: 400 });
  }

  try {
    const updated = await store.updateUserUsername(env, user.id, newUsername);

    // Patch 8: Also update the linked banking account name so it stays
    // in sync with the web username (universal username).
    const linkedAccount = await store.findBankingAccountByUserId(env, user.id);
    if (linkedAccount && linkedAccount.type === 'personal') {
      await store.updateBankingAccount(env, linkedAccount.key, { name: newUsername });
    }

    return json({ ok: true, username: newUsername });
  } catch (err) {
    if (err.code === 'DUPLICATE') return json({ error: 'That username is already taken.' }, { status: 409 });
    console.error(err);
    return json({ error: 'Server error.' }, { status: 500 });
  }
}

// ── PUT /api/auth/password ────────────────────────────────────────
export async function handleChangePassword(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return json({ error: 'Not authenticated.' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return json({ error: 'currentPassword and newPassword are required.' }, { status: 400 });
  }
  if (String(newPassword).length < 8) {
    return json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  }

  // Verify current password against the web user record
  const fullUser = await store.findUserById(env, user.id);
  if (!fullUser) return json({ error: 'User not found.' }, { status: 404 });

  const ok = await compare(String(currentPassword), fullUser.password_hash);
  if (!ok) return json({ error: 'Current password is incorrect.' }, { status: 401 });

  const newHash = await hash(String(newPassword));

  // Update the web user's password
  await store.updateUser(env, user.id, { passwordHash: newHash });

  // Also sync the password to any linked banking account so terminal
  // login uses the same credential (Patch 8 — universal password).
  const linkedAccount = await store.findBankingAccountByUserId(env, user.id);
  if (linkedAccount && linkedAccount.type === 'personal') {
    await store.updateBankingAccount(env, linkedAccount.key, { password_hash: newHash });
  }

  return json({ ok: true });
}
