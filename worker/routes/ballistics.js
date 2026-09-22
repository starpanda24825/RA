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

// GET /api/ballistics/towers → { towers: [...] }
// The GPS tower registry: every tower any cannon has reported hearing, with
// how often it has been seen and how often it had to be excluded for not
// fitting the rest of the network. Towers are written from the CC poll, so
// this is a read-only view for the GPS Network tab.
export async function listTowers(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  // Telemetry: an unapplied migration must not break the page, so a missing
  // table simply reads as "no towers yet".
  let rows = [];
  try {
    rows = await store.listGpsTowers(env);
  } catch (err) {
    console.warn('Could not list GPS towers (run migration 0015?)', err);
  }
  const towers = (rows || []).map((t) => ({
    id:        t.id,
    key:       t.tower_key,
    x:         Number(t.x),
    y:         Number(t.y),
    z:         Number(t.z),
    sightings: Number(t.sightings) || 0,
    excluded:  Number(t.excluded_count) || 0,
    reportedBy: t.reported_by || '',
    firstSeenAt: t.first_seen_at,
    lastSeenAt:  t.last_seen_at,
  }));
  return json({ towers });
}

// GET /api/ballistics/vehicles → { active: [...], pending: [...] }
// Each vehicle carries the cannons assigned to it, because that assignment is
// what the whole vehicle concept pivots on: the vehicle computer picks up the
// commands for exactly those cannons.
export async function listVehicles(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;

  // Telemetry-adjacent: an unapplied migration must not break the calculator
  // page, so a missing table simply reads as "no vehicles yet".
  let rows = [];
  let cannonRows = [];
  try {
    rows = await store.listVehicles(env);
    cannonRows = await store.listCannons(env);
  } catch (err) {
    console.warn('Could not list vehicles (run migration 0016?)', err);
  }

  const byVehicle = new Map();
  for (const c of cannonRows || []) {
    if (c.vehicle_id == null) continue;
    const key = Number(c.vehicle_id);
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push({
      id:          c.id,
      name:        c.name || ('Cannon ' + c.id),
      computerId:  c.computer_id,
      sublevel:    Number(c.sublevel) === 1,
      status:      c.status,
      x:           Number(c.x),
      y:           Number(c.y),
      z:           Number(c.z),
      lastSeenAt:  c.last_seen_at,
    });
  }

  const shape = (v) => ({
    ...v,
    cannons: byVehicle.get(Number(v.id)) || [],
  });

  return json({
    active:  (rows || []).filter((v) => v.status === 'active').map(shape),
    pending: (rows || []).filter((v) => v.status !== 'active').map(shape),
  });
}

// POST /api/ballistics/vehicles/:id/accept — approve a pending vehicle.
export async function acceptVehicle(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const vehicle = await store.acceptVehicle(env, id);
  if (!vehicle) return json({ error: 'Pending vehicle request not found.' }, { status: 404 });
  return json(vehicle);
}

// PUT /api/ballistics/vehicles/:id — rename / edit a registered vehicle.
export async function updateVehicle(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const existing = await store.findVehicleById(env, id);
  if (!existing) return json({ error: 'Vehicle not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = {};
  if (body.name !== undefined) fields.name = String(body.name).trim();
  if (body.name !== undefined && !fields.name) {
    return json({ error: 'Vehicle name cannot be empty.' }, { status: 400 });
  }

  const vehicle = await store.updateVehicle(env, id, fields);
  return json(vehicle);
}

// DELETE /api/ballistics/vehicles/:id — decline a request / remove a vehicle.
// Its cannons are released back to standalone, never deleted with it.
export async function deleteVehicle(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const existing = await store.findVehicleById(env, id);
  if (!existing) return json({ error: 'Vehicle not found.' }, { status: 404 });
  await store.deleteVehicle(env, id);
  return json({ ok: true });
}

// POST /api/ballistics/vehicles/:id/cannons — assign or release a cannon.
// Body: { cannonId, assign: true|false }
export async function assignVehicleCannon(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;

  const vehicle = await store.findVehicleById(env, id);
  if (!vehicle) return json({ error: 'Vehicle not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const cannonId = Math.round(Number(body.cannonId));
  if (!Number.isFinite(cannonId)) return json({ error: 'cannonId required.' }, { status: 400 });

  const cannon = await store.findCannonById(env, cannonId);
  if (!cannon) return json({ error: 'Cannon not found.' }, { status: 404 });

  const assign = body.assign !== false;
  if (assign) {
    if (cannon.status !== 'active') {
      return json({ error: 'Accept the cannon before assigning it to a vehicle.' }, { status: 400 });
    }
    if (Number(cannon.sublevel) !== 1) {
      return json({ error: 'Only sublevel (mobile) cannons can be assigned to a vehicle.' }, { status: 400 });
    }
  }

  const updated = await store.assignCannonToVehicle(env, cannonId, assign ? vehicle.id : null);
  return json(updated);
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
