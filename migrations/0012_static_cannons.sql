-- Regnum Aeternum — D1 schema addition: Static Cannon Control
-- Migration 0012 — Ballistics: ComputerCraft static cannon registry
--
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0012_static_cannons.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0012_static_cannons.sql
--
-- A static cannon is a cannon built on a fixed (non-sublevel) mount whose
-- aim is driven by an in-game ComputerCraft computer running the Cannon
-- Computer program (luatxtfiles/Cannon Computer.txt). The computer pings
-- /api/ballistics/cc/poll to register itself (open self-registration) and
-- to poll for fire commands. Requests sit in 'pending' until an officer
-- accepts them from the Ballistic Calculator's Cannon Registry tab; declined
-- requests are simply deleted.
-- ============================================================

CREATE TABLE IF NOT EXISTS ballistics_cannons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Stable identity of the in-game CC computer. The Lua program uses
  -- os.getComputerID() when the server assigns non-zero IDs, otherwise a
  -- persisted random UUID (cannon_id.txt). One cannon per computer.
  computer_id     TEXT    NOT NULL UNIQUE,

  -- Display name. Assigned automatically ("Cannon 1", "Cannon 2", …) when a
  -- pending request is accepted; editable from the registry tab afterwards.
  name            TEXT    NOT NULL DEFAULT '',

  -- Cannon mount block position reported by the CC computer (getX/getY/getZ).
  x               REAL    NOT NULL DEFAULT 0,
  y               REAL    NOT NULL DEFAULT 0,
  z               REAL    NOT NULL DEFAULT 0,

  -- Number of blocks between the mount-held block and the muzzle, inclusive.
  length          INTEGER NOT NULL DEFAULT 4,

  -- Base yaw (degrees, Minecraft convention: 0 = south/+Z, 90 = west,
  -- 180 = north, 270 = east) the cannon faces when assembled in its
  -- resting position. Mirrors the calculator's "Cannon Facing" dropdown.
  facing          REAL    NOT NULL DEFAULT 0,

  -- 0 = normal world; 1 = sublevel (Sable / VS ship) where the reported
  -- coordinates are shipyard-relative and do not map onto the world map.
  -- Static cannons register with sublevel = false; mobile/sublevel cannons
  -- get a separate flow later.
  sublevel        INTEGER NOT NULL DEFAULT 0 CHECK (sublevel IN (0, 1)),

  -- Free-text note supplied by whoever set up the cannon in-game.
  message         TEXT    NOT NULL DEFAULT '',

  -- 'pending' = pinged but not yet accepted on the website;
  -- 'active'  = accepted and eligible to receive fire commands.
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'active')),

  -- Heartbeat + last reported aim state (used for the online/offline badge).
  last_seen_at    TEXT    NOT NULL DEFAULT '',
  last_yaw        REAL    NOT NULL DEFAULT 0,
  last_pitch      REAL    NOT NULL DEFAULT 0,

  -- Pending fire command. command_sequence is a monotonically increasing id
  -- per cannon; acked_sequence is the last one the computer confirmed it
  -- executed. A command is delivered while
  --     command_sequence > 0 AND acked_sequence < command_sequence.
  command_sequence INTEGER NOT NULL DEFAULT 0,
  command_yaw       REAL    NOT NULL DEFAULT 0,
  command_pitch     REAL    NOT NULL DEFAULT 0,
  command_fire      INTEGER NOT NULL DEFAULT 0 CHECK (command_fire IN (0, 1)),
  command_at        TEXT    NOT NULL DEFAULT '',
  acked_sequence    INTEGER NOT NULL DEFAULT 0,

  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bc_cannons_status   ON ballistics_cannons(status);
CREATE INDEX IF NOT EXISTS idx_bc_cannons_computer ON ballistics_cannons(computer_id);
