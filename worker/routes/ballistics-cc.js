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

  // Acknowledge the last command the computer says it executed.
  const ack = Math.round(num(body.sequence, 0));
  if (ack > 0) await store.ackCannonCommand(env, cannon.id, ack);

  // Deliver a queued command, if any.
  let command = null;
  if (cannon.status === 'active' &&
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
    name:   cannon.name,
    command,
  });
}
