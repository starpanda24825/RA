-- Regnum Aeternum — D1 schema addition: Sublevel Vehicle Registry
-- Migration 0016 — Ballistics: vehicles + cannon-to-vehicle assignment
--
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0016_vehicle_registry.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0016_vehicle_registry.sql
--
-- A sublevel (mobile) ship can carry several cannons, each with its own
-- Sublevel Cannon Computer. Those computers are coordinated by ONE
-- "Sublevel Vehicle Computer", which owns the ship's heading (from the two
-- Ship GPS beacons) and hands each cannon its final aim. This is the
-- registry for those vehicle computers, so an officer can accept the
-- vehicle and then assign cannons to it.
--
-- A vehicle computer self-registers exactly like a cannon does: its first
-- poll creates a 'pending' row here, and nothing happens until an officer
-- accepts it on the Ballistic Calculator's Vehicle Registry tab.
-- ============================================================

CREATE TABLE IF NOT EXISTS ballistics_vehicles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Stable identity of the vehicle computer (os.getComputerID(), or a
  -- persisted UUID). One row per physical vehicle computer.
  computer_id     TEXT    NOT NULL UNIQUE,

  -- Display name. Empty until accepted, at which point it is given the next
  -- free "Vehicle N" default; officers can rename it afterwards.
  name            TEXT    NOT NULL DEFAULT '',

  -- Notes the vehicle computer sent about itself (its cannons, mount, etc.).
  message         TEXT    NOT NULL DEFAULT '',

  -- 'pending' until an officer accepts it, then 'active'. Only an ACTIVE
  -- vehicle may take control of cannons.
  status          TEXT    NOT NULL DEFAULT 'pending',

  -- The ship's heading the vehicle last derived from the two GPS beacons,
  -- in the website's convention (0 = south, 90 = west, 180 = north,
  -- 270 = east). NULL until both beacons have reported a fix.
  ship_yaw        REAL,

  last_seen_at    TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bv_status ON ballistics_vehicles(status);

-- Which vehicle a cannon belongs to. NULL = the cannon runs standalone,
-- executing its own commands with its own heading, exactly as before this
-- migration. Set = the vehicle computer owns the cannon's heading and
-- command delivery, and the cannon computer only applies the values it is
-- given.
--
-- No foreign key: a deleted vehicle must not cascade into deleting cannons
-- (the cannons are real hardware). Deleting a vehicle clears this column.
ALTER TABLE ballistics_cannons ADD COLUMN vehicle_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_bc_vehicle ON ballistics_cannons(vehicle_id);
