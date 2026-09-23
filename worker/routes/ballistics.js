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

// GET /api/ballistics/cannons → { active: [...], managed: [...], pending: [...] }
//
// `managed` are cannons owned by an ACCEPTED Sublevel Vehicle Computer: it
// holds the heading they all share and delivers their commands, so they are
// neither aimed nor fired one at a time. They belong to their vehicle in the
// Vehicle Registry — but they are still returned here so the map can show
// where a ship's guns actually are.
//
// A cannon on a PENDING vehicle is NOT managed: the CC bridge withholds
// commands only for an active vehicle, so such a cannon is still running its
// own command loop and stays independently controllable.
export async function listCannons(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const rows = await store.listCannons(env);

  let activeVehicleIds = new Set();
  try {
    const vehicles = await store.listVehicles(env);
    activeVehicleIds = new Set(
      (vehicles || []).filter((v) => v.status === 'active').map((v) => Number(v.id))
    );
  } catch (err) {
    console.warn('Could not list vehicles for cannon ownership (run migration 0016?)', err);
  }
  const isManaged = (r) =>
    r.status === 'active' && r.vehicle_id != null && activeVehicleIds.has(Number(r.vehicle_id));

  return json({
    active:  rows.filter((r) => r.status === 'active' && !isManaged(r)),
    managed: rows.filter(isManaged),
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
      // Firing the vehicle means solving for each gun from its own position,
      // so the calculator needs each gun's barrel length and resting facing.
      length:      Number(c.length),
      facing:      Number(c.facing),
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

  // A cannon owned by an ACCEPTED vehicle is not individually controllable:
  // the vehicle holds the heading its guns share and a ship's guns are fired
  // as one (see fireVehicle). Refusing here as well as in the UI means such a
  // cannon can never be left holding a command nothing will ever assign.
  const target = await store.findCannonById(env, id);
  if (!target) return json({ error: 'Cannon not found or not yet accepted.' }, { status: 404 });
  if (target.vehicle_id != null) {
    let owner = null;
    try { owner = await store.findVehicleById(env, target.vehicle_id); } catch { /* 0016 not applied */ }
    if (owner && owner.status === 'active') {
      return json({
        error: (owner.name || ('Vehicle ' + owner.id)) + ' owns this cannon — fire the vehicle instead.',
      }, { status: 409 });
    }
  }

  const cannon = await store.dispatchCannonFire(env, id, { yaw, pitch });
  if (!cannon) return json({ error: 'Cannon not found or not yet accepted.' }, { status: 404 });
  return json({ ok: true, cannon });
}

// POST /api/ballistics/vehicles/:id/fire — fire the whole ship at one target.
// Body: { shots: [ { cannonId, yaw, pitch } ] }
//
// Each gun is aimed from its own mount, but the target is the ship's, so the
// caller works out one ABSOLUTE world heading per gun (the calculator has every
// gun's position) and queues them together. The vehicle computer subtracts the
// live ship heading from each as it assigns them, which is what keeps the whole
// broadside on the same target while the ship turns.
//
// Every shot is checked against this vehicle's own gun list, so one ship can
// never fire another's cannons.
export async function fireVehicle(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;

  const vehicle = await store.findVehicleById(env, id);
  if (!vehicle) return json({ error: 'Vehicle not found.' }, { status: 404 });
  if (vehicle.status !== 'active') {
    return json({ error: 'Accept this vehicle before firing its guns.' }, { status: 400 });
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const shots = Array.isArray(body.shots) ? body.shots : [];
  if (!shots.length) return json({ error: 'No shots supplied.' }, { status: 400 });

  const owned = new Map((await store.listCannonsByVehicle(env, vehicle.id)).map((c) => [Number(c.id), c]));

  // Validate the whole broadside before queueing any of it, so a bad entry in
  // the list cannot leave half the guns firing and half silent.
  const checked = [];
  for (const shot of shots.slice(0, 32)) {
    const cannonId = Math.round(Number(shot && shot.cannonId));
    const cannon = owned.get(cannonId);
    if (!cannon) {
      return json({ error: 'Cannon ' + cannonId + ' is not assigned to this vehicle.' }, { status: 400 });
    }
    if (cannon.status !== 'active') {
      return json({ error: 'Cannon ' + cannonId + ' has not been accepted yet.' }, { status: 400 });
    }
    const yaw = Number(shot && shot.yaw);
    const pitch = Number(shot && shot.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return json({ error: 'Cannon ' + cannonId + ': yaw and pitch must be numbers.' }, { status: 400 });
    }
    checked.push({ cannonId, yaw, pitch });
  }

  for (const shot of checked) {
    await store.dispatchCannonFire(env, shot.cannonId, { yaw: shot.yaw, pitch: shot.pitch });
  }
  return json({ ok: true, fired: checked.length });
}

// ════════════════════════════════════════════
//  Bombardment modes
//    Normal       — one shot per selected gun at one target.
//    Constant     — one target, guns cycle fire/reload until stopped.
//    Multi-Target — a queue of targets over N cycles, split across the guns.
//
//    A plan is opened once, and its shots are appended as the operator's page
//    works them out — it is the only place the ballistics solver lives. The
//    worker's job is to hold the queue and hand each gun its next shot the
//    moment the previous one is acked (see promoteQueuedShot in the store),
//    which is what keeps a multi-gun run synchronous.
// ════════════════════════════════════════════

const FIRE_MODES = ['normal', 'constant', 'multi'];
const FIRE_PLAN_STATES = ['running', 'paused', 'stopped'];

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

// The stored row is what a page needs to rebuild its scheduler, with the two
// JSON columns handed back as arrays rather than strings.
function planView(plan) {
  return {
    id:         Number(plan.id),
    mode:       plan.mode,
    state:      plan.state,
    cycles:     Number(plan.cycles),
    targets:    parseJsonArray(plan.targets),
    guns:       parseJsonArray(plan.guns),
    crew:       plan.crew || null,
    created_at: plan.created_at,
  };
}

// Only accepted cannons may be given a plan's shots, and the vehicle a gun
// belongs to is read from the cannon itself rather than trusted from the
// request — a ship's gun must never be fired on behalf of a vehicle it is not
// actually on.
async function resolvePlanGuns(env, guns) {
  const out = [];
  const seen = new Set();
  for (const entry of (Array.isArray(guns) ? guns : []).slice(0, 64)) {
    const id = Math.round(Number(entry && entry.cannonId));
    if (!id || seen.has(id)) continue;
    const cannon = await store.findCannonById(env, id);
    if (!cannon || cannon.status !== 'active') {
      return { error: 'Cannon ' + id + ' is not an accepted cannon.' };
    }
    seen.add(id);
    out.push({
      cannonId:  id,
      vehicleId: cannon.vehicle_id == null ? null : Number(cannon.vehicle_id),
      name:      cannon.name || ('Cannon ' + cannon.id),
    });
  }
  if (!out.length) return { error: 'No cannons were selected.' };
  return { guns: out };
}

// POST /api/ballistics/fire-plans — open a firing order.
// Body: { mode, cycles, targets: [{ key, x, y, z, label }], guns: [{ cannonId }] }
export async function createFirePlan(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const mode = FIRE_MODES.includes(String(body.mode)) ? String(body.mode) : null;
  if (!mode) return json({ error: 'mode must be normal, constant or multi.' }, { status: 400 });

  const resolved = await resolvePlanGuns(env, body.guns);
  if (resolved.error) return json({ error: resolved.error }, { status: 400 });

  // Targets are kept so a reloaded page can carry on with the same order. They
  // are never used to aim: every shot arrives with its own yaw and pitch.
  const targets = [];
  for (const t of (Array.isArray(body.targets) ? body.targets : []).slice(0, 200)) {
    const x = Number(t && t.x);
    const z = Number(t && t.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const y = Number.isFinite(Number(t && t.y)) ? Number(t.y) : 64;
    const key = String((t && t.key) || (x + ',' + y + ',' + z)).slice(0, 48);
    targets.push({ key, x, y, z, label: String((t && t.label) || key).slice(0, 60) });
  }
  if (!targets.length) return json({ error: 'A firing order needs at least one target.' }, { status: 400 });

  try {
    const plan = await store.insertFirePlan(env, {
      mode,
      cycles: mode === 'multi' ? Math.max(1, Math.min(999, Math.round(Number(body.cycles) || 1))) : 1,
      targets,
      guns: resolved.guns,
      crew: auth.user && auth.user.username,
    });
    return json({ ok: true, plan: planView(plan) });
  } catch (err) {
    console.warn('Could not open fire plan (run migration 0018?)', err);
    return json({ error: 'Could not open the firing order — is migration 0018 applied?' }, { status: 500 });
  }
}

// GET /api/ballistics/fire-plans — the orders still live, so a page that was
// reloaded mid-barrage can pick its order back up instead of losing it.
export async function listFirePlans(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  let rows = [];
  try {
    rows = await store.listActiveFirePlans(env);
  } catch (err) {
    console.warn('Could not list fire plans (run migration 0018?)', err);
  }
  return json({ plans: (rows || []).map(planView) });
}

// GET /api/ballistics/fire-plans/:id — the order plus how far each gun and each
// target has got, which is what the page uses to keep the guns fed.
export async function getFirePlan(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const plan = await store.findFirePlanById(env, id);
  if (!plan) return json({ error: 'Firing order not found.' }, { status: 404 });
  const progress = await store.firePlanProgress(env, plan.id);
  return json({ plan: planView(plan), progress });
}

// POST /api/ballistics/fire-plans/:id/shots — append shots and fire any the
// guns can take right now.
export async function appendFirePlanShots(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;

  const plan = await store.findFirePlanById(env, id);
  if (!plan) return json({ error: 'Firing order not found.' }, { status: 404 });
  if (plan.state !== 'running') {
    return json({ error: 'This firing order is ' + plan.state + '.' }, { status: 409 });
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const allowed = new Set(parseJsonArray(plan.guns).map((g) => Number(g.cannonId)));
  const shots = [];
  for (const s of (Array.isArray(body.shots) ? body.shots : []).slice(0, 128)) {
    const cannonId = Math.round(Number(s && s.cannonId));
    if (!allowed.has(cannonId)) {
      return json({ error: 'Cannon ' + cannonId + ' is not part of this firing order.' }, { status: 400 });
    }
    const yaw = Number(s && s.yaw);
    const pitch = Number(s && s.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return json({ error: 'Cannon ' + cannonId + ': yaw and pitch must be numbers.' }, { status: 400 });
    }
    shots.push({ cannonId, yaw, pitch, targetKey: s && s.targetKey });
  }
  if (!shots.length) return json({ ok: true, queued: 0 });

  const ids = await store.appendPlanShots(env, plan.id, shots);
  return json({ ok: true, queued: ids.length });
}

// POST /api/ballistics/fire-plans/:id/state — { state: running | paused | stopped }
// Pausing holds the rest of the queue where it is; stopping throws it away and
// withdraws the shot each gun is holding but has not fired yet.
export async function setFirePlanState(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const state = FIRE_PLAN_STATES.includes(String(body.state)) ? String(body.state) : null;
  if (!state) return json({ error: 'state must be running, paused or stopped.' }, { status: 400 });

  const plan = await store.setFirePlanState(env, id, state);
  if (!plan) return json({ error: 'Firing order not found.' }, { status: 404 });
  const progress = await store.firePlanProgress(env, plan.id);
  return json({ ok: true, plan: planView(plan), progress });
}

// ════════════════════════════════════════════
//  Reload presets
//    Named reload mechanisms saved here so a Sublevel Cannon Computer can pull
//    the list at setup and pick one, instead of every operator typing timings
//    at the cannon. Read by the in-game setup menu over the open CC route, so
//    only non-sensitive fields are ever sent there.
// ════════════════════════════════════════════
function presetFields(body) {
  const fields = {};
  if (body.name !== undefined)       fields.name       = String(body.name).trim();
  if (body.kind !== undefined)       fields.kind       = body.kind === 'after' ? 'after' : 'between';
  if (body.reloadTime !== undefined) fields.reloadTime = Number(body.reloadTime);
  if (body.pulse !== undefined)      fields.pulse      = Number(body.pulse);
  if (body.notes !== undefined)      fields.notes      = String(body.notes);
  return fields;
}

// The name column is UNIQUE and that is the real guard; recognising it here
// turns a 500 into something an officer can act on.
function isDuplicateName(err) {
  return /UNIQUE/i.test(String((err && err.message) || ''));
}

// GET /api/ballistics/presets → { presets: [...] }
export async function listPresets(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  let rows = [];
  try {
    rows = await store.listReloadPresets(env);
  } catch (err) {
    console.warn('Could not list reload presets (run migration 0017?)', err);
  }
  return json({ presets: rows || [] });
}

// POST /api/ballistics/presets — save a new reload mechanism.
export async function createPreset(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = presetFields(body);
  if (!fields.name) return json({ error: 'Preset name cannot be empty.' }, { status: 400 });
  if (fields.name.length > 60) return json({ error: 'Preset name is too long (60 characters).' }, { status: 400 });

  try {
    return json(await store.insertReloadPreset(env, fields));
  } catch (err) {
    if (isDuplicateName(err)) {
      return json({ error: 'A preset called "' + fields.name + '" already exists.' }, { status: 409 });
    }
    console.warn('Could not save reload preset (run migration 0017?)', err);
    return json({ error: 'Could not save the preset — is migration 0017 applied?' }, { status: 500 });
  }
}

// PUT /api/ballistics/presets/:id — edit a saved reload mechanism.
export async function updatePreset(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const existing = await store.findReloadPresetById(env, id);
  if (!existing) return json({ error: 'Preset not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = presetFields(body);
  if (fields.name !== undefined && !fields.name) {
    return json({ error: 'Preset name cannot be empty.' }, { status: 400 });
  }
  if (fields.name !== undefined && fields.name.length > 60) {
    return json({ error: 'Preset name is too long (60 characters).' }, { status: 400 });
  }

  try {
    return json(await store.updateReloadPreset(env, id, fields));
  } catch (err) {
    if (isDuplicateName(err)) {
      return json({ error: 'A preset called "' + fields.name + '" already exists.' }, { status: 409 });
    }
    throw err;
  }
}

// DELETE /api/ballistics/presets/:id — remove a saved reload mechanism. Cannon
// computers that already used it keep the timings they were given, so removing
// one never changes a cannon that is already set up.
export async function deletePreset(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const existing = await store.findReloadPresetById(env, id);
  if (!existing) return json({ error: 'Preset not found.' }, { status: 404 });
  await store.deleteReloadPreset(env, id);
  return json({ ok: true });
}
