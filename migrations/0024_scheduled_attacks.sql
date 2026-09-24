-- 0024_scheduled_attacks.sql
-- Scheduled attack plans, and the one firing-order option they need stored.
--
-- 1. UNSYNCED MULTI-TARGET. Multi-Target normally SPLITS the queue: a target is
--    fired at once per cycle between all the guns, and a gun that finishes takes
--    the busiest target still outstanding. That spreads a barrage over the whole
--    list. The unsynced option is the other intention — every gun fires at every
--    target, once per cycle, each gun working through the list on its own. The
--    share-versus-every-gun choice changes what the queue MEANS, so it has to be
--    recorded on the order: the server feeds a scheduled order (0024, below) with
--    no page open, and it cannot ask an operator what they meant.
--
-- 2. SCHEDULED ATTACK PLANS. A standing order: the guns, the targets, the mode,
--    and the moment it should open fire. A Worker cron launches it at that
--    moment and keeps feeding it, so it fires with nobody watching and no
--    calculator page open — which is the point, because the moment an attack is
--    wanted is usually a moment nobody is at a screen.
--
--    The shot solving lives in the browser normally. For an unattended order it
--    cannot, so the same arithmetic is mirrored in worker/lib/ballistics-solver.js
--    and runs there instead, against whatever each gun last reported as its
--    position — so a gun that has moved since the plan was written is still
--    aimed from where it actually is.
--
--    Launching does not invent a second firing machine: it opens an ordinary row
--    in ballistics_fire_plans and points `fire_plan_id` at it, so a scheduled
--    attack drains through exactly the same queue, is visible on the Calculator's
--    live map, and lands in the Firing Log like any other order.
--
--    `state` is the attack plan's own lifecycle, separate from the fire plan's:
--      scheduled  waiting for its moment
--      running    launched; the cron is still feeding its queue
--      done       the fire plan finished or was stopped
--      cancelled  called off before it ever fired
--
-- Apply with:
--   npx wrangler d1 migrations apply regnum-aeternum-db --remote

-- 1. The share/every-gun choice on a live firing order.
ALTER TABLE ballistics_fire_plans ADD COLUMN unsynced INTEGER NOT NULL DEFAULT 0;

-- 2. The standing orders themselves.
CREATE TABLE IF NOT EXISTS ballistics_attack_plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,

  name         TEXT    NOT NULL DEFAULT '',

  -- The same fields a hand-fired order carries: how the guns fire, how many
  -- passes, and at what. `targets` / `guns` are JSON, in the shape
  -- ballistics_fire_plans uses, so launching copies them straight across.
  mode         TEXT    NOT NULL DEFAULT 'normal',   -- normal | constant | multi
  cycles       INTEGER NOT NULL DEFAULT 1,
  targets      TEXT    NOT NULL DEFAULT '[]',       -- JSON [{ key, x, y, z, label }]
  guns         TEXT    NOT NULL DEFAULT '[]',       -- JSON [{ cannonId }]
  trajectory   TEXT,                                -- optimal | direct
  drag         REAL,
  charges      INTEGER,
  unsynced     INTEGER NOT NULL DEFAULT 0,          -- multi-target: every gun, every target

  -- When it should open fire (ISO-8601, UTC) and where it is in its life.
  scheduled_at TEXT    NOT NULL DEFAULT '',
  state        TEXT    NOT NULL DEFAULT 'scheduled'
               CHECK (state IN ('scheduled', 'running', 'done', 'cancelled')),

  -- The live order this plan opened when it launched, or NULL until it does.
  fire_plan_id INTEGER,

  created_by   TEXT,
  launched_at  TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

-- The cron's only hot query is "which plans are due", so it leads with state.
CREATE INDEX IF NOT EXISTS idx_bap_due ON ballistics_attack_plans(state, scheduled_at);
