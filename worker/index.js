/* ============================================================
   Regnum Aeternum — Worker entry point
   This is the Worker referenced by wrangler.jsonc's "main" field.
   It does two jobs:
     1. Handle /api/* with real logic, backed by D1.
     2. Hand everything else to the static assets binding (the
        regnum-aeternum/ directory) — same behaviour as before,
        just explicit now instead of being the *only* thing that ran.
   ============================================================ */

import { handleRegister, handleLogin, handleLogout, handleMe } from './routes/auth.js';
import { listUsersRoute, createUserRoute, updateUserRoute, deleteUserRoute } from './routes/admin.js';
import * as news from './routes/news.js';
import * as legal from './routes/legal.js';
import * as landregistry from './routes/landregistry.js';
import * as dynmap from './routes/dynmap.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname.startsWith('/api/')) {
      try {
        // ---- auth ----
        if (pathname === '/api/auth/register' && method === 'POST') return await handleRegister(request, env);
        if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(request, env);
        if (pathname === '/api/auth/logout' && method === 'POST') return await handleLogout(request, env);
        if (pathname === '/api/auth/me' && method === 'GET') return await handleMe(request, env);

        // ---- admin: account management ----
        if (pathname === '/api/admin/users' && method === 'GET') return await listUsersRoute(request, env);
        if (pathname === '/api/admin/users' && method === 'POST') return await createUserRoute(request, env);

        let m = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
        if (m && method === 'PUT') return await updateUserRoute(request, env, m[1]);
        if (m && method === 'DELETE') return await deleteUserRoute(request, env, m[1]);

        // ---- Times of Regnum ----
        if (pathname === '/api/news/articles' && method === 'GET') return await news.listPublished(request, env);
        if (pathname === '/api/news/articles/all' && method === 'GET') return await news.listAll(request, env);
        if (pathname === '/api/news/articles' && method === 'POST') return await news.create(request, env);

        m = pathname.match(/^\/api\/news\/articles\/(\d+)$/);
        if (m && method === 'GET') return await news.getOne(request, env, m[1]);
        if (m && method === 'PUT') return await news.update(request, env, m[1]);
        if (m && method === 'DELETE') return await news.remove(request, env, m[1]);

        m = pathname.match(/^\/api\/news\/articles\/(\d+)\/publish$/);
        if (m && method === 'PUT') return await news.publish(request, env, m[1]);

        m = pathname.match(/^\/api\/news\/articles\/(\d+)\/unpublish$/);
        if (m && method === 'PUT') return await news.unpublish(request, env, m[1]);

        // ---- Legal Information System ----
        if (pathname === '/api/legal/data' && method === 'GET') return await legal.getPublicData(request, env);

        if (pathname === '/api/legal/acts' && method === 'GET') return await legal.listActsAdmin(request, env);
        if (pathname === '/api/legal/acts' && method === 'POST') return await legal.createAct(request, env);

        m = pathname.match(/^\/api\/legal\/acts\/([a-z0-9-]+)$/);
        if (m && method === 'PUT') return await legal.updateAct(request, env, m[1]);
        if (m && method === 'DELETE') return await legal.deleteAct(request, env, m[1]);

        if (pathname === '/api/legal/case-law' && method === 'GET') return await legal.listCaseLawAdmin(request, env);
        if (pathname === '/api/legal/case-law' && method === 'POST') return await legal.createCase(request, env);

        m = pathname.match(/^\/api\/legal\/case-law\/([a-z0-9-]+)$/);
        if (m && method === 'PUT') return await legal.updateCase(request, env, m[1]);
        if (m && method === 'DELETE') return await legal.deleteCase(request, env, m[1]);

        // ---- Land Registry System ----
        if (pathname === '/api/landregistry/data' && method === 'GET') return await landregistry.getPublicData(request, env);
        if (pathname === '/api/landregistry/plots' && method === 'GET') return await landregistry.listPlotsAdmin(request, env);
        if (pathname === '/api/landregistry/plots' && method === 'POST') return await landregistry.createPlot(request, env);
        if (pathname === '/api/landregistry/next-book-number' && method === 'GET') return await landregistry.nextBookNumber(request, env);

        m = pathname.match(/^\/api\/landregistry\/plots\/([^/]+)$/);
        if (m && method === 'GET') return await landregistry.getOnePublic(request, env, decodeURIComponent(m[1]));
        if (m && method === 'PUT') return await landregistry.updatePlot(request, env, decodeURIComponent(m[1]));
        if (m && method === 'DELETE') return await landregistry.deletePlot(request, env, decodeURIComponent(m[1]));

        // ---- Ballistic Calculator: DynMap proxy ----
        if (pathname === '/api/dynmap-config' && method === 'GET') return await dynmap.getConfig(request, env);
        if (pathname === '/api/maptile' && method === 'GET') return await dynmap.getTile(request, env);

        return json({ error: 'Not found.' }, { status: 404 });
      } catch (err) {
        console.error('API error:', err);
        return json({ error: 'Server error.' }, { status: 500 });
      }
    }

    // Everything else: static assets (the regnum-aeternum/ directory)
    return env.ASSETS.fetch(request);
  },
};
