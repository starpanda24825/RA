/* ============================================================
   Regnum Aeternum — Worker
   Ballistics: ComputerCraft cannon bridge (static + sublevel).

   Open self-registration: an in-game computer pings one endpoint
   with its cannon's details and current state, and receives any
   queued fire command in the same response. No CC token required —
   instead the computer identifies itself with a stable computer id
   (os.getComputerID(), or a persisted UUID). Requests stay
   'pending' until accepted on the website's Cannon Registry tab.

   Sublevel (mobile) cannons additionally keep refreshing their
   x/y/z from gps.locate() on every poll, so their map dot tracks
   the cannon as it moves.

   Fire command shape returned to the computer:
     { sequence, yaw, pitch, fire }
   The computer executes the documented sequence
   (disassemble → assemble → aim → fire → disassemble) and acks by
   sending `sequence` back on a later poll.
   ============================================================ */

import * as store from '../lib/store.js';

function ccJson(success, response, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify({ success, response }), { ...init, headers });
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampLength(v) {
  const n = Math.round(num(v, 4));
  return Math.max(1, Math.min(64, n));
}

// GPS health is a status snapshot the computer sends with each poll. Everything
// is coerced and capped: this is an open (token-free) endpoint, so nothing it
// carries can be trusted for anything but display.
function sanitiseGpsReport(g) {
  const report = { ok: g.ok === true };
  if (g.quality != null) report.quality = String(g.quality).slice(0, 24);
  if (g.reason != null) report.reason = String(g.reason).slice(0, 160);
  if (g.stale != null) report.stale = g.stale === true;
  for (const k of ['dop', 'residual', 'age']) {
    const n = Number(g[k]);
    if (Number.isFinite(n)) report[k] = Math.round(n * 1000) / 1000;
  }
  for (const k of ['towers', 'seen']) {
    const n = Number(g[k]);
    if (Number.isFinite(n)) report[k] = Math.round(n);
  }
  const skew = Number(g.shipSkew);
  if (Number.isFinite(skew)) report.shipSkew = Math.round(skew * 1000) / 1000;
  if (Array.isArray(g.excluded)) {
    report.excluded = g.excluded.slice(0, 16).map((e) => String(e).slice(0, 40));
  }
  return report;
}

// A tower list is only sent when it changes, so it is small in practice.
function sanitiseTowerList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const t of list.slice(0, 64)) {
    const x = Math.round(Number(t && t.x));
    const y = Math.round(Number(t && t.y));
    const z = Math.round(Number(t && t.z));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const key = `${x},${y},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x, y, z });
  }
  return out;
}

// POST /api/ballistics/cc/poll
// Body: {
//   computerId, x, y, z, length, facing, sublevel, message,
//   yaw, pitch, sequence (last executed command sequence)
// }
export async function ccPoll(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return ccJson(false, 'Invalid body.'); }

  const computerId = String(body.computerId || '').trim().slice(0, 64);
  if (!computerId) return ccJson(false, 'computerId required.');

  const x       = num(body.x, 0);
  const y       = num(body.y, 0);
  const z       = num(body.z, 0);
  // Sublevel (mobile) cannons measure their position with gps.locate() and
  // set gpsOk only once they've actually obtained a fix. Until then their
  // reported x/y/z are the meaningless 0 fallback, so we must not let them
  // overwrite the stored coordinates — otherwise the map dot jumps to origin.
  const gpsOk   = body.gpsOk === true;
  // Sublevel cannons report their ship's heading (from the front + stern
  // GPS pair) so the calculator can show and account for ship orientation.
  const shipYaw = body.shipYaw == null ? null : num(body.shipYaw, null);
  const length  = clampLength(body.length);
  const facing  = num(body.facing, 0);
  const sublevel = body.sublevel ? 1 : 0;
  const message = String(body.message || '').slice(0, 200);

  let cannon = await store.findCannonByComputerId(env, computerId);
  if (!cannon) {
    cannon = await store.insertCannon(env, { computerId, x, y, z, length, facing, sublevel, message, shipYaw });
  } else if (cannon.status === 'pending' || Number(cannon.sublevel) === 1) {
    // Pending requests and sublevel (mobile) cannons keep their reported
    // coordinates fresh on every ping; accepted static cannons do not,
    // so a website-side coordinate edit is never overwritten.
    //
    // A sublevel cannon with no GPS fix yet must not overwrite its stored
    // position with the 0 fallback — keep the last known (or officer-edited)
    // coordinates instead.
    const useReported = Number(cannon.sublevel) !== 1 || gpsOk;
    cannon = await store.refreshCannonFromComputer(env, cannon.id, {
      x: useReported ? x : cannon.x,
      y: useReported ? y : cannon.y,
      z: useReported ? z : cannon.z,
      length, facing, sublevel, message, shipYaw,
    });
  }

  // Report the current aim state (heartbeat) regardless of status.
  cannon = await store.heartbeatCannon(env, cannon.id, { yaw: num(body.yaw, 0), pitch: num(body.pitch, 0) });

  // GPS network health, piggy-backed on this poll. The position itself is
  // solved entirely on the computer — not a single distance is sent here — so
  // server load does not grow with the number of receivers or towers. What we
  // keep is the state of the network, for the GPS Network tab of the
  // calculator. The tower list only arrives when it changes.
  //
  // This is telemetry and must never be fatal: if the migration has not been
  // applied or D1 hiccups, the cannon still has to receive its commands, so
  // any failure here is logged and swallowed.
  if (body.gps && typeof body.gps === 'object') {
    try {
      const report = sanitiseGpsReport(body.gps);
      await store.recordGpsReport(env, cannon.id, report);
      const towerList = sanitiseTowerList(body.gps.towerList);
      if (towerList && towerList.length) {
        await store.recordGpsTowers(env, towerList, computerId, report.excluded);
      }
    } catch (err) {
      console.warn('CC poll: GPS report not stored (run migration 0015?)', err);
    }
  }

  // Acknowledge the last command the computer says it executed.
  const ack = Math.round(num(body.sequence, 0));
  if (ack > 0) await store.ackCannonCommand(env, cannon.id, ack);

  // Does a Sublevel Vehicle Computer own this cannon? Only an ACCEPTED vehicle
  // may take a cannon over: a pending one leaves its cannons running
  // standalone, so a registration request can never disarm a working cannon.
  //
  // `vehicle_id` is undefined until migration 0016 is applied, which simply
  // reads as "no vehicle" — the cannon bridge keeps working without it.
  let vehicle = null;
  if (cannon.vehicle_id != null) {
    const v = await store.findVehicleById(env, cannon.vehicle_id);
    if (v && v.status === 'active') {
      vehicle = { id: v.id, name: v.name || ('Vehicle ' + v.id), computerId: v.computer_id };
    }
  }

  // Deliver a queued command, if any. A cannon owned by a vehicle is NOT given
  // the command: its vehicle assigns the final aim itself (see ccVehiclePoll),
  // and withholding it here means a managed cannon has exactly one possible
  // path to firing.
  let command = null;
  if (!vehicle && cannon.status === 'active' &&
      Number(cannon.command_sequence) > 0 &&
      Number(cannon.acked_sequence) < Number(cannon.command_sequence)) {
    command = {
      sequence: Number(cannon.command_sequence),
      yaw:      Number(cannon.command_yaw),
      pitch:    Number(cannon.command_pitch),
      fire:     !!cannon.command_fire,
    };
  }

  return ccJson(true, {
    status: cannon.status,
    id:     cannon.id,
    name:   cannon.name,
    command,
    vehicle,
  });
}

// POST /api/ballistics/cc/vehicle/poll
// Body: {
//   computerId, shipYaw, message,
//   cannons: [ { id, sequence, x, y, z, gpsOk, yaw, pitch } ]
// }
//
// The Sublevel Vehicle Computer is the single brain of a sublevel ship. It
// holds the ship's heading derived from the two GPS beacons, and it is the only
// thing that hands a cannon an aim. In one request it:
//
//   * registers itself (pending until an officer accepts it),
//   * reports the heading it is holding, and each cannons' live position and
//     aim state, on the cannons' behalf (so a managed cannon needs no poll of
//     its own to keep the map and the registry fresh),
//   * acks the commands it has already assigned to its cannons, and
//   * collects each assigned cannon's queued command to assign next.
//
// A cannon is only ever trusted from a vehicle it is actually assigned to, so
// one vehicle can never aim another's guns.
export async function ccVehiclePoll(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return ccJson(false, 'Invalid body.'); }

  const computerId = String(body.computerId || '').trim().slice(0, 64);
  if (!computerId) return ccJson(false, 'computerId required.');

  const shipYaw = body.shipYaw == null ? null : num(body.shipYaw, null);
  const message = String(body.message || '').slice(0, 200);

  let vehicle;
  try {
    vehicle = await store.findVehicleByComputerId(env, computerId);
    if (!vehicle) {
      vehicle = await store.insertVehicle(env, { computerId, message, shipYaw });
    } else {
      vehicle = await store.refreshVehicleFromComputer(env, vehicle.id, { message, shipYaw });
    }
  } catch (err) {
    console.warn('CC vehicle poll: registry unavailable (run migration 0016?)', err);
    return ccJson(false, 'Vehicle registry unavailable — apply migration 0016.');
  }

  const cannons = await store.listCannonsByVehicle(env, vehicle.id);
  const byId = new Map((cannons || []).map((c) => [Number(c.id), c]));

  // Reports + acks for this vehicle's own cannons only.
  if (Array.isArray(body.cannons)) {
    for (const report of body.cannons.slice(0, 32)) {
      const id = Math.round(num(report && report.id, 0));
      const cannon = byId.get(id);
      if (!cannon) continue;
      try {
        await store.updateCannonTelemetry(env, id, {
          x: num(report.x, cannon.x),
          y: num(report.y, cannon.y),
          z: num(report.z, cannon.z),
          gpsOk: report.gpsOk === true,
          yaw: num(report.yaw, 0),
          pitch: num(report.pitch, 0),
        });
        const ack = Math.round(num(report.sequence, 0));
        if (ack > 0) await store.ackCannonCommand(env, id, ack);
      } catch (err) {
        console.warn('CC vehicle poll: cannon report failed for', id, err);
      }
    }
  }

  // A pending vehicle gets nothing to aim: it is only told its own status.
  const payload = (cannons || []).map((c) => {
    const entry = {
      id:         Number(c.id),
      name:       c.name || ('Cannon ' + c.id),
      computerId: c.computer_id,
      x:          Number(c.x),
      y:          Number(c.y),
      z:          Number(c.z),
      length:     Number(c.length),
      facing:     Number(c.facing),
      command:    null,
    };
    if (vehicle.status === 'active' && c.status === 'active' &&
        Number(c.command_sequence) > 0 &&
        Number(c.acked_sequence) < Number(c.command_sequence)) {
      entry.command = {
        sequence: Number(c.command_sequence),
        yaw:      Number(c.command_yaw),
        pitch:    Number(c.command_pitch),
        fire:     !!c.command_fire,
      };
    }
    return entry;
  });

  return ccJson(true, {
    status: vehicle.status,
    id:     vehicle.id,
    name:   vehicle.name,
    cannons: vehicle.status === 'active' ? payload : [],
  });
}

// GET /api/ballistics/cc/cannons
// Public registry list for the in-game Sublevel Ship GPS program, which uses
// it to let the operator assign a front/back beacon to a specific cannon.
// Same open model as ccPoll — no auth (the CC bridge has no token), so only
// non-sensitive registry fields are returned.
export async function ccCannons(request, env) {
  const rows = await store.listCannons(env);
  const cannons = (rows || []).map((c) => ({
    id:         c.id,
    computerId: c.computer_id,
    name:       c.name || ('Cannon ' + c.id),
    sublevel:   Number(c.sublevel) === 1,
    status:     c.status,
    shipYaw:    c.ship_yaw == null ? null : Number(c.ship_yaw),
    // Which vehicle owns it, so the Ship GPS screen can say so — a cannon on a
    // vehicle is normally reached by assigning the beacons to the vehicle.
    // Undefined until migration 0016 is applied, which reads as "no vehicle".
    vehicleId:  c.vehicle_id == null ? null : Number(c.vehicle_id),
  }));
  return ccJson(true, { cannons });
}

// GET /api/ballistics/cc/vehicles
// Public vehicle list for the in-game Sublevel Ship GPS program, so a ship's
// front/back beacons can be assigned to the vehicle that coordinates its
// cannons rather than to one arbitrary cannon standing in for the ship.
// Same open model as ccCannons.
export async function ccVehicles(request, env) {
  // A sublevel ship whose vehicle registry has not been created yet (0016 not
  // applied) simply reports no vehicles, so the Ship GPS screen falls back to
  // listing cannons alone rather than failing.
  let rows = [];
  try {
    rows = await store.listVehicles(env);
  } catch (err) {
    console.warn('CC vehicles: registry unavailable (run migration 0016?)', err);
  }
  const vehicles = (rows || []).map((v) => ({
    id:         v.id,
    computerId: v.computer_id,
    name:       v.name || ('Vehicle ' + v.id),
    status:     v.status,
    shipYaw:    v.ship_yaw == null ? null : Number(v.ship_yaw),
  }));
  return ccJson(true, { vehicles });
}
