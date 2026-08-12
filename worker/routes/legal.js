/* ============================================================
   Regnum Aeternum — Worker
   Legal Information System routes.

   GET /api/legal/data is public and reassembles the exact shape
   regnum-aeternum/legal/assets/legal-app.js already expects from
   window.LEGAL_DATA — {acts:[...], caseLaw:[...]} — by merging each
   row's flat columns with its JSON `data` blob. No changes needed
   to legal-app.js's internal logic, only to how/when it loads DATA.

   Live-table writes (create/update/delete on legal_acts / legal_case_law)
   are admin-only. Users with the "adapter" role may read the datasets
   and may only *suggest drafts* via the /api/legal/drafts endpoints —
   admins review those drafts and can request changes or publish them
   into the live tables. See the "Drafts" section at the bottom.
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser, hasRole } from './auth.js';

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
  if (!user || !hasRole(user, 'admin')) return null;
  return user;
}

// Adapters may read the legal datasets (to populate the editor's
// cross-reference / case-law pickers and to propose amendments), but
// they can never write to the live tables directly — only admins can.
async function requireAdminOrAdapter(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !(hasRole(user, 'admin') || hasRole(user, 'adapter'))) return null;
  return user;
}

function parsePayloadOrNull(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function draftToShape(row) {
  return {
    id: row.id, kind: row.kind, target_slug: row.target_slug, title: row.title,
    status: row.status, author: row.author, reviewer_note: row.reviewer_note,
    reviewed_by: row.reviewed_by, created_at: row.created_at, updated_at: row.updated_at,
    payload: parsePayloadOrNull(row.payload),
  };
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
  const user = await requireAdminOrAdapter(request, env);
  if (!user) return json({ error: 'Admin or adapter access required.' }, { status: 403 });
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
  const user = await requireAdminOrAdapter(request, env);
  if (!user) return json({ error: 'Admin or adapter access required.' }, { status: 403 });
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

// ════════════════════════════════════════════════════════════════
// Drafts — the Adapter workflow.
//   * adapters and admins can create/update/delete drafts and list them;
//   * adapters are scoped to their own drafts;
//   * only admins can request changes or publish a draft to the live tables.
// ════════════════════════════════════════════════════════════════

export async function listDrafts(request, env) {
  const user = await requireAdminOrAdapter(request, env);
  if (!user) return json({ error: 'Admin or adapter access required.' }, { status: 403 });
  const rows = await store.listLegalDrafts(env);
  // Adapters only ever see their own drafts; admins see everything.
  const visible = hasRole(user, 'admin') ? rows : rows.filter(r => r.author === user.username);
  return json(visible.map(draftToShape));
}

export async function createDraft(request, env) {
  const user = await requireAdminOrAdapter(request, env);
  if (!user) return json({ error: 'Admin or adapter access required.' }, { status: 403 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const kind = body.kind === 'case' ? 'case' : 'act';
  const targetSlug = body.targetSlug ? String(body.targetSlug).trim().toLowerCase() : null;
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};

  const err = kind === 'act'
    ? validateActBody(payload, { isCreate: !targetSlug })
    : validateCaseBody(payload, { isCreate: !targetSlug });
  if (err) return json({ error: err }, { status: 400 });

  const title = String(payload.title || body.title || '').trim() || (kind === 'act' ? 'Untitled Act' : 'Untitled Case');
  const draft = await store.insertLegalDraft(env, {
    kind, targetSlug, title, author: user.username, payloadJson: JSON.stringify(payload),
  });
  return json(draftToShape(draft), { status: 201 });
}

export async function updateDraft(request, env, id) {
  const user = await requireAdminOrAdapter(request, env);
  if (!user) return json({ error: 'Admin or adapter access required.' }, { status: 403 });

  const draft = await store.findLegalDraftById(env, id);
  if (!draft) return json({ error: 'Draft not found.' }, { status: 404 });
  if (draft.status === 'published') return json({ error: 'This draft has already been published and can no longer be edited.' }, { status: 409 });

  const isAdmin = hasRole(user, 'admin');
  if (!isAdmin && draft.author !== user.username) {
    return json({ error: 'You can only edit your own drafts.' }, { status: 403 });
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const fields = {};
  if (body.kind !== undefined)       fields.kind = body.kind === 'case' ? 'case' : 'act';
  if (body.targetSlug !== undefined) fields.targetSlug = body.targetSlug ? String(body.targetSlug).trim().toLowerCase() : null;
  if (body.title !== undefined)      fields.title = String(body.title || '').trim();

  if (body.payload !== undefined && typeof body.payload === 'object') {
    const kind = fields.kind !== undefined ? fields.kind : draft.kind;
    const targetSlug = fields.targetSlug !== undefined ? fields.targetSlug : draft.target_slug;
    const err = kind === 'act'
      ? validateActBody(body.payload, { isCreate: !targetSlug })
      : validateCaseBody(body.payload, { isCreate: !targetSlug });
    if (err) return json({ error: err }, { status: 400 });
    fields.payload = JSON.stringify(body.payload);
  }

  // An adapter re-submitting after changes were requested puts the draft
  // back into the review queue and clears the old note.
  if (!isAdmin) { fields.status = 'pending'; fields.reviewerNote = null; }

  const updated = await store.updateLegalDraft(env, id, fields);
  return json(draftToShape(updated));
}

export async function deleteDraft(request, env, id) {
  const user = await requireAdminOrAdapter(request, env);
  if (!user) return json({ error: 'Admin or adapter access required.' }, { status: 403 });

  const draft = await store.findLegalDraftById(env, id);
  if (!draft) return json({ error: 'Draft not found.' }, { status: 404 });

  if (!hasRole(user, 'admin') && draft.author !== user.username) {
    return json({ error: 'You can only delete your own drafts.' }, { status: 403 });
  }

  await store.deleteLegalDraftById(env, id);
  return json({ ok: true });
}

export async function requestChangesDraft(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const draft = await store.findLegalDraftById(env, id);
  if (!draft) return json({ error: 'Draft not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const note = String(body.note || '').trim();
  if (!note) return json({ error: 'A note explaining the requested changes is required.' }, { status: 400 });

  await store.updateLegalDraft(env, id, { status: 'changes_requested', reviewerNote: note, reviewedBy: admin.username });
  return json({ ok: true });
}

export async function publishDraft(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const draft = await store.findLegalDraftById(env, id);
  if (!draft) return json({ error: 'Draft not found.' }, { status: 404 });
  if (draft.status === 'published') return json({ error: 'This draft has already been published.' }, { status: 409 });

  let payload;
  try { payload = JSON.parse(draft.payload); } catch { return json({ error: 'Draft payload is corrupt.' }, { status: 500 }); }

  if (draft.kind === 'act') {
    const err = validateActBody(payload, { isCreate: !draft.target_slug });
    if (err) return json({ error: err }, { status: 400 });

    const slug = draft.target_slug || String(payload.slug || '').trim().toLowerCase();
    const dataJson = JSON.stringify({
      aliases: Array.isArray(payload.aliases) ? payload.aliases : [],
      dateEnacted: payload.dateEnacted, dateInForce: payload.dateInForce,
      preamble: Array.isArray(payload.preamble) ? payload.preamble : [],
      chapters: payload.chapters,
    });

    try {
      if (draft.target_slug) {
        await store.updateLegalAct(env, slug, {
          title: payload.title, shortTitle: payload.shortTitle,
          category: payload.category, status: payload.status, dataJson,
        });
      } else {
        await store.insertLegalAct(env, {
          slug, title: payload.title, shortTitle: payload.shortTitle,
          category: payload.category, status: payload.status, dataJson,
        });
      }
    } catch (e) {
      if (e.code === 'DUPLICATE') return json({ error: e.message }, { status: 409 });
      console.error(e);
      return json({ error: 'Server error.' }, { status: 500 });
    }

    await store.updateLegalDraft(env, id, { status: 'published', targetSlug: slug, reviewedBy: admin.username, reviewerNote: null });
    return json({ ok: true, slug });
  }

  if (draft.kind === 'case') {
    const err = validateCaseBody(payload, { isCreate: !draft.target_slug });
    if (err) return json({ error: err }, { status: 400 });

    const slug = draft.target_slug || String(payload.slug || '').trim().toLowerCase();
    const dataJson = JSON.stringify({
      date: payload.date, court: payload.court || '', chamber: payload.chamber || '',
      subject: payload.subject || '', type: payload.type || '',
      summary: payload.summary || '', fullText: payload.fullText || '',
      relatedArticles: payload.relatedArticles,
    });

    try {
      if (draft.target_slug) {
        await store.updateLegalCase(env, slug, { title: payload.title, refNumber: payload.refNumber, dataJson });
      } else {
        await store.insertLegalCase(env, { slug, title: payload.title, refNumber: payload.refNumber, dataJson });
      }
    } catch (e) {
      if (e.code === 'DUPLICATE') return json({ error: e.message }, { status: 409 });
      console.error(e);
      return json({ error: 'Server error.' }, { status: 500 });
    }

    await store.updateLegalDraft(env, id, { status: 'published', targetSlug: slug, reviewedBy: admin.username, reviewerNote: null });
    return json({ ok: true, slug });
  }

  return json({ error: 'Unknown draft kind.' }, { status: 400 });
}
