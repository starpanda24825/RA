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

// ── DynMap tile proxy (optional — use if the DynMap server blocks CORS)
//    Frontend requests: GET /api/maptile?path=/tiles/world/flat/z2/3_1.png
const DYNMAP_BASE = (process.env.DYNMAP_BASE_URL || 'https://mc.westeroscraft.com').replace(/\/$/, '');

app.get('/api/maptile', (req, res) => {
  const tilePath = req.query.path;
  if (!tilePath || !tilePath.startsWith('/tiles/')) {
    return res.status(400).send('Invalid tile path');
  }
  const url = DYNMAP_BASE + tilePath;
  const lib = url.startsWith('https') ? https : http;
  const request = lib.get(url, (upstreamRes) => {
    res.set('Content-Type', upstreamRes.headers['content-type'] || 'image/png');
    res.set('Cache-Control', 'public, max-age=60');
    upstreamRes.pipe(res);
  });
  request.on('error', () => res.status(502).send('Tile unavailable'));
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
