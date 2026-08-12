-- Regnum Aeternum — D1 schema addition: Times of Regnum — Newspapers
-- Migration 0007 — Newspaper layout documents
--
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0007_newspapers.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0007_newspapers.sql

CREATE TABLE IF NOT EXISTS newspapers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'published')),
  author      TEXT    NOT NULL DEFAULT '',
  -- Full newspaper layout as JSON (masthead, sections, page dimensions)
  layout_json TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_newspapers_status ON newspapers(status);
CREATE INDEX IF NOT EXISTS idx_newspapers_published ON newspapers(published_at DESC);
