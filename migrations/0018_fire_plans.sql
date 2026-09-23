-- 0018_fire_plans.sql
-- Bombardment modes. A PLAN is one ordered firing order — Normal, Constant or
-- Multi-Target — and its QUEUE holds the individual shots that plan is made of.
--
-- Why a queue rather than the single command slot already on the cannon: a
-- cannon computer only acks a sequence once it has fired it, so the next shot
-- can only be handed over when the previous one is done. Holding the rest of
-- the plan server-side means the next shot is already waiting the moment the
-- gun acks, so a multi-gun sequence has no dead time between shots and no
-- browser round trip has to happen in the middle of it — and the plan keeps
-- draining even if the operator's page is closed.
--
-- `targets` and `guns` are JSON snapshots of what was selected, so a page that
-- is reloaded mid-barrage can rebuild its scheduler and carry on feeding.
--
-- Apply with:
--   npx wrangler d1 migrations apply regnum-aeternum-db --remote

CREATE TABLE IF NOT EXISTS ballistics_fire_plans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mode       TEXT    NOT NULL DEFAULT 'normal',   -- normal | constant | multi
  state      TEXT    NOT NULL DEFAULT 'running',  -- running | paused | stopped | done
  cycles     INTEGER NOT NULL DEFAULT 1,          -- multi-target: passes over the list
  targets    TEXT,                                -- JSON [{ key, x, y, z, label }]
  guns       TEXT,                                -- JSON [{ cannonId, vehicleId, name }]
  crew       TEXT,                                -- officer the plan belongs to (display)
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS ballistics_fire_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id      INTEGER NOT NULL,
  cannon_id    INTEGER NOT NULL,
  yaw          REAL    NOT NULL,
  pitch        REAL    NOT NULL,
  burst        INTEGER NOT NULL DEFAULT 0,  -- shot belongs to a multi-shot run
  more         INTEGER NOT NULL DEFAULT 0,  -- another shot follows: stay assembled
  target_key   TEXT,                        -- which target this shot is for
  sequence     INTEGER NOT NULL DEFAULT 0,  -- cannon sequence it was handed out as
  state        TEXT    NOT NULL DEFAULT 'pending',  -- pending | delivered | done | cancelled
  created_at   TEXT    NOT NULL,
  delivered_at TEXT,
  done_at      TEXT
);

-- The hot path is "next pending shot for this cannon", and stop/pause sweeps a
-- whole plan, so both are indexed on the columns those queries lead with.
CREATE INDEX IF NOT EXISTS idx_bfq_cannon ON ballistics_fire_queue (cannon_id, state, id);
CREATE INDEX IF NOT EXISTS idx_bfq_plan   ON ballistics_fire_queue (plan_id, state);
