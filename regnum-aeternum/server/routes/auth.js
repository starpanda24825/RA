'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const store   = require('../store');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  try {
    const user = store.findUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

    const match = await bcrypt.compare(password, user.password_h);
    if (!match) return res.status(401).json({ error: 'Invalid credentials.' });

    req.session.userId   = user.id;
    req.session.role     = user.role;
    req.session.username = user.username;

    return res.json({ id: user.id, username: user.username, role: user.role });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
  return res.json({ id: req.session.userId, username: req.session.username, role: req.session.role });
});

module.exports = router;
