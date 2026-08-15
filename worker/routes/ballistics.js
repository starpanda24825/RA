/* ============================================================
   Regnum Aeternum — Worker
   Ballistics: static cannon registry (web).

   All routes require a logged-in web account with the 'ballistics'
   or 'admin' role (same gate as the Ballistic Calculator page).
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser, hasRole } from './auth.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

async function requireBallistics(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return { error: json({ error: 'Authentication required.' }, { status: 401 }) };
  if (!hasRole(user, 'ballistics') && !hasRole(user, 'admin')) {
    return { error: json({ error: 'Your account does not have Crown clearance for this system.' }, { status: 403 }) };
  }
  return { user };
}

// GET /api/ballistics/cannons → { active: [...], pending: [...] }
export async function listCannons(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const rows = await store.listCannons(env);
  return json({
    active:  rows.filter((r) => r.status === 'active'),
    pending: rows.filter((r) => r.status === 'pending'),
  });
}

// POST /api/ballistics/cannons/:id/accept — approve a pending request.
export async function acceptCannon(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const cannon = await store.acceptCannon(env, id);
  if (!cannon) return json({ error: 'Pending cannon request not found.' }, { status: 404 });
  return json(cannon);
}

// PUT /api/ballistics/cannons/:id — rename / edit a registered cannon.
export async function updateCannon(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const existing = await store.findCannonById(env, id);
  if (!existing) return json({ error: 'Cannon not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = {};
  if (body.name !== undefined)     fields.name     = String(body.name).trim();
  if (body.x !== undefined)        fields.x        = Number(body.x);
  if (body.y !== undefined)        fields.y        = Number(body.y);
  if (body.z !== undefined)        fields.z        = Number(body.z);
  if (body.length !== undefined)   fields.length   = Number(body.length);
  if (body.facing !== undefined)   fields.facing   = Number(body.facing);
  if (body.sublevel !== undefined) fields.sublevel = !!body.sublevel;

  if (!fields.name) return json({ error: 'Cannon name cannot be empty.' }, { status: 400 });

  const cannon = await store.updateCannon(env, id, fields);
  return json(cannon);
}

// DELETE /api/ballistics/cannons/:id — decline a pending request / remove a cannon.
export async function deleteCannon(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const existing = await store.findCannonById(env, id);
  if (!existing) return json({ error: 'Cannon not found.' }, { status: 404 });
  await store.deleteCannon(env, id);
  return json({ ok: true });
}

// POST /api/ballistics/cannons/:id/fire — queue a fire command { yaw, pitch }.
export async function fireCannon(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const yaw = Number(body.yaw);
  const pitch = Number(body.pitch);
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
    return json({ error: 'yaw and pitch must be numbers.' }, { status: 400 });
  }

  const cannon = await store.dispatchCannonFire(env, id, { yaw, pitch });
  if (!cannon) return json({ error: 'Cannon not found or not yet accepted.' }, { status: 404 });
  return json({ ok: true, cannon });
}
