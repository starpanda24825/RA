-- Regnum Aeternum — D1 schema addition: cannon reload presets
-- Migration 0017 — Ballistics: website-managed reload mechanisms
--
-- Apply with (already-applied files are skipped):
--   wrangler d1 migrations apply regnum-aeternum-db --local
--   wrangler d1 migrations apply regnum-aeternum-db --remote
--
-- The Sublevel Cannon Computer's first-boot setup offers two reload methods —
-- an auto-loader (reloads between disassemble and assemble) and a mechanical
-- arm (reloads after the cannon is assembled) — with the timings typed in by
-- hand at the cannon. Any other mechanism meant guessing those numbers there,
-- with nothing to consult and no way to record what worked.
--
-- This is the registry of named reload mechanisms saved here instead. The
-- cannon computer pulls the list at setup and picks one, so every mechanism
-- the Crown has worked out is reusable from any cannon, and a 'custom' entry
-- in the same menu still allows a one-off set of timings.
-- ============================================================

CREATE TABLE IF NOT EXISTS ballistics_reload_presets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Shown in the setup menu on the cannon computer, and here.
  name         TEXT    NOT NULL UNIQUE,

  -- WHERE in the firing sequence the reload happens. This is what makes two
  -- mechanisms behave differently: 'between' reloads between disassemble and
  -- assemble (what the auto-loader does), 'after' reloads once the cannon has
  -- been assembled again (what the mechanical arm does).
  kind         TEXT    NOT NULL DEFAULT 'between'
               CHECK (kind IN ('between', 'after')),

  -- Seconds allowed for the mechanism to do its work. Unlike the built-in
  -- methods this is a real number, seconds may be fractional.
  reload_time  REAL    NOT NULL DEFAULT 1.0,

  -- Seconds the redstone trigger is held. Only used by a mechanism driven by
  -- a pulse; harmless for one that is not.
  pulse        REAL    NOT NULL DEFAULT 0.5,

  -- What the mechanism actually is, in the officer's words, so the next officer
  -- reading the menu knows what they are choosing.
  notes        TEXT    NOT NULL DEFAULT '',

  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brp_name ON ballistics_reload_presets(name);
