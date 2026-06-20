/* ============================================================
   Regnum Aeternum — Worker
   Times of Regnum article routes. Ported from the old
   server/routes/news.js (Express) to plain handlers backed by D1.
   ============================================================ */

import * as store from '../lib/store.js';
import { getCurrentUser } from './auth.js';

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function requireStaff(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !['admin', 'editor'].includes(user.role)) return null;
  return user;
}

async function requireAdmin(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'admin') return null;
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
    if (!user || !['admin', 'editor'].includes(user.role)) {
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
