/* ============================================================
   Regnum Aeternum — Worker
   Ballistics solver.

   This is the arithmetic that normally lives in the calculator page
   (regnum-aeternum/ballistics/index.html, section 1). It is mirrored
   here for ONE reason: a scheduled attack plan fires with nobody at a
   screen and no page open, so the aiming has to be done by the Worker.

   The two copies are deliberately kept to the same statements — same
   constants, same integration order, same bracket, same tie-breaks — so
   a shot from a scheduled attack is aimed exactly as the same shot
   pressed by hand would be. If the physics in the page is ever
   corrected, correct it here too.

   Everything in this file is pure: no database, no fetch, no settings.
   Callers hand in a gun's position and load, and get back an aim.
   ============================================================ */

// The mod's constants — identical to the page's.
const GRAVITY        = 0.05;   // blocks/tick², downward
const VEL_PER_CHARGE = 2;      // blocks/tick per powder charge
const TICKS_PER_SEC  = 20;
const MAX_TICKS      = 4000;   // a shell that has not landed by now never will

// What a gun is fired with when nothing on record says otherwise. Kept in step
// with store.js's DEFAULT_CHARGES: a scheduled order and a hand-fired one must
// load the same tube the same way.
export const DEFAULT_CHARGES = 3;

// Per-tick integration, matching Create: Big Cannons as the page models it:
//   position += velocity · velocity *= drag · velocity.y -= gravity
// The path is returned whole because both the height-at-distance lookup and the
// time of flight are read off it.
function simulate(x0, y0, z0, yawDeg, pitchDeg, charges, drag) {
  const v0   = charges * VEL_PER_CHARGE;
  const yawR = yawDeg   * Math.PI / 180;
  const pitR = pitchDeg * Math.PI / 180;

  let vx = -v0 * Math.sin(yawR) * Math.cos(pitR);
  let vy =  v0 * Math.sin(pitR);
  let vz =  v0 * Math.cos(yawR) * Math.cos(pitR);
  let x = x0, y = y0, z = z0;

  const path = [{ x, y, z, t: 0 }];
  for (let t = 1; t <= MAX_TICKS; t++) {
    x += vx; y += vy; z += vz;
    vx *= drag; vy *= drag; vz *= drag;
    vy -= GRAVITY;
    path.push({ x, y, z, t });
    if (y < -64) break;
  }
  return path;
}

// World heading from the gun's mount to the target: 0 = south/+Z, 90 = west,
// 180 = north, 270 = east — the convention every cannon and vehicle computer
// expects. Ship-relative conversion is the in-game computers' job, so this is
// always an absolute heading.
export function computeYaw(x0, z0, xt, zt) {
  return Math.atan2(-(xt - x0), (zt - z0)) * 180 / Math.PI;
}

// Height of the trajectory at a given horizontal distance from the muzzle.
function yAtHDist(path, x0, z0, hDist) {
  for (let i = 1; i < path.length; i++) {
    const hPrev = Math.hypot(path[i - 1].x - x0, path[i - 1].z - z0);
    const hCurr = Math.hypot(path[i].x     - x0, path[i].z     - z0);
    if (hCurr >= hDist) {
      const frac = hCurr === hPrev ? 0 : (hDist - hPrev) / (hCurr - hPrev);
      return { y: path[i - 1].y + frac * (path[i].y - path[i - 1].y), tick: path[i - 1].t + frac };
    }
  }
  return null;
}

// Every pitch in the bracket that puts the shell exactly on the target's
// horizontal distance AND height. Bisected rather than solved, because
// height-versus-pitch is not monotonic near the edges of the high-angle range.
function findFiringSolutions(x0, y0, z0, xt, yt, zt, yawDeg, charges, drag, loLim, hiLim) {
  const targetH = Math.hypot(xt - x0, zt - z0);
  const SAMPLES = 90;

  const fAt = (theta) => {
    const path = simulate(x0, y0, z0, yawDeg, theta, charges, drag);
    const r = yAtHDist(path, x0, z0, targetH);
    return r === null ? null : (r.y - yt);
  };

  const thetas = [];
  for (let i = 0; i <= SAMPLES; i++) thetas.push(loLim + (hiLim - loLim) * i / SAMPLES);
  const fvals = thetas.map(fAt);

  const roots = [];
  for (let i = 0; i < thetas.length - 1; i++) {
    const fa = fvals[i], fb = fvals[i + 1];
    if (fa === null || fb === null) continue;
    if (fa === 0) { roots.push(thetas[i]); continue; }
    if (fa * fb < 0) {
      let lo = thetas[i], hi = thetas[i + 1], loF = fa;
      for (let k = 0; k < 40; k++) {
        const mid  = (lo + hi) / 2;
        const midF = fAt(mid);
        const mf   = midF === null ? -1e9 : midF;
        if ((loF < 0) === (mf < 0)) { lo = mid; loF = mf; }
        else { hi = mid; }
      }
      roots.push((lo + hi) / 2);
    }
  }
  return roots;
}

// The flattest (shortest time of flight) solution over the whole valid range.
function findOptimalSolution(x0, y0, z0, xt, yt, zt, yawDeg, charges, drag) {
  const roots = findFiringSolutions(x0, y0, z0, xt, yt, zt, yawDeg, charges, drag, 0.5, 60.0);
  if (!roots.length) return null;
  const targetH = Math.hypot(xt - x0, zt - z0);
  let best = null;
  for (const pitch of roots) {
    const path = simulate(x0, y0, z0, yawDeg, pitch, charges, drag);
    const r    = yAtHDist(path, x0, z0, targetH);
    const tof  = r ? r.tick / TICKS_PER_SEC : Infinity;
    if (!best || tof < best.tof) best = { pitch, tof };
  }
  return best;
}

// Point-blank: line of sight to the target, clamped to the mount's 0–60° range.
// No gravity compensation, so it is a close-range reference rather than a
// guaranteed hit — the same trade the page makes.
function directHitSolution(x0, y0, z0, xt, yt, zt, yawDeg) {
  const targetH = Math.hypot(xt - x0, zt - z0);
  let pitch = Math.atan2(yt - y0, targetH) * 180 / Math.PI;
  pitch = Math.max(0, Math.min(60, pitch));
  return { pitch };
}

/**
 * One gun's aim at one target.
 *
 * @param {{x:number,y:number,z:number,length:number,charges:number|null}} gun
 * @param {{x:number,y:number,z:number}} target
 * @param {'optimal'|'direct'} trajectory
 * @param {number} drag  the shell's per-tick drag from shells.json
 * @returns {{yaw:number, pitch:number}|null}  null when the target is out of range
 *
 * The muzzle is offset from the mount by the barrel length along the firing
 * line: the shell leaves the END of the barrel, not the mount block, and over a
 * long gun that offset is worth whole blocks of aim.
 */
export function solveShot(gun, target, trajectory, drag) {
  const gx = Number(gun.x), gy = Number(gun.y), gz = Number(gun.z);
  const tx = Number(target.x), ty = Number(target.y), tz = Number(target.z);
  if (![gx, gy, gz, tx, ty, tz].every(Number.isFinite)) return null;

  const charges = clampCharges(gun.charges);
  const dragV   = (Number.isFinite(Number(drag)) && Number(drag) > 0 && Number(drag) <= 1)
    ? Number(drag) : 0.99;

  const yaw  = computeYaw(gx, gz, tx, tz);
  const yawR = yaw * Math.PI / 180;
  const len  = Math.max(1, Number(gun.length) || 4);
  const bx   = gx - len * Math.sin(yawR);
  const bz   = gz + len * Math.cos(yawR);

  const s = (trajectory === 'direct')
    ? directHitSolution(bx, gy, bz, tx, ty, tz, yaw)
    : findOptimalSolution(bx, gy, bz, tx, ty, tz, yaw, charges, dragV);
  if (!s) return null;
  return { yaw, pitch: s.pitch };
}

/** The Y a target is aimed at when only X and Z are known — sea level. */
export function defaultTargetY(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 64;
}

// A powder count is a small positive whole number, and the ceiling is the same
// one the registry slides to: it exists so a nonsense value cannot become a
// muzzle velocity of a thousand blocks a tick and hang the solver.
export function clampCharges(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHARGES;
  return Math.max(1, Math.min(99, n));
}
