'use strict';
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const https = require('https');
const http  = require('http');

const { initDB } = require('./db');
const authRoutes  = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const newsRoutes  = require('./routes/news');

const app = express();

// ── Body parsers
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));

// ── Session
//    Using the default in-memory session store — fine for a small
//    community site (logins just need to happen again after a
//    server restart). Swap in a persistent store later if needed.
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000   // 7 days
  }
}));

// ── API routes
app.use('/api/auth',  authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/news',  newsRoutes);

// ── BlueMap tile proxy (the BlueMap host is plain HTTP, so tiles must be
//    fetched server-side to avoid mixed-content blocking on the HTTPS site).
//    Frontend requests: GET /api/maptile?path=/maps/world/tiles/1/x0/z0.png
const BLUEMAP_BASE = (process.env.BLUEMAP_BASE_URL || 'http://regnumaeternum.enderman.cloud:50500').replace(/\/$/, '');

app.get('/api/maptile', (req, res) => {
  const tilePath = req.query.path;
  if (!tilePath || !tilePath.startsWith('/maps/')) {
    return res.status(400).send('Invalid tile path');
  }
  const url = BLUEMAP_BASE + tilePath;
  const lib = url.startsWith('https') ? https : http;
  const request = lib.get(url, (upstreamRes) => {
    if (upstreamRes.statusCode === 204 || upstreamRes.statusCode === 404) {
      return res.status(upstreamRes.statusCode).end();
    }
    res.set('Content-Type', upstreamRes.headers['content-type'] || 'image/png');
    res.set('Cache-Control', 'public, max-age=60');
    upstreamRes.pipe(res);
  });
  request.on('error', () => res.status(502).send('Tile unavailable'));
});

// ── BlueMap configuration proxy (same purpose as the tile proxy above,
//    but for the config discovery the map pages make on load). Fetches
//    settings.json + each map's settings.json server-side and returns a
//    combined {maps:[...]} payload. Always targets this server's own
//    configured BLUEMAP_BASE_URL — never a client-supplied URL — so it
//    can't be abused as an open proxy. Keep BLUEMAP_BASE_URL in sync with
//    ballistics/assets/shells.json's "bluemapBaseUrl" and
//    land-registry/assets/mapconfig.json.
app.get('/api/bluemap-config', (req, res) => {
  const base = BLUEMAP_BASE;
  const lib = base.startsWith('https') ? https : http;

  const getJson = (path) => new Promise((resolve, reject) => {
    const rq = lib.get(base + path, (upstreamRes) => {
      let body = '';
      upstreamRes.on('data', (d) => { body += d; });
      upstreamRes.on('end', () => {
        if (upstreamRes.statusCode !== 200) return reject(new Error('bad status ' + upstreamRes.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    rq.on('error', reject);
  });

  (async () => {
    try {
      const settings = await getJson('/settings.json');
      const ids = Array.isArray(settings.maps) ? settings.maps : [];
      const maps = [];
      for (const id of ids) {
        try {
          const m = await getJson('/maps/' + encodeURIComponent(id) + '/settings.json');
          const lowres = m.lowres || {};
          const startPos = Array.isArray(m.startPos)
            ? { x: Number(m.startPos[0]) || 0, z: Number(m.startPos[1]) || 0 }
            : { x: 0, z: 0 };
          maps.push({
            id,
            name: m.name || id,
            startPos,
            tileSize: (Array.isArray(lowres.tileSize) && lowres.tileSize[0]) || 500,
            lodFactor: lowres.lodFactor || 5,
            lodCount: lowres.lodCount || 3,
          });
        } catch (e) { /* skip this map */ }
      }
      res.set('Content-Type', 'application/json');
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ maps });
    } catch (e) {
      res.status(502).json({ error: 'BlueMap configuration unavailable.' });
    }
  })();
});

// ── Block direct access to the backend's own folder before static
//    serving kicks in. Without this, express.static would happily
//    hand out server.js, db.js, routes/*.js, and — far worse —
//    data/regnum.db (which contains password hashes) to anyone who
//    requested /server/... over HTTP, since this server's own
//    folder lives inside the static root it serves.
app.use((req, res, next) => {
  if (/^\/server(\/|$)/i.test(req.path)) return res.status(404).end();
  next();
});

// ── Serve the static site (regnum-aeternum folder is one level up)
app.use(express.static(path.join(__dirname, '..'), { dotfiles: 'deny' }));

// ── Fallback for unknown routes → return 404 JSON for /api/, else 404 page
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).sendFile(path.join(__dirname, '..', 'index.html'));
});

// ── Start
const PORT = Number(process.env.PORT) || 3001;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\nRegnum Aeternum server running → http://localhost:${PORT}`);
    console.log('Admin panel → http://localhost:' + PORT + '/admin/\n');
  });
}).catch(err => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});
