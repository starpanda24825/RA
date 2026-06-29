/* ============================================================
   Regnum Aeternum — Worker
   Land Registry System routes.

   Land records are public by design (the same stance the Legal
   Information System takes on case law) — owner, resident, and rent
   details are all returned by the public endpoints. There is no
   "editor" role for this office: only admin can create, edit, or
   delete a plot, same as worker/routes/legal.js.

   register_number is the realm's register identifier — e.g.
   "RA1M/00000123/4" (DIVISION/8-DIGIT BOOK NUMBER/1-DIGIT CONTROL) —
   and is the primary key. It contains "/" characters, so every
   route that addresses a single plot expects the register number
   URL-encoded (encodeURIComponent turns "/" into "%2F", which a
   path segment regex like ([^/]+) below matches as one piece;
   decodeURIComponent then recovers the real "/" characters before
   it's used as a lookup key).
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser } from './auth.js';

export const DIVISIONS = [
  { code: 'RA1M', name: 'Ardoritha' },
  { code: 'RA2V', name: 'Vinland' },
  { code: 'RA3D', name: 'Meridia' },
  { code: 'RA4L', name: 'Littoria' },
  { code: 'RA5A', name: 'Algiers' },
];
const DIVISION_CODES = DIVISIONS.map((d) => d.code);
const STATUSES = ['registered', 'vacant', 'disputed', 'archived'];

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

async function requireAdmin(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'admin') return null;
  return user;
}

function buildRegisterNumber(division, bookNumber, controlDigit) {
  return `${division}/${bookNumber}/${controlDigit}`;
}

function plotToPublicShape(row) {
  const extra = JSON.parse(row.data);
  return {
    registerNumber: row.register_number,
    divisionCode: row.division_code,
    bookNumber: row.book_number,
    controlDigit: row.control_digit,
    world: row.world,
    owner: row.owner,
    resident: row.resident,
    isRented: !!row.is_rented,
    yLower: row.y_lower,
    yUpper: row.y_upper,
    status: row.status,
    corners: extra.corners || [],
    plotType: extra.plotType || '',
    renter: extra.renter || '',
    rentAmount: extra.rentAmount || 0,
    rentCurrency: extra.rentCurrency || '',
    rentDueDate: extra.rentDueDate || '',
    registeredDate: extra.registeredDate || '',
    notes: extra.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- public ----------

// GET /api/landregistry/data — the combined dataset the public
// search page, record view, and cadastral map all load (with the
// static land-registry-data.js fallback used if this is unreachable).
export async function getPublicData(request, env) {
  const rows = await store.listLandPlots(env);
  return json({ divisions: DIVISIONS, plots: rows.map(plotToPublicShape) });
}

// GET /api/landregistry/plots/:registerNumber — single-record lookup,
// used by the register-number search form. Public: land records are
// public records, same as a real cadastre.
export async function getOnePublic(request, env, registerNumber) {
  const row = await store.findLandPlotByNumber(env, registerNumber);
  if (!row) return json({ error: 'Not found.' }, { status: 404 });
  return json(plotToPublicShape(row));
}

// ---------- admin ----------

export async function listPlotsAdmin(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });
  const rows = await store.listLandPlots(env);
  return json(rows.map(plotToPublicShape));
}

// GET /api/landregistry/next-book-number?division=RA1M
export async function nextBookNumber(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });
  const url = new URL(request.url);
  const division = url.searchParams.get('division');
  if (!DIVISION_CODES.includes(division)) {
    return json({ error: 'Division must be one of: ' + DIVISION_CODES.join(', ') + '.' }, { status: 400 });
  }
  const max = await store.maxBookNumberForDivision(env, division);
  return json({ nextBookNumber: String(max + 1).padStart(8, '0') });
}

function validateCorners(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return 'Exactly 4 corners are required.';
  for (const c of corners) {
    if (!c || typeof c.x !== 'number' || typeof c.z !== 'number' || !Number.isFinite(c.x) || !Number.isFinite(c.z)) {
      return 'Each corner needs numeric x and z coordinates.';
    }
  }
  return null;
}

function validateCommonFields(body) {
  const cornerErr = validateCorners(body.corners);
  if (cornerErr) return cornerErr;
  if (!Number.isFinite(body.yLower) || !Number.isFinite(body.yUpper)) return 'Y Lower and Y Upper must be numbers.';
  if (body.yUpper < body.yLower) return 'Y Upper must be greater than or equal to Y Lower.';
  if (body.status && !STATUSES.includes(body.status)) return 'Status must be one of: ' + STATUSES.join(', ') + '.';
  return null;
}

function plotDataJson(body, existingData) {
  const prevRegisteredDate = existingData ? (JSON.parse(existingData).registeredDate || '') : '';
  return JSON.stringify({
    corners: body.corners,
    plotType: body.plotType || '',
    renter: body.renter || '',
    rentAmount: Number(body.rentAmount) || 0,
    rentCurrency: body.rentCurrency || '',
    rentDueDate: body.rentDueDate || '',
    registeredDate: body.registeredDate || prevRegisteredDate || new Date().toISOString().slice(0, 10),
    notes: body.notes || '',
  });
}

// POST /api/landregistry/plots — create
export async function createPlot(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  if (!DIVISION_CODES.includes(body.divisionCode)) {
    return json({ error: 'Division must be one of: ' + DIVISION_CODES.join(', ') + '.' }, { status: 400 });
  }
  if (!/^\d{1,8}$/.test(String(body.bookNumber || ''))) {
    return json({ error: 'Book number must be 1-8 digits.' }, { status: 400 });
  }
  if (!/^\d$/.test(String(body.controlDigit ?? ''))) {
    return json({ error: 'Control digit must be a single digit, 0-9.' }, { status: 400 });
  }
  const commonErr = validateCommonFields(body);
  if (commonErr) return json({ error: commonErr }, { status: 400 });

  const bookNumber = String(body.bookNumber).padStart(8, '0').slice(0, 8);
  const controlDigit = String(body.controlDigit).slice(0, 1);
  const registerNumber = buildRegisterNumber(body.divisionCode, bookNumber, controlDigit);
  const dataJson = plotDataJson(body, null);

  try {
    await store.insertLandPlot(env, {
      registerNumber, divisionCode: body.divisionCode, bookNumber, controlDigit,
      world: body.world || '', owner: body.owner || '', resident: body.resident || '',
      isRented: !!body.isRented, yLower: body.yLower, yUpper: body.yUpper,
      status: body.status || 'registered', dataJson,
    });
  } catch (e) {
    if (e.code === 'DUPLICATE') return json({ error: e.message }, { status: 409 });
    console.error(e);
    return json({ error: 'Server error.' }, { status: 500 });
  }

  return json({ registerNumber }, { status: 201 });
}

// PUT /api/landregistry/plots/:registerNumber — update everything
// except division/book/control (see store.js's updateLandPlot).
export async function updatePlot(request, env, registerNumber) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const existing = await store.findLandPlotByNumber(env, registerNumber);
  if (!existing) return json({ error: 'Plot not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const commonErr = validateCommonFields(body);
  if (commonErr) return json({ error: commonErr }, { status: 400 });

  const dataJson = plotDataJson(body, existing.data);

  await store.updateLandPlot(env, registerNumber, {
    world: body.world || '', owner: body.owner || '', resident: body.resident || '',
    isRented: !!body.isRented, yLower: body.yLower, yUpper: body.yUpper,
    status: body.status || 'registered', dataJson,
  });

  return json({ ok: true });
}

// DELETE /api/landregistry/plots/:registerNumber
export async function deletePlot(request, env, registerNumber) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const existing = await store.findLandPlotByNumber(env, registerNumber);
  if (!existing) return json({ error: 'Plot not found.' }, { status: 404 });

  await store.deleteLandPlotByNumber(env, registerNumber);
  return json({ ok: true });
}
