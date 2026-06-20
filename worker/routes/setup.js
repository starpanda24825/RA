/* ============================================================
   Regnum Aeternum — Worker
   One-time, secret-token-gated bootstrap for the very first admin
   account. This exists because there is no shell/DB access on a
   live Cloudflare Workers deployment the way there was with the
   old Node server (which auto-created admin/admin on first run).

   Security model:
     - Permanently and irreversibly disabled the instant any admin
       account exists (anyAdminExists() check, not a one-time flag —
       so it can't be re-enabled by deleting users).
     - Requires the SETUP_TOKEN secret, set via:
         wrangler secret put SETUP_TOKEN
       which is never committed to the repo. Without that secret
       configured, the endpoint always refuses.
   ============================================================ */

import * as store from '../lib/store.js';
import { hash } from '../lib/passwords.js';

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

// Constant-time-ish string compare for the setup token.
function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function setupStatus(request, env) {
  const exists = await store.anyAdminExists(env);
  return json({ available: !exists, configured: !!env.SETUP_TOKEN });
}

export async function setupBootstrap(request, env) {
  const exists = await store.anyAdminExists(env);
  if (exists) {
    return json({ error: 'An admin account already exists. Setup is permanently disabled.' }, { status: 403 });
  }

  if (!env.SETUP_TOKEN) {
    return json({
      error: 'Server is not configured for setup. Set the SETUP_TOKEN secret first (wrangler secret put SETUP_TOKEN), then redeploy.',
    }, { status: 500 });
  }

  const provided = request.headers.get('X-Setup-Token') || '';
  if (!safeEqual(provided, env.SETUP_TOKEN)) {
    return json({ error: 'Invalid setup token.' }, { status: 403 });
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, { status: 400 }); }

  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (username.length < 3) return json({ error: 'Username must be at least 3 characters.' }, { status: 400 });
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, { status: 400 });

  try {
    const passwordHash = await hash(password);
    const user = await store.insertUser(env, { username, passwordHash, role: 'admin' });
    return json({ id: user.id, username: user.username, role: user.role }, { status: 201 });
  } catch (err) {
    if (err.code === 'DUPLICATE') return json({ error: 'That username is already taken.' }, { status: 409 });
    console.error(err);
    return json({ error: 'Server error.' }, { status: 500 });
  }
}
