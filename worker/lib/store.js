/* ============================================================
   Regnum Aeternum — Worker
   Pure D1 data access. No filesystem, no in-memory cache — each
   call hits the database directly, since a Worker request may run
   in a fresh isolate with no memory of any previous request.
   ============================================================ */

function nowIso() {
  return new Date().toISOString();
}

// ---------- users ----------

export async function findUserByUsername(env, username) {
  const lower = String(username || '').toLowerCase();
  return env.DB.prepare('SELECT * FROM users WHERE username_lower = ?').bind(lower).first();
}

export async function findUserById(env, id) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(id)).first();
}

export async function anyAdminExists(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").first();
  return !!(row && row.c > 0);
}

export async function listUsers(env) {
  const { results } = await env.DB
    .prepare('SELECT id, username, role, created_at FROM users ORDER BY id ASC')
    .all();
  return results;
}

export async function insertUser(env, { username, passwordHash, role }) {
  const lower = username.toLowerCase();
  const created_at = nowIso();
  try {
    const result = await env.DB.prepare(
      'INSERT INTO users (username, username_lower, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(username, lower, passwordHash, role || 'citizen', created_at).run();
    return findUserById(env, result.meta.last_row_id);
  } catch (err) {
    // D1/SQLite surfaces the UNIQUE constraint violation in err.message
    if (String(err && err.message || '').toUpperCase().includes('UNIQUE')) {
      const e = new Error('Username already exists.');
      e.code = 'DUPLICATE';
      throw e;
    }
    throw err;
  }
}

export async function updateUser(env, id, fields) {
  const sets = [];
  const binds = [];
  if (fields.role) { sets.push('role = ?'); binds.push(fields.role); }
  if (fields.passwordHash) { sets.push('password_hash = ?'); binds.push(fields.passwordHash); }
  if (!sets.length) return findUserById(env, id);
  binds.push(Number(id));
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findUserById(env, id);
}

export async function deleteUserById(env, id) {
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(Number(id)).run();
}

// ---------- sessions ----------
// Sessions are real rows, not a stateless signed token — this means
// "Sign out" actually revokes the session server-side (the old
// in-memory express-session store could not do this across restarts
// at all, and Workers have no persistent memory between requests).

export async function createSession(env, userId, ttlSeconds) {
  const token = crypto.randomUUID();
  const expires_at = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, userId, nowIso(), expires_at).run();
  return { token, expires_at };
}

export async function getSession(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.token, s.user_id, s.expires_at, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await deleteSession(env, token);
    return null;
  }
  return row;
}

export async function deleteSession(env, token) {
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

// ---------- articles ----------

export async function listPublishedArticles(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM articles WHERE status = 'published' ORDER BY published_at DESC"
  ).all();
  return results;
}

export async function listAllArticles(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, title, subtitle, author, status, created_at, published_at FROM articles ORDER BY created_at DESC'
  ).all();
  return results;
}

export async function findArticleById(env, id) {
  return env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(Number(id)).first();
}

export async function insertArticle(env, { title, subtitle, content, author }) {
  const created_at = nowIso();
  const result = await env.DB.prepare(
    'INSERT INTO articles (title, subtitle, content, author, status, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
  ).bind(title, subtitle || '', content, author, 'draft', created_at).run();
  return findArticleById(env, result.meta.last_row_id);
}

export async function updateArticle(env, id, fields) {
  const sets = [];
  const binds = [];
  ['title', 'subtitle', 'content', 'status', 'published_at'].forEach((k) => {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); binds.push(fields[k]); }
  });
  if (!sets.length) return findArticleById(env, id);
  binds.push(Number(id));
  await env.DB.prepare(`UPDATE articles SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return findArticleById(env, id);
}

export async function deleteArticleById(env, id) {
  await env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(Number(id)).run();
}
