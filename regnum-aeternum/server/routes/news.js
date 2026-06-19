'use strict';
const express = require('express');
const store   = require('../store');

const router = express.Router();

function requireStaff(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Authentication required.' });
  if (!['admin', 'editor'].includes(req.session.role))
    return res.status(403).json({ error: 'Editor or admin access required.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// GET /api/news/articles — public: published only
router.get('/articles', (req, res) => {
  res.json(store.listPublishedArticles());
});

// GET /api/news/articles/all — staff: everything, draft + published
router.get('/articles/all', requireStaff, (req, res) => {
  res.json(store.listAllArticles());
});

// GET /api/news/articles/:id — single article
router.get('/articles/:id', (req, res) => {
  const article = store.findArticleById(req.params.id);
  if (!article) return res.status(404).json({ error: 'Not found.' });
  if (article.status !== 'published') {
    if (!req.session.userId || !['admin', 'editor'].includes(req.session.role))
      return res.status(403).json({ error: 'Not published.' });
  }
  res.json(article);
});

// POST /api/news/articles — create (draft)
router.post('/articles', requireStaff, (req, res) => {
  const { title, subtitle, content } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required.' });

  const article = store.insertArticle({ title, subtitle, content, author: req.session.username });
  res.status(201).json({ id: article.id, title: article.title, status: article.status });
});

// PUT /api/news/articles/:id — update
router.put('/articles/:id', requireStaff, (req, res) => {
  const { title, subtitle, content } = req.body || {};
  const existing = store.findArticleById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });

  store.updateArticle(req.params.id, {
    title: title || existing.title,
    subtitle: subtitle ?? existing.subtitle,
    content: content || existing.content
  });
  res.json({ ok: true });
});

// PUT /api/news/articles/:id/publish
router.put('/articles/:id/publish', requireStaff, (req, res) => {
  const existing = store.findArticleById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  store.updateArticle(req.params.id, { status: 'published', published_at: new Date().toISOString() });
  res.json({ ok: true });
});

// PUT /api/news/articles/:id/unpublish
router.put('/articles/:id/unpublish', requireStaff, (req, res) => {
  const existing = store.findArticleById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  store.updateArticle(req.params.id, { status: 'draft' });
  res.json({ ok: true });
});

// DELETE /api/news/articles/:id — admin only
router.delete('/articles/:id', requireAdmin, (req, res) => {
  const ok = store.deleteArticle(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

module.exports = router;
