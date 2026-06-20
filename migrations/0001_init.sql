-- Regnum Aeternum — D1 schema (initial migration)
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0001_init.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL,            -- original casing, for display
  username_lower TEXT NOT NULL UNIQUE,     -- lowercased, enforces case-insensitive uniqueness
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'citizen',  -- citizen | ballistics | editor | admin
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  subtitle     TEXT DEFAULT '',
  content      TEXT NOT NULL,
  author       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | published
  created_at   TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
