-- 0023_ballistics_targets.sql
-- Named targets, and a hidden flag for the three things an order can name.
--
-- WHY A TARGET REGISTRY. Coordinates used to live nowhere but the operator's
-- own screen: they were typed in, or clicked onto the map, for one order and
-- then forgotten. Two consequences of that were bad. Every officer re-derived
-- the same battery positions by hand, and a scheduled attack (0024) had no way
-- to say what it was aimed at, because it has no page to read coordinates off.
-- So a target is stored here with a name, like a cannon is: it can be picked
-- from a list, clicked onto the map, renamed, moved and deleted.
--
-- WHY A HIDDEN FLAG. The secret panel needs a place to keep the things it does
-- not want every ballistics-cleared officer to see — a battery not yet
-- announced, a firing position used by one crew. `hidden = 1` takes an entry
-- out of every response whose reader does not hold the 'ballistics-secret'
-- role; that filtering is done in the worker, not in the page, so the entry
-- never reaches a client that is not entitled to it.
--
-- Hiding is deliberately NOT the same as deleting: the cannons are real
-- hardware, a hidden cannon keeps its row, its identity and its assignment to
-- its vehicle, and simply stops being listed to anyone outside the role.
--
-- `created_by` records the officer so the secret panel can show who put a
-- target there; it is never used as an access check (targets are shared, like
-- every other registry here).
--
-- Apply with:
--   npx wrangler d1 migrations apply regnum-aeternum-db --remote

CREATE TABLE IF NOT EXISTS ballistics_targets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Display name. Required: the whole point of the registry is that a target
  -- can be referred to by something other than three numbers.
  name       TEXT    NOT NULL DEFAULT '',

  -- Where the target is, in the same world coordinates the calculator works
  -- in. Y defaults to 64 (sea level) when an officer only knows X and Z.
  x          REAL    NOT NULL DEFAULT 0,
  y          REAL    NOT NULL DEFAULT 64,
  z          REAL    NOT NULL DEFAULT 0,

  -- 1 = only officers holding 'ballistics-secret' see this target.
  hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),

  created_by TEXT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bt_hidden ON ballistics_targets(hidden, name);

-- The same hidden flag on the two registries whose rows arrive from the game
-- rather than from the website. A hidden cannon is still polled, still aimed
-- and still fired exactly as before — it is only withheld from readers without
-- the secret role.
ALTER TABLE ballistics_cannons  ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ballistics_vehicles ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
