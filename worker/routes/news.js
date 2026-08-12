/* ============================================================
   Regnum Aeternum — Worker
   Times of Regnum article routes. Ported from the old
   server/routes/news.js (Express) to plain handlers backed by D1.
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser, hasRole } from './auth.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

async function requireStaff(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !(hasRole(user, 'admin') || hasRole(user, 'editor'))) return null;
  return user;
}

async function requireAdmin(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !hasRole(user, 'admin')) return null;
  return user;
}

export async function listPublished(request, env) {
  return json(await store.listPublishedArticles(env));
}

export async function listAll(request, env) {
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: 'Editor or admin access required.' }, { status: 403 });
  return json(await store.listAllArticles(env));
}

export async function getOne(request, env, id) {
  const article = await store.findArticleById(env, id);
  if (!article) return json({ error: 'Not found.' }, { status: 404 });
  if (article.status !== 'published') {
    const user = await getCurrentUser(request, env);
    if (!user || !(hasRole(user, 'admin') || hasRole(user, 'editor'))) {
      return json({ error: 'Not published.' }, { status: 403 });
    }
  }
  return json(article);
}

export async function create(request, env) {
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: 'Editor or admin access required.' }, { status: 403 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }
  const { title, subtitle, content } = body;
  if (!title || !content) return json({ error: 'Title and content are required.' }, { status: 400 });

  const article = await store.insertArticle(env, { title, subtitle, content, author: staff.username });
  return json({ id: article.id, title: article.title, status: article.status }, { status: 201 });
}

export async function update(request, env, id) {
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: 'Editor or admin access required.' }, { status: 403 });

  const existing = await store.findArticleById(env, id);
  if (!existing) return json({ error: 'Not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { body = {}; }

  await store.updateArticle(env, id, {
    title: body.title || existing.title,
    subtitle: body.subtitle ?? existing.subtitle,
    content: body.content || existing.content,
  });
  return json({ ok: true });
}

export async function publish(request, env, id) {
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: 'Editor or admin access required.' }, { status: 403 });

  const existing = await store.findArticleById(env, id);
  if (!existing) return json({ error: 'Not found.' }, { status: 404 });

  await store.updateArticle(env, id, { status: 'published', published_at: new Date().toISOString() });
  return json({ ok: true });
}

export async function unpublish(request, env, id) {
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: 'Editor or admin access required.' }, { status: 403 });

  const existing = await store.findArticleById(env, id);
  if (!existing) return json({ error: 'Not found.' }, { status: 404 });

  await store.updateArticle(env, id, { status: 'draft' });
  return json({ ok: true });
}

export async function remove(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const existing = await store.findArticleById(env, id);
  if (!existing) return json({ error: 'Not found.' }, { status: 404 });

  await store.deleteArticleById(env, id);
  return json({ ok: true });
}

// ---------- newspapers ----------

export async function listNewspapersPublished(request, env) {
  return json(await store.listPublishedNewspapers(env));
}

export async function listNewspapersAll(request, env) {
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: 'Editor or admin access required.' }, { status: 403 });
  return json(await store.listAllNewspapers(env));
}

export async function getNewspaper(request, env, id) {
  const paper = await store.findNewspaperById(env, id);
  if (!paper) return json({ error: 'Not found.' }, { status: 404 });
  if (paper.status !== 'published') {
    const user = await getCurrentUser(request, env);
    if (!user || !(hasRole(user, 'admin') || hasRole(user, 'editor'))) {
      return json({ error: 'Not published.' }, { status: 403 });
    }
  }
  return json(paper);
}

export async function getNewspaperBySlug(request, env, slug) {
  const paper = await store.findNewspaperBySlug(env, slug);
  if (!paper) return json({ error: 'Not found.' }, { status: 404 });
  if (paper.status !== 'published') return json({ error: 'Not published.' }, { status: 403 });
  return json(paper);
}

export async function createNewspaper(request, env) {
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: 'Editor or admin access required.' }, { status: 403 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }
  const { slug, title, layout } = body;
  if (!slug || !title) return json({ error: 'Slug and title are required.' }, { status: 400 });

  const paper = await store.insertNewspaper(env, {
    slug: String(slug).trim().toLowerCase(),
    title,
    author: staff.username,
    layoutJson: JSON.stringify(layout || getDefaultLayout(title)),
  });
  return json({ id: paper.id, slug: paper.slug, title: paper.title, status: paper.status }, { status: 201 });
}

export async function updateNewspaper(request, env, id) {
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: 'Editor or admin access required.' }, { status: 403 });

  const existing = await store.findNewspaperById(env, id);
  if (!existing) return json({ error: 'Not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { body = {}; }

  const fields = {};
  if (body.title !== undefined) fields.title = body.title;
  if (body.layout !== undefined) fields.layoutJson = JSON.stringify(body.layout);
  await store.updateNewspaper(env, id, fields);
  return json({ ok: true });
}

export async function publishNewspaper(request, env, id) {
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: 'Editor or admin access required.' }, { status: 403 });

  const existing = await store.findNewspaperById(env, id);
  if (!existing) return json({ error: 'Not found.' }, { status: 404 });

  await store.updateNewspaper(env, id, { status: 'published', published_at: new Date().toISOString() });
  return json({ ok: true });
}

export async function unpublishNewspaper(request, env, id) {
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: 'Editor or admin access required.' }, { status: 403 });
  await store.updateNewspaper(env, id, { status: 'draft' });
  return json({ ok: true });
}

export async function removeNewspaper(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, { status: 403 });

  const existing = await store.findNewspaperById(env, id);
  if (!existing) return json({ error: 'Not found.' }, { status: 404 });

  await store.deleteNewspaperById(env, id);
  return json({ ok: true });
}

function getDefaultLayout(title) {
  return {
    pageWidth: 800,
    pageHeight: 1100,
    masthead: { title: title || 'THE SOCIETY', volume: 'VOL. 1, NO. 1', date: new Date().toISOString().split('T')[0].replace(/-/g, ' ').toUpperCase(), website: 'REGNUM-AETERNUM.COM' },
    sections: [
      { id: 's1', type: 'banner', text: 'BREAKING NEWS', x: 10, y: 120, w: 780, h: 36, z: 10 },
      { id: 's2', type: 'heading', text: 'Headline Goes Here', x: 10, y: 170, w: 380, h: 50, z: 20 },
      { id: 's3', type: 'text', text: 'Body text goes here. Select this section and edit the content in the panel on the right.', x: 10, y: 230, w: 380, h: 280, z: 30 },
      { id: 's4', type: 'image', src: '', x: 410, y: 170, w: 380, h: 220, z: 40 },
      { id: 's5', type: 'text', text: 'Second column text. Drag sections to reposition them, or use the corner handles to resize.', x: 410, y: 410, w: 380, h: 200, z: 50 },
      { id: 's6', type: 'quote', text: '"A great quote appears here."', x: 10, y: 530, w: 380, h: 60, z: 60 },
    ],
  };
}
