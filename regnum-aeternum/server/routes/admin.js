'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const store   = require('../store');

const router = express.Router();

const VALID_ROLES = ['citizen', 'ballistics', 'editor', 'admin'];

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// GET /api/admin/users
router.get('/users', requireAdmin, (req, res) => {
  res.json(store.listUsers());
});

// POST /api/admin/users — create user
router.post('/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  if (role && !VALID_ROLES.includes(role))
    return res.status(400).json({ error: 'Invalid role.' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const user = store.insertUser({ username, password_h: hash, role: role || 'citizen' });
    res.status(201).json({ id: user.id, username: user.username, role: user.role });
  } catch (err) {
    if (err.code === 'UNIQUE') return res.status(409).json({ error: 'Username already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// PUT /api/admin/users/:id — update role and/or password
router.put('/users/:id', requireAdmin, async (req, res) => {
  const { role, password } = req.body || {};
  if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

  const fields = {};
  if (role) fields.role = role;
  if (password) fields.password_h = await bcrypt.hash(password, 12);

  const updated = store.updateUser(req.params.id, fields);
  if (!updated) return res.status(404).json({ error: 'User not found.' });
  res.json({ id: updated.id, username: updated.username, role: updated.role, created_at: updated.created_at });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.session.userId)
    return res.status(400).json({ error: 'Cannot delete your own account.' });

  const ok = store.deleteUser(req.params.id);
  if (!ok) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

module.exports = router;
