/* ============================================================
   Regnum Aeternum — Worker
   Ballistics: static cannon registry (web).

   All routes require a logged-in web account with the 'ballistics'
   or 'admin' role (same gate as the Ballistic Calculator page).
   ============================================================ */

import * as store from '../lib/store.js';
import * as attackScheduler from '../lib/attack-scheduler.js';
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

// The second, narrower clearance: the Secret Panel, the hidden registries and
// the scheduled attack plans. Admin holds it implicitly — an admin can grant
// themselves the role anyway, so pretending otherwise would only be theatre.
function isSecret(user) {
  return hasRole(user, 'ballistics-secret') || hasRole(user, 'admin');
}

async function requireSecret(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth;
  if (!isSecret(auth.user)) {
    return { error: json({ error: 'This panel requires the secret ordnance clearance.' }, { status: 403 }) };
  }
  return auth;
}

// A hidden entry is withheld from everyone without the secret clearance. The
// column only exists from migration 0023, and an absent column must read as
// "visible": on a database that predates it there is nothing being hidden.
function isHidden(row) {
  return Number(row && row.hidden) === 1;
}

function hideFrom(rows, canSeeHidden) {
  return canSeeHidden ? rows : rows.filter((r) => !isHidden(r));
}

// The registry rows carry `hidden` through to the page so the secret panel can
// draw its toggle, and so an officer who CAN see a hidden entry knows it is
// one. Booleans rather than 0/1 keep the page's checks readable.
function withHidden(row) {
  return { ...row, hidden: isHidden(row) };
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

  // Hidden cannons are withheld here and ONLY here: the CC bridge keeps polling
  // them by id, so an entry the secret panel has taken out of the registry goes
  // on being aimed and fired exactly as before.
  const visible = hideFrom(rows, isSecret(auth.user)).map(withHidden);

  return json({
    active:  visible.filter((r) => r.status === 'active' && !isManaged(r)),
    managed: visible.filter(isManaged),
    pending: visible.filter((r) => r.status === 'pending'),
  });
}

// GET /api/ballistics/towers → { towers: [...] }
// The GPS tower registry: every tower any cannon has reported hearing recently,
// with how often it has been seen and how often it had to be left out of a fix
// for not fitting the rest of the network. Towers are written from the CC poll,
// so this is a read-only view for the GPS Network tab.
//
// `excludedRecent`/`excludedAt` describe the CURRENT window (migration 0022)
// and are what the page warns on; `excluded` is the lifetime total and is only
// shown as history, because a tower left out once, long ago, is not a fault.
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
    // Recent-window figures. Absent columns (0022 not applied) simply read as
    // "nothing recent", which is the safe direction for a warning.
    excludedRecent: Number(t.excluded_recent) || 0,
    excludedAt:     t.excluded_at || null,
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

  // A hidden cannon is withheld from this listing too, and from the gun list of
  // the ship it is on: withholding the gun but not the ship would leak it, and
  // the ship's complement is part of what the clearance protects.
  const canSeeHidden = isSecret(auth.user);

  const byVehicle = new Map();
  for (const c of hideFrom(cannonRows || [], canSeeHidden)) {
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
      // Firing the vehicle means solving for each gun from its own mount, so the
      // calculator needs each gun's barrel length, resting facing and powder
      // count. `charges` is absent until migration 0021, which the page reads as
      // "use the default" rather than as zero.
      length:      Number(c.length),
      facing:      Number(c.facing),
      charges:     c.charges == null ? null : Number(c.charges),
      lastSeenAt:  c.last_seen_at,
    });
  }

  const shape = (v) => ({
    ...withHidden(v),
    cannons: byVehicle.get(Number(v.id)) || [],
  });

  const visible = hideFrom(rows || [], canSeeHidden);
  return json({
    active:  visible.filter((v) => v.status === 'active').map(shape),
    pending: visible.filter((v) => v.status !== 'active').map(shape),
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
  // Secret panel only — see the note on updateCannon.
  if (body.hidden !== undefined && isSecret(auth.user)) fields.hidden = !!body.hidden;

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
  if (body.charges !== undefined)  fields.charges  = Number(body.charges);
  // Hiding is the secret panel's, and only the secret panel's. Filtering the
  // flag here rather than rejecting the request keeps an ordinary edit — a
  // rename, a charges slider — working for a caller that merely echoed a row
  // back, while an unauthorised attempt to hide something simply does nothing.
  if (body.hidden !== undefined && isSecret(auth.user)) fields.hidden = !!body.hidden;

  // A name that is SENT may not be blank; a request that says nothing about the
  // name is an edit of something else — moving a charges slider must not be
  // rejected for failing to repeat the name it was not changing.
  if (fields.name !== undefined && !fields.name) {
    return json({ error: 'Cannon name cannot be empty.' }, { status: 400 });
  }

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
    // How the shots were worked out, so the live map can replay their flight.
    // Undefined until migration 0019 is applied, which simply reads as "unknown
    // launch parameters" — the map then draws the aim without the shell.
    drag:       plan.drag == null ? null : Number(plan.drag),
    charges:    plan.charges == null ? null : Number(plan.charges),
    trajectory: plan.trajectory || null,
    // Multi-Target's share-versus-every-gun choice. Absent (0024 outstanding)
    // reads as false, which is the shared queue the page used before it existed.
    unsynced:   Number(plan.unsynced) === 1,
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

// Targets arrive as loose objects from two different pages (the calculator's
// queue and the secret panel's plan creator), so the shape is normalised in one
// place: a key that is stable enough to count against, a Y that defaults to sea
// level, and every field bounded so a rogue label cannot grow a row.
function parsePlanTargets(raw) {
  const out = [];
  for (const t of (Array.isArray(raw) ? raw : []).slice(0, 200)) {
    const x = Number(t && t.x);
    const z = Number(t && t.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const y = Number.isFinite(Number(t && t.y)) ? Number(t.y) : 64;
    const key = String((t && t.key) || (x + ',' + y + ',' + z)).slice(0, 48);
    out.push({ key, x, y, z, label: String((t && t.label) || key).slice(0, 60) });
  }
  return out;
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

  // Multi-Target only: fire at every target with every gun rather than splitting
  // the queue. Stored on the order because it changes what the queue means, and
  // the server side of a scheduled attack has nobody to ask.
  const unsynced = mode === 'multi' && !!body.unsynced;

  const resolved = await resolvePlanGuns(env, body.guns);
  if (resolved.error) return json({ error: resolved.error }, { status: 400 });

  // Targets are kept so a reloaded page can carry on with the same order. They
  // are never used to aim: every shot arrives with its own yaw and pitch. A
  // scheduled attack is the exception the shape was chosen for — it works its
  // aim out server-side, from these very coordinates.
  const targets = parsePlanTargets(body.targets);
  if (!targets.length) return json({ error: 'A firing order needs at least one target.' }, { status: 400 });

  // The launch parameters the operator's page solved with. Frozen here rather
  // than taken from the page at draw time, so every officer looking at the order
  // replays the same flight whatever their own sliders say.
  const drag = Number(body.drag);
  const charges = Number(body.charges);

  try {
    const plan = await store.insertFirePlan(env, {
      mode,
      // Normal carries a pass count too (0023's arithmetic is the same as
      // Constant's, minus the waiting): the order fires each gun that many times
      // and then closes itself, where Constant runs until it is stopped.
      // Constant is the one mode with no count — it is open-ended by definition.
      cycles: mode === 'constant'
        ? 1
        : Math.max(1, Math.min(999, Math.round(Number(body.cycles) || 1))),
      targets,
      guns: resolved.guns,
      crew: auth.user && auth.user.username,
      drag: Number.isFinite(drag) && drag > 0 && drag <= 1 ? drag : null,
      charges: Number.isFinite(charges) && charges > 0 ? Math.min(99, Math.round(charges)) : null,
      trajectory: body.trajectory === 'direct' ? 'direct' : 'optimal',
      unsynced: unsynced,
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

// GET /api/ballistics/fire-plans/history — the firing orders that have ended,
// with what each gun actually fired and at which target. Abandoned orders are
// swept into the log first, so closing the tab on a run lands it here instead of
// leaving it live for ever.
export async function listFirePlanHistory(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  await store.sweepStaleFirePlans(env);
  const limit = new URL(request.url).searchParams.get('limit');
  return json({ orders: await store.listFirePlanHistory(env, limit) });
}

// GET /api/ballistics/fire-plans/:id — the order plus how far each gun and each
// target has got, which is what the page uses to keep the guns fed.
export async function getFirePlan(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const plan = await store.findFirePlanById(env, id);
  if (!plan) return json({ error: 'Firing order not found.' }, { status: 404 });
  const progress = await store.firePlanProgress(env, plan.id);
  // The shot each gun is on, so the live map can draw the trajectory being
  // fired and time the shell against the moment the cannon reports it fired.
  const shots = await store.listPlanCurrentShots(env, plan.id);
  return json({ plan: planView(plan), progress, shots });
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
    // The powder count this shot was solved with, kept on the shot: one order
    // can fire guns loaded differently, and the map replays each flight from it.
    const charges = Math.round(Number(s && s.charges));
    shots.push({
      cannonId, yaw, pitch, targetKey: s && s.targetKey,
      charges: Number.isFinite(charges) && charges > 0 ? Math.min(99, charges) : undefined,
    });
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

// ════════════════════════════════════════════
//  Named targets
//    A place with a name, so it can be picked off a list rather than retyped:
//    the Calculator's "select a target" dropdown for Normal and Constant, the
//    tickbox list that fills the Multi-Target queue, and the scheduled attack
//    plans, which have no page to read coordinates off.
//
//    Targets are shared, like every other registry here — an officer naming a
//    battery is giving the name to everyone with clearance. `hidden` (migration
//    0023) is the exception: a hidden target is withheld from every reader
//    without the 'ballistics-secret' role, and the filtering happens here rather
//    than in the page, so the coordinates never reach an unentitled client.
// ════════════════════════════════════════════

function targetView(t) {
  return {
    id:        Number(t.id),
    name:      t.name || '',
    x:         Number(t.x),
    y:         Number(t.y),
    z:         Number(t.z),
    hidden:    isHidden(t),
    createdBy: t.created_by || null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

// A target name is the whole point of the registry, so it is required — but it
// need not be unique: an officer may well want "Bridge" and "Bridge (east)",
// and refusing a duplicate name would be refusing to let them think in their own
// terms. The map is what distinguishes them.
function targetFields(body) {
  const fields = {};
  if (body.name !== undefined)   fields.name = String(body.name).trim().slice(0, 80);
  if (body.x !== undefined)      fields.x = Number(body.x);
  if (body.y !== undefined)      fields.y = Number(body.y);
  if (body.z !== undefined)      fields.z = Number(body.z);
  if (body.hidden !== undefined) fields.hidden = !!body.hidden;
  return fields;
}

// GET /api/ballistics/targets → { targets: [...] }
export async function listTargets(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  let rows = [];
  try {
    rows = await store.listTargets(env);
  } catch (err) {
    // Telemetry-adjacent: an unapplied migration reads as "no targets yet" and
    // must not take the calculator down with it.
    console.warn('Could not list targets (run migration 0023?)', err);
  }
  return json({ targets: hideFrom(rows || [], isSecret(auth.user)).map(targetView) });
}

// POST /api/ballistics/targets — name a new target.
export async function createTarget(request, env) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = targetFields(body);
  if (!fields.name) return json({ error: 'Give the target a name.' }, { status: 400 });
  if (!Number.isFinite(fields.x) || !Number.isFinite(fields.z)) {
    return json({ error: 'A target needs an X and a Z.' }, { status: 400 });
  }
  // Only the secret panel may create a target already hidden; an ordinary officer
  // creating one gets it public, whatever the request says.
  if (fields.hidden && !isSecret(auth.user)) delete fields.hidden;

  try {
    const target = await store.insertTarget(env, {
      ...fields, createdBy: auth.user && auth.user.username,
    });
    return json({ ok: true, target: targetView(target) });
  } catch (err) {
    console.warn('Could not save target (run migration 0023?)', err);
    return json({ error: 'Could not save the target — is migration 0023 applied?' }, { status: 500 });
  }
}

// PUT /api/ballistics/targets/:id — rename / move / hide. See updateCannon for
// why an unauthorised `hidden` is dropped rather than rejected.
export async function updateTarget(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const existing = await store.findTargetById(env, id);
  if (!existing) return json({ error: 'Target not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = targetFields(body);
  if (fields.name !== undefined && !fields.name) {
    return json({ error: 'Target name cannot be empty.' }, { status: 400 });
  }
  if (fields.hidden !== undefined && !isSecret(auth.user)) delete fields.hidden;

  return json({ ok: true, target: targetView(await store.updateTarget(env, id, fields)) });
}

// DELETE /api/ballistics/targets/:id — forget a named place. Orders already
// fired keep their own copy of the coordinates, so the log is unaffected.
export async function deleteTarget(request, env, id) {
  const auth = await requireBallistics(request, env);
  if (auth.error) return auth.error;
  const existing = await store.findTargetById(env, id);
  if (!existing) return json({ error: 'Target not found.' }, { status: 404 });
  await store.deleteTarget(env, id);
  return json({ ok: true });
}

// ════════════════════════════════════════════
//  Scheduled attack plans (Secret Panel)
//    Standing orders that fire themselves. Everything here needs the
//    'ballistics-secret' clearance, which is also what decides who may see the
//    hidden registries they are usually aimed from.
//
//    The firing itself is in worker/lib/attack-scheduler.js — shared with the
//    cron, so the button and the clock take exactly the same path.
// ════════════════════════════════════════════

function attackPlanView(plan, progress) {
  return {
    id:          Number(plan.id),
    name:        plan.name || '',
    mode:        plan.mode,
    cycles:      Number(plan.cycles),
    targets:     parseJsonArray(plan.targets),
    guns:        parseJsonArray(plan.guns),
    trajectory:  plan.trajectory || null,
    drag:        plan.drag == null ? null : Number(plan.drag),
    charges:     plan.charges == null ? null : Number(plan.charges),
    unsynced:    Number(plan.unsynced) === 1,
    scheduledAt: plan.scheduled_at || '',
    state:       plan.state,
    firePlanId:  plan.fire_plan_id == null ? null : Number(plan.fire_plan_id),
    createdBy:   plan.created_by || null,
    launchedAt:  plan.launched_at || null,
    createdAt:   plan.created_at,
    updatedAt:   plan.updated_at,
    // What each gun has actually been given, on the live order this plan opened.
    // Absent while the plan is still waiting for its moment.
    progress:    progress || null,
  };
}

// How far a launched plan has got. A read failure is not worth failing the whole
// listing over — the plan's own row is still true and still useful.
async function attackProgress(env, plan) {
  if (!plan || plan.fire_plan_id == null || plan.state !== 'running') return null;
  try {
    const fire = await store.findFirePlanById(env, plan.fire_plan_id);
    if (!fire) return null;
    const progress = await store.firePlanProgress(env, plan.fire_plan_id);
    return { state: fire.state, mode: fire.mode, cycles: Number(fire.cycles), guns: progress.guns, targets: progress.targets };
  } catch (err) {
    console.warn('Could not read scheduled attack progress', err);
    return null;
  }
}

// GET /api/ballistics/attack-plans → { plans: [...] }
export async function listAttackPlans(request, env) {
  const auth = await requireSecret(request, env);
  if (auth.error) return auth.error;
  let rows = [];
  try {
    rows = await store.listAttackPlans(env);
  } catch (err) {
    console.warn('Could not list attack plans (run migration 0024?)', err);
  }
  const plans = [];
  for (const plan of rows || []) plans.push(attackPlanView(plan, await attackProgress(env, plan)));
  return json({ plans });
}

// POST /api/ballistics/attack-plans — write a standing order.
export async function createAttackPlan(request, env) {
  const auth = await requireSecret(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return json({ error: 'Give the attack plan a name.' }, { status: 400 });

  const mode = FIRE_MODES.includes(String(body.mode)) ? String(body.mode) : null;
  if (!mode) return json({ error: 'mode must be normal, constant or multi.' }, { status: 400 });

  const when = Date.parse(String(body.scheduledAt || ''));
  if (!Number.isFinite(when)) {
    return json({ error: 'Give the plan a date and time to fire at.' }, { status: 400 });
  }

  const targets = parsePlanTargets(body.targets);
  if (!targets.length) return json({ error: 'A plan needs at least one target.' }, { status: 400 });

  // Guns are resolved against the registry now, at the moment the plan is
  // written: a plan that names a cannon which is not an accepted cannon is a
  // mistake worth catching while an officer is looking at the screen, not at
  // four in the morning when it comes due.
  const resolved = await resolvePlanGuns(env, body.guns);
  if (resolved.error) return json({ error: resolved.error }, { status: 400 });

  const drag = Number(body.drag);
  const charges = Number(body.charges);

  try {
    const plan = await store.insertAttackPlan(env, {
      name,
      mode,
      cycles: mode === 'constant' ? 1 : Math.max(1, Math.min(999, Math.round(Number(body.cycles) || 1))),
      targets,
      guns: resolved.guns,
      trajectory: body.trajectory === 'direct' ? 'direct' : 'optimal',
      drag: Number.isFinite(drag) && drag > 0 && drag <= 1 ? drag : null,
      charges: Number.isFinite(charges) && charges > 0 ? Math.min(99, Math.round(charges)) : null,
      unsynced: mode === 'multi' && !!body.unsynced,
      scheduledAt: new Date(when).toISOString(),
      createdBy: auth.user && auth.user.username,
    });
    return json({ ok: true, plan: attackPlanView(plan, null) });
  } catch (err) {
    console.warn('Could not save attack plan (run migration 0024?)', err);
    return json({ error: 'Could not save the attack plan — is migration 0024 applied?' }, { status: 500 });
  }
}

// PUT /api/ballistics/attack-plans/:id — edit a plan that has not fired yet.
export async function updateAttackPlan(request, env, id) {
  const auth = await requireSecret(request, env);
  if (auth.error) return auth.error;
  const existing = await store.findAttackPlanById(env, id);
  if (!existing) return json({ error: 'Attack plan not found.' }, { status: 404 });
  if (existing.state !== 'scheduled') {
    return json({ error: 'This plan has already been fired or called off.' }, { status: 409 });
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = {};
  if (body.name !== undefined) {
    fields.name = String(body.name).trim().slice(0, 80);
    if (!fields.name) return json({ error: 'Plan name cannot be empty.' }, { status: 400 });
  }
  if (body.mode !== undefined) {
    fields.mode = FIRE_MODES.includes(String(body.mode)) ? String(body.mode) : null;
    if (!fields.mode) return json({ error: 'mode must be normal, constant or multi.' }, { status: 400 });
  }
  if (body.cycles !== undefined) {
    fields.cycles = Math.max(1, Math.min(999, Math.round(Number(body.cycles) || 1)));
  }
  if (body.targets !== undefined) {
    fields.targets = parsePlanTargets(body.targets);
    if (!fields.targets.length) return json({ error: 'A plan needs at least one target.' }, { status: 400 });
  }
  if (body.guns !== undefined) {
    const resolved = await resolvePlanGuns(env, body.guns);
    if (resolved.error) return json({ error: resolved.error }, { status: 400 });
    fields.guns = resolved.guns;
  }
  if (body.trajectory !== undefined) fields.trajectory = body.trajectory === 'direct' ? 'direct' : 'optimal';
  if (body.drag !== undefined)     fields.drag = Number(body.drag);
  if (body.charges !== undefined)  fields.charges = Number(body.charges);
  if (body.unsynced !== undefined) fields.unsynced = !!body.unsynced;
  if (body.scheduledAt !== undefined) {
    const when = Date.parse(String(body.scheduledAt));
    if (!Number.isFinite(when)) return json({ error: 'That is not a valid date and time.' }, { status: 400 });
    fields.scheduledAt = new Date(when).toISOString();
  }

  const plan = await store.updateAttackPlan(env, id, fields);
  return json({ ok: true, plan: attackPlanView(plan, null) });
}

// POST /api/ballistics/attack-plans/:id/launch — open fire early.
// The cron fires plans when their moment arrives; this is the officer's hand on
// the same trigger, so an attack does not have to be re-written to be brought
// forward.
export async function launchAttackPlan(request, env, id) {
  const auth = await requireSecret(request, env);
  if (auth.error) return auth.error;
  const plan = await store.findAttackPlanById(env, id);
  if (!plan) return json({ error: 'Attack plan not found.' }, { status: 404 });

  const res = await attackScheduler.launchAttackPlan(env, plan);
  if (res.error) return json({ error: res.error }, { status: 400 });
  return json({ ok: true, plan: attackPlanView(res.attack, await attackProgress(env, res.attack)) });
}

// POST /api/ballistics/attack-plans/:id/cancel — call it off. A plan that has not
// fired becomes 'cancelled'; one already firing is stopped like any other order,
// which withdraws the round each gun is holding rather than letting it fly.
export async function cancelAttackPlan(request, env, id) {
  const auth = await requireSecret(request, env);
  if (auth.error) return auth.error;
  const plan = await store.findAttackPlanById(env, id);
  if (!plan) return json({ error: 'Attack plan not found.' }, { status: 404 });
  const updated = await attackScheduler.cancelAttackPlan(env, plan);
  return json({ ok: true, plan: attackPlanView(updated, null) });
}

// DELETE /api/ballistics/attack-plans/:id — remove a plan from the list. A plan
// that is still firing is refused: stop it first, so the record keeps the order
// it opened rather than losing it to a tidy-up.
export async function deleteAttackPlan(request, env, id) {
  const auth = await requireSecret(request, env);
  if (auth.error) return auth.error;
  const plan = await store.findAttackPlanById(env, id);
  if (!plan) return json({ error: 'Attack plan not found.' }, { status: 404 });
  if (plan.state === 'running') {
    return json({ error: 'Stop this plan before deleting it.' }, { status: 409 });
  }
  await store.deleteAttackPlan(env, id);
  return json({ ok: true });
}
