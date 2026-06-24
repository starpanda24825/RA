/* ============================================================
   Regnum Aeternum — Worker
   Legal Information System routes.

   GET /api/legal/data is public and reassembles the exact shape
   regnum-aeternum/legal/assets/legal-app.js already expects from
   window.LEGAL_DATA — {acts:[...], caseLaw:[...]} — by merging each
   row's flat columns with its JSON `data` blob. No changes needed
   to legal-app.js's internal logic, only to how/when it loads DATA.

   All write endpoints (create/update/delete) are admin-only. There
   is no "editor" access here — the existing editor role is scoped
   to Times of Regnum specifically (see worker/routes/news.js); this
   intentionally doesn't widen that without being asked to.
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser } from './auth.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ACT_CATEGORIES = ['constitution', 'code', 'act', 'regulation'];
const ACT_STATUSES = ['in-force', 'repealed', 'amended'];

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

function actToPublicShape(row) {
  const extra = JSON.parse(row.data);
  return {
    slug: row.slug, title: row.title, shortTitle: row.short_title,
    category: row.category, status: row.status,
    aliases: extra.aliases || [], dateEnacted: extra.dateEnacted, dateInForce: extra.dateInForce,
    // `preamble` is optional and only present on acts authored/edited with
    // the structured content model (see legal-data.js's header comment for
    // the ContentNode shapes). Older rows simply have no `preamble` key,
    // hence the fallback rather than this being a required column.
    preamble: extra.preamble || [],
    chapters: extra.chapters || [],
  };
}

function caseToPublicShape(row) {
  const extra = JSON.parse(row.data);
  return {
    slug: row.slug, title: row.title, refNumber: row.ref_number,
    date: extra.date, court: extra.court, chamber: extra.chamber, subject: extra.subject,
    type: extra.type, summary: extra.summary, fullText: extra.fullText,
    relatedArticles: extra.relatedArticles || [],
  };
}

// ---------- public: combined dataset for the live site ----------

export async function getPublicData(request, env) {
  const actRows = await store.listLegalActs(env);
  const caseRows = await store.listLegalCaseLaw(env);
  return json({
    acts: actRows.map(actToPublicShape),
    caseLaw: caseRows.map(caseToPublicShape),
  });
}

// ---------- shared validation ----------

function validateActBody(body, { isCreate }) {
  if (isCreate) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) return 'Slug must be lowercase letters, numbers, and hyphens only (e.g. "trade-act").';
  }
  if (!String(body.title || '').trim()) return 'Title is required.';
  if (!String(body.shortTitle || '').trim()) return 'Short title is required.';
  if (!ACT_CATEGORIES.includes(body.category)) return 'Category must be one of: ' + ACT_CATEGORIES.join(', ') + '.';
  if (!ACT_STATUSES.includes(body.status)) return 'Status must be one of: ' + ACT_STATUSES.join(', ') + '.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dateEnacted || '')) return 'Date Enacted must be in YYYY-MM-DD format.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dateInForce || '')) return 'Date In Force must be in YYYY-MM-DD format.';
  if (!Array.isArray(body.chapters)) return 'Chapters must be a JSON array (see the placeholder for the expected shape).';
  if (body.preamble !== undefined && !Array.isArray(body.preamble)) return 'Preamble must be a JSON array of content blocks (or omitted entirely).';
  return null;
}

function validateCaseBody(body, { isCreate }) {
  if (isCreate) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) return 'Slug must be lowercase letters, numbers, and hyphens only (e.g. "sc-2026-002").';
  }
  if (!String(body.title || '').trim()) return 'Title is required.';
  if (!String(body.refNumber || '').trim()) return 'Reference number is required.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) return 'Date must be in YYYY-MM-DD format.';
  if (!Array.isArray(body.relatedArticles)) return 'Related Articles must be a JSON array (can be empty: []).';
  return null;
}

// ---------- acts: admin write endpoints ----------

export async function listActsAdmin(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });
  const rows = await store.listLegalActs(env);
  return json(rows.map(actToPublicShape));
}

export async function createAct(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const err = validateActBody(body, { isCreate: true });
  if (err) return json({ error: err }, { status: 400 });

  const slug = String(body.slug).trim().toLowerCase();
  const dataJson = JSON.stringify({
    aliases: Array.isArray(body.aliases) ? body.aliases : [],
    dateEnacted: body.dateEnacted, dateInForce: body.dateInForce,
    preamble: Array.isArray(body.preamble) ? body.preamble : [],
    chapters: body.chapters,
  });

  try {
    await store.insertLegalAct(env, {
      slug, title: body.title, shortTitle: body.shortTitle,
      category: body.category, status: body.status, dataJson,
    });
  } catch (e) {
    if (e.code === 'DUPLICATE') return json({ error: e.message }, { status: 409 });
    console.error(e);
    return json({ error: 'Server error.' }, { status: 500 });
  }

  return json({ slug }, { status: 201 });
}

export async function updateAct(request, env, slug) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const existing = await store.findLegalActBySlug(env, slug);
  if (!existing) return json({ error: 'Act not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const err = validateActBody(body, { isCreate: false });
  if (err) return json({ error: err }, { status: 400 });

  const dataJson = JSON.stringify({
    aliases: Array.isArray(body.aliases) ? body.aliases : [],
    dateEnacted: body.dateEnacted, dateInForce: body.dateInForce,
    preamble: Array.isArray(body.preamble) ? body.preamble : [],
    chapters: body.chapters,
  });

  await store.updateLegalAct(env, slug, {
    title: body.title, shortTitle: body.shortTitle, category: body.category, status: body.status, dataJson,
  });

  return json({ ok: true });
}

export async function deleteAct(request, env, slug) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const existing = await store.findLegalActBySlug(env, slug);
  if (!existing) return json({ error: 'Act not found.' }, { status: 404 });

  await store.deleteLegalActBySlug(env, slug);
  return json({ ok: true });
}

// ---------- case law: admin write endpoints ----------

export async function listCaseLawAdmin(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });
  const rows = await store.listLegalCaseLaw(env);
  return json(rows.map(caseToPublicShape));
}

export async function createCase(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const err = validateCaseBody(body, { isCreate: true });
  if (err) return json({ error: err }, { status: 400 });

  const slug = String(body.slug).trim().toLowerCase();
  const dataJson = JSON.stringify({
    date: body.date, court: body.court || '', chamber: body.chamber || '', subject: body.subject || '',
    type: body.type || '', summary: body.summary || '', fullText: body.fullText || '',
    relatedArticles: body.relatedArticles,
  });

  try {
    await store.insertLegalCase(env, { slug, title: body.title, refNumber: body.refNumber, dataJson });
  } catch (e) {
    if (e.code === 'DUPLICATE') return json({ error: e.message }, { status: 409 });
    console.error(e);
    return json({ error: 'Server error.' }, { status: 500 });
  }

  return json({ slug }, { status: 201 });
}

export async function updateCase(request, env, slug) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const existing = await store.findLegalCaseBySlug(env, slug);
  if (!existing) return json({ error: 'Case not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const err = validateCaseBody(body, { isCreate: false });
  if (err) return json({ error: err }, { status: 400 });

  const dataJson = JSON.stringify({
    date: body.date, court: body.court || '', chamber: body.chamber || '', subject: body.subject || '',
    type: body.type || '', summary: body.summary || '', fullText: body.fullText || '',
    relatedArticles: body.relatedArticles,
  });

  await store.updateLegalCase(env, slug, { title: body.title, refNumber: body.refNumber, dataJson });

  return json({ ok: true });
}

export async function deleteCase(request, env, slug) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const existing = await store.findLegalCaseBySlug(env, slug);
  if (!existing) return json({ error: 'Case not found.' }, { status: 404 });

  await store.deleteLegalCaseBySlug(env, slug);
  return json({ ok: true });
}
