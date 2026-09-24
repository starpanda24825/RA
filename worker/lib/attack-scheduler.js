/* ============================================================
   Regnum Aeternum — Worker
   Scheduled attack plans.

   A standing order fires with nobody at a screen: the guns, the
   targets, the mode and the moment are all stored (migration 0024),
   and this module is what turns that row into shots actually queued
   at the cannons.

   It is the server-side twin of the calculator's scheduler
   (bombardTick() in regnum-aeternum/ballistics/index.html). The shape
   of the work is deliberately the same — read how far the order has
   got, give every gun that is not offline its next shot, decide
   whether anything is left — so that a barrage fired by the clock and
   one fired by a button behave identically. What differs is the
   aiming: a closed page cannot solve a trajectory, so the Worker
   solves it instead (worker/lib/ballistics-solver.js), against
   whatever each gun last reported as its position.

   Launching does NOT invent a second firing machine. The plan opens a
   row in ballistics_fire_plans and points `fire_plan_id` at it, so the
   shots drain through the ordinary queue, one per cannon ack, and the
   order lands in the Firing Log like any other.
   ============================================================ */

import * as store from './store.js';
import { solveShot, clampCharges } from './ballistics-solver.js';

// How many shots to keep waiting at each gun. The page uses 2 because it tops
// up once a second; the cron runs far less often, so an unattended order has to
// carry enough queued to keep firing through the gap. Shots are only ever
// DELIVERED one at a time, as each cannon acks the previous one, so a deep queue
// costs rows and nothing else — it cannot fire a gun out of turn.
const LOOKAHEAD = 40;

// One pass is bounded so a wide plan cannot run away with a cron invocation.
const MAX_SHOTS_PER_PASS = 240;

// Constant has no end by definition. An unattended one has to have SOME end, or
// a plan nobody is watching would refill its own queue for ever, so a scheduled
// Constant barrage stops itself after this many shots per gun.
const MAX_CONSTANT_SHOTS_PER_GUN = 200;

// A gun is only given work if it has checked in recently — the same window the
// store uses before it hands a shot over (PROMOTE_FRESH_MS). Queueing at a
// battery that is switched off would only stack up rows that fire the instant it
// reconnects, aimed from where it used to be.
const FRESH_MS = 30000;

// A battery that has stopped reporting cannot drain: a shot only leaves the
// queue when a cannon acks it, so if EVERY gun an order names has gone quiet its
// remaining shots are stuck there for ever. Thirty seconds of silence is a blip,
// already tolerated by the freshness check above; this is the much longer window
// that says the battery is GONE rather than merely slow, after which the order
// withdraws what is left instead of holding it. Set with an ATTACK_SILENCE_MS
// var; ten minutes by default, which is twenty cron passes.
const DEFAULT_SILENCE_MS = 10 * 60 * 1000;

function silenceMs(env) {
  const n = Number(env && env.ATTACK_SILENCE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SILENCE_MS;
}

// What the Secret Panel shows for an order that stopped because its battery went
// dark. Kept next to the decision that uses it, so the note and the action
// cannot drift apart.
const SILENCE_REASON = 'Stopped — every gun in this order had stopped reporting, so its remaining shots were withdrawn.';

// Is every gun the order names silent — or gone — for longer than the window?
// `anyLive` is whether even one of them is still an accepted cannon; a plan
// whose whole battery has been deleted can never fire either.
function allSilent(anyLive, newestSeen, ms) {
  if (!anyLive) return true;                     // nothing left that could fire them
  if (!Number.isFinite(newestSeen)) return true; // not one of them ever reported
  return Date.now() - newestSeen > ms;
}

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function isFresh(lastSeenAt) {
  const seen = Date.parse(lastSeenAt || '');
  return Number.isFinite(seen) && Date.now() - seen <= FRESH_MS;
}

// A gun as the solver needs it: where it is now, how long its barrel is, and how
// much powder is in the tube. The position is read from the cannon row on every
// pass rather than from the plan, because a sublevel gun — and the ship carrying
// it — can be driven somewhere else while the order waits. That is the whole
// reason the server aims at solve time instead of storing pre-solved shots.
function gunForSolver(row, plan) {
  return {
    cannonId: Number(row.id),
    name: row.name || ('Cannon ' + row.id),
    x: Number(row.x), y: Number(row.y), z: Number(row.z),
    length: Number(row.length) || 4,
    // The gun's own load wins; the order's recorded count stands in for a
    // database that predates migration 0021.
    charges: clampCharges(row.charges != null ? row.charges : plan.charges),
  };
}

function shotOf(gun, sol, targetKey) {
  return {
    cannonId: gun.cannonId,
    yaw: sol.yaw,
    pitch: sol.pitch,
    targetKey: targetKey,
    charges: gun.charges,
  };
}

/**
 * The next shot for one gun, decided by the mode exactly as the page decides it:
 *
 *   normal   — cycles shots each, then that gun is finished. It stops on its own
 *              where Constant waits, which is the only difference between them.
 *   constant — the same aim, over and over, until stopped.
 *   multi    — the target with the most passes still outstanding that this gun
 *              can reach, nearest first on a tie. That is what keeps two guns off
 *              the same target while there is work to spread.
 *   multi + unsynced — the other intention: every gun fires at every target, once
 *              per cycle, each gun working through the list in its own order.
 *
 * `mine` is how many shots this gun has been given in total, which is what the
 * unsynced rotation and the normal pass count are counted against.
 */
function pickShot(gun, opts) {
  const { mode, cycles, targets, trajectory, drag, unsynced, mine, targetsAssigned } = opts;
  if (!targets.length) return null;

  const solve = (t) => {
    const sol = solveShot(gun, t, trajectory, drag);
    return sol ? { shot: shotOf(gun, sol, t.key), targetKey: t.key } : null;
  };

  if (mode === 'normal') {
    if (mine >= cycles) return null;
    return solve(targets[0]);
  }

  if (mode === 'constant') {
    if (mine >= MAX_CONSTANT_SHOTS_PER_GUN) return null;
    return solve(targets[0]);
  }

  if (unsynced) {
    if (mine >= targets.length * cycles) return null;
    // This gun's own place in the rotation. A target it cannot reach is skipped
    // rather than stalling the gun: the plan's targets were checked against the
    // guns when it was written, but a gun can be moved out of range afterwards.
    const start = mine % targets.length;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[(start + i) % targets.length];
      const hit = solve(t);
      if (hit) return hit;
    }
    return null;
  }

  let best = null, bestLeft = 0, bestDist = Infinity;
  for (const t of targets) {
    const left = cycles - (targetsAssigned[t.key] || 0);
    if (left <= 0) continue;
    const hit = solve(t);
    if (!hit) continue;                       // out of this gun's range
    const dist = Math.hypot(t.x - gun.x, t.z - gun.z);
    if (left > bestLeft || (left === bestLeft && dist < bestDist)) {
      best = hit;
      bestLeft = left;
      bestDist = dist;
    }
  }
  return best;
}

// Is there still work to hand out? Constant is excluded: it has no count to
// satisfy, and its ceiling is enforced per gun above.
function wantsMore(mode, cycles, targets, guns, given, targetsAssigned, unsynced) {
  if (!targets.length || !guns.length) return false;
  if (mode === 'constant') return false;
  if (mode === 'normal') return guns.some((g) => (given[g.cannonId] || 0) < cycles);
  if (unsynced) return guns.some((g) => (given[g.cannonId] || 0) < targets.length * cycles);
  return targets.some((t) => (targetsAssigned[t.key] || 0) < cycles);
}

/**
 * One pass over a launched plan: top every reachable gun up to LOOKAHEAD, then
 * close the order if nothing is left to fire and nothing is still in the air.
 *
 * @returns {number} how many shots were queued
 */
export async function feedAttackPlan(env, attackPlan) {
  const firePlanId = Number(attackPlan.fire_plan_id);
  if (!Number.isFinite(firePlanId)) {
    await store.setAttackPlanState(env, attackPlan.id, 'done');
    return 0;
  }

  const plan = await store.findFirePlanById(env, firePlanId);
  if (!plan) {
    await store.setAttackPlanState(env, attackPlan.id, 'done');
    return 0;
  }
  if (plan.state === 'stopped' || plan.state === 'done') {
    await store.setAttackPlanState(env, attackPlan.id, 'done');
    return 0;
  }
  // Paused by an officer: leave the queue alone and do not top it up.
  if (plan.state === 'paused') return 0;

  const mode      = plan.mode;
  const cycles    = Math.max(1, Number(plan.cycles) || 1);
  const unsynced  = Number(plan.unsynced) === 1;
  const trajectory = plan.trajectory || 'optimal';
  const drag      = Number(plan.drag) > 0 ? Number(plan.drag) : 0.99;
  const targets   = parseJsonArray(plan.targets);
  const gunRefs   = parseJsonArray(plan.guns);

  const progress = await store.firePlanProgress(env, firePlanId);
  const given = {};
  for (const [id, g] of Object.entries(progress.guns || {})) {
    given[id] = Number(g.pending || 0) + Number(g.delivered || 0) + Number(g.done || 0);
  }
  const targetsAssigned = Object.assign({}, progress.targets || {});

  // Only guns that still exist, are still accepted, and are actually there. The
  // two flags remember the rest: whether any named gun is still an accepted
  // cannon at all, and how recently the most recent of them checked in. A plan
  // whose every gun is merely stale is not "waiting its turn" — it is stuck, and
  // the flags are what let the pass below tell that apart from a quiet minute.
  const guns = [];
  let anyLive = false;          // at least one named gun is still an accepted cannon
  let newestSeen = -Infinity;   // the most recent check-in among those cannons
  for (const ref of gunRefs) {
    const row = await store.findCannonById(env, ref.cannonId);
    if (!row || row.status !== 'active') continue;
    anyLive = true;
    const seen = Date.parse(row.last_seen_at || '');
    if (Number.isFinite(seen) && seen > newestSeen) newestSeen = seen;
    if (!isFresh(row.last_seen_at)) continue;
    guns.push(gunForSolver(row, plan));
  }

  const shots = [];
  for (const gun of guns) {
    if (shots.length >= MAX_SHOTS_PER_PASS) break;
    const have = progress.guns[String(gun.cannonId)] || {};
    let queued = Number(have.pending || 0) + Number(have.delivered || 0);
    let mine = given[gun.cannonId] || 0;
    while (queued < LOOKAHEAD && shots.length < MAX_SHOTS_PER_PASS) {
      const picked = pickShot(gun, {
        mode, cycles, targets, trajectory, drag, unsynced, mine, targetsAssigned,
      });
      if (!picked) break;
      shots.push(picked.shot);
      queued += 1;
      mine += 1;
      given[gun.cannonId] = mine;
      if (picked.targetKey) {
        targetsAssigned[picked.targetKey] = (targetsAssigned[picked.targetKey] || 0) + 1;
      }
    }
  }

  if (shots.length) await store.appendPlanShots(env, firePlanId, shots);

  // Decide the order's fate from what it looks like NOW, after the top-up.
  const busy = Object.values(progress.guns || {})
    .some((g) => Number(g.pending || 0) + Number(g.delivered || 0) > 0) || shots.length > 0;
  const more = wantsMore(mode, cycles, targets, guns, given, targetsAssigned, unsynced);

  if (!more && !busy) {
    await store.setFirePlanState(env, firePlanId, 'done');
    await store.setAttackPlanState(env, attackPlan.id, 'done');
  } else if (!guns.length && busy && allSilent(anyLive, newestSeen, silenceMs(env))) {
    // Work is queued, but there is no gun left to hand it to, and the whole
    // battery has been dark for longer than the grace window. The order is over.
    //
    // Stopping the fire plan (rather than just marking the attack plan done)
    // withdraws the queue, which matters: those rows were aimed from where the
    // guns were when they last reported, and a Stop is exactly what keeps one
    // that reconnects later from firing a stale barrage nobody asked for.
    await store.setFirePlanState(env, firePlanId, 'stopped');
    await store.setAttackPlanState(env, attackPlan.id, 'done', undefined, SILENCE_REASON);
    console.warn('Scheduled attack #' + attackPlan.id + ' stopped: every gun stopped reporting.');
  }
  return shots.length;
}

/**
 * Open fire on a plan now: the early-execution button, and what the cron calls
 * when a plan's moment arrives.
 *
 * The guns are re-checked against the registry rather than trusted from the
 * stored JSON: a plan can be written days ahead, and a cannon deleted since
 * then must not be fired (or, worse, must not make the whole launch fail).
 */
export async function launchAttackPlan(env, attackPlan) {
  if (!attackPlan) return { error: 'Attack plan not found.' };
  if (attackPlan.state !== 'scheduled') return { error: 'This plan is not waiting to fire.' };

  const targets = parseJsonArray(attackPlan.targets);
  if (!targets.length) return { error: 'This plan names no targets.' };

  const resolved = [];
  for (const ref of parseJsonArray(attackPlan.guns)) {
    const row = await store.findCannonById(env, ref && ref.cannonId);
    if (!row || row.status !== 'active') continue;
    resolved.push({
      cannonId:  Number(row.id),
      vehicleId: row.vehicle_id == null ? null : Number(row.vehicle_id),
      name:      row.name || ('Cannon ' + row.id),
    });
  }
  if (!resolved.length) return { error: 'None of the guns this plan names is still an accepted cannon.' };

  const fire = await store.insertFirePlan(env, {
    mode:       attackPlan.mode,
    cycles:     attackPlan.cycles,
    targets:    targets,
    guns:       resolved,
    // The log names the officer the plan belongs to, and says how it opened —
    // a barrage nobody pressed a button for should be obvious in the record.
    crew:       (attackPlan.created_by ? String(attackPlan.created_by).slice(0, 60) + ' ' : '') + '(scheduled)',
    drag:       attackPlan.drag,
    charges:    attackPlan.charges,
    trajectory: attackPlan.trajectory,
    unsynced:   Number(attackPlan.unsynced) === 1,
  });

  await store.setAttackPlanState(env, attackPlan.id, 'running', fire.id);
  // Fire the first shots immediately rather than leaving the battery waiting for
  // the next cron pass: a plan launched by hand should not sit idle for a minute.
  const opened = await store.findAttackPlanById(env, attackPlan.id);
  await feedAttackPlan(env, opened);
  return { attack: await store.findAttackPlanById(env, attackPlan.id) };
}

// Close a plan without firing it.
export async function cancelAttackPlan(env, attackPlan) {
  if (!attackPlan) return null;
  if (attackPlan.state === 'running') {
    if (attackPlan.fire_plan_id != null) {
      await store.setFirePlanState(env, attackPlan.fire_plan_id, 'stopped');
    }
    return store.setAttackPlanState(env, attackPlan.id, 'done');
  }
  return store.setAttackPlanState(env, attackPlan.id, 'cancelled');
}

/**
 * The cron's entry point: launch everything whose moment has come, then keep
 * every launched order fed. Each plan is handled on its own so that one bad plan
 * cannot stop the others in the same pass.
 */
export async function runAttackScheduler(env) {
  const summary = { launched: [], fed: 0, closed: 0 };
  const now = new Date().toISOString();

  let due = [];
  try {
    due = await store.listDueAttackPlans(env, now);
  } catch (err) {
    console.warn('Scheduled attacks unavailable (run migration 0024?)', err);
    return summary;
  }

  for (const plan of due) {
    try {
      const res = await launchAttackPlan(env, plan);
      if (res.error) {
        // Nothing it named can fire, so it can never fire. Cancelled rather than
        // done: it was called off, not fired out.
        console.warn('Scheduled attack #' + plan.id + ' could not launch:', res.error);
        await store.setAttackPlanState(env, plan.id, 'cancelled');
        summary.closed += 1;
      } else {
        summary.launched.push(Number(plan.id));
      }
    } catch (err) {
      console.error('Scheduled attack #' + plan.id + ' failed to launch:', err);
    }
  }

  for (const plan of await store.listRunningAttackPlans(env)) {
    try {
      const n = await feedAttackPlan(env, plan);
      if (n) summary.fed += n;
      const after = await store.findAttackPlanById(env, plan.id);
      if (after && after.state === 'done') summary.closed += 1;
    } catch (err) {
      console.error('Scheduled attack #' + plan.id + ' failed to feed:', err);
    }
  }

  return summary;
}
