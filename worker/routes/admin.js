/* ============================================================
   Regnum Aeternum — Worker
   Admin-only account management. Mirrors the old
   server/routes/admin.js, ported from Express to plain
   Request/Response handlers backed by D1.
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser, USERNAME_RE, hasRole } from './auth.js';
import { hash } from '../lib/passwords.js';

const VALID_ROLES = ['citizen', 'ballistics', 'editor', 'banker', 'admin', 'adapter'];

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

async function requireAdmin(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !hasRole(user, 'admin')) return null;
  return user;
}

export async function listUsersRoute(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });
  return json(await store.listUsers(env));
}

export async function createUserRoute(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const roleInput = body.role || 'citizen';
  const roles = String(roleInput).split(',').map(r => r.trim()).filter(Boolean);
  for (const r of roles) {
    if (!VALID_ROLES.includes(r)) return json({ error: 'Invalid role: ' + r }, { status: 400 });
  }
  const role = roles.join(',');

  if (!USERNAME_RE.test(username)) {
    return json({ error: 'Username must be 3-32 characters: letters, numbers, underscore, hyphen, or period.' }, { status: 400 });
  }
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, { status: 400 });

  try {
    const passwordHash = await hash(password);
    const user = await store.insertUser(env, { username, passwordHash, role });
    return json({ id: user.id, username: user.username, role: user.role }, { status: 201 });
  } catch (err) {
    if (err.code === 'DUPLICATE') return json({ error: 'Username already exists.' }, { status: 409 });
    console.error(err);
    return json({ error: 'Server error.' }, { status: 500 });
  }
}

export async function updateUserRoute(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const existing = await store.findUserById(env, id);
  if (!existing) return json({ error: 'User not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = {};
  if (body.role) {
    const roles = String(body.role).split(',').map(r => r.trim()).filter(Boolean);
    for (const r of roles) {
      if (!VALID_ROLES.includes(r)) return json({ error: 'Invalid role: ' + r }, { status: 400 });
    }
    fields.role = roles.join(',');
  }
  if (body.password) {
    if (String(body.password).length < 8) return json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
    fields.passwordHash = await hash(body.password);
  }

  const updated = await store.updateUser(env, id, fields);

  // Universal-password rule: the linked personal bank account shares the web
  // user's credential. The self-service flow syncs this in /api/auth/password;
  // the admin reset path must too.
  if (fields.passwordHash) {
    const linkedAccount = await store.findBankingAccountByUserId(env, id);
    if (linkedAccount && linkedAccount.type === 'personal') {
      await store.updateBankingAccount(env, linkedAccount.key, { password_hash: fields.passwordHash });
    }
  }

  return json({ id: updated.id, username: updated.username, role: updated.role, created_at: updated.created_at });
}

export async function deleteUserRoute(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });
  if (Number(id) === admin.id) return json({ error: 'Cannot delete your own account.' }, { status: 400 });

  const existing = await store.findUserById(env, id);
  if (!existing) return json({ error: 'User not found.' }, { status: 404 });

  await store.deleteUserById(env, id);
  return json({ ok: true });
}
