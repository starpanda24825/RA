-- Regnum Aeternum — D1 schema addition: GPS tower network
-- Migration 0015 — Ballistics: GPS tower registry + per-cannon network health
--
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0015_gps_network.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0015_gps_network.sql
--
-- The GPS network is solved ENTIRELY on the computers (see
-- luatxtfiles/Cannon Programs/GPS Network V1.txt). Nothing about a fix is
-- sent here, so server load does not grow with the number of receivers or the
-- number of towers, however large the network becomes.
--
-- What the website does keep is the part that belongs on a website: a
-- registry of the tower network and a view of its health. Computers report
-- this by piggy-backing on the cannon poll they already make every second, so
-- it costs no extra requests at all.
-- ============================================================

-- Every GPS tower any cannon has heard from. Written only when a client
-- reports a tower list that has CHANGED (or once a minute as a safety net), so
-- in practice this table is touched a handful of times, not once a second.
CREATE TABLE IF NOT EXISTS ballistics_gps_towers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- "x,y,z" of the block the MODEM is on — the point CC measures distances
  -- from, and the only identity a stock GPS host reveals. Two towers in the
  -- same block are indistinguishable to every client, so this is the key.
  tower_key       TEXT    NOT NULL UNIQUE,

  x               REAL    NOT NULL,
  y               REAL    NOT NULL,
  z               REAL    NOT NULL,

  -- Number of poll reports that included this tower. A tower that stops
  -- appearing has gone dark (chunk unloaded, destroyed, or out of range).
  sightings       INTEGER NOT NULL DEFAULT 0,

  -- Times a client had to EXCLUDE this tower because its measurements did not
  -- fit the rest of the network — the tell-tale of a tower that has been
  -- moved, is mis-keyed, or is answering with stale coordinates. This is the
  -- number to look at when aim goes strange.
  excluded_count  INTEGER NOT NULL DEFAULT 0,

  -- The computer id of the cannon that last reported it.
  reported_by     TEXT    NOT NULL DEFAULT '',

  first_seen_at   TEXT    NOT NULL,
  last_seen_at    TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bgt_last_seen ON ballistics_gps_towers(last_seen_at);

-- Latest GPS health report from each cannon, as a JSON blob:
--   { ok, quality, dop, residual, towers, seen, age, stale,
--     shipSkew, excluded[], reason }
-- Kept as a blob rather than a column per field because it is a status
-- snapshot for display, not something we ever query or aggregate on.
ALTER TABLE ballistics_cannons ADD COLUMN gps_report TEXT;
