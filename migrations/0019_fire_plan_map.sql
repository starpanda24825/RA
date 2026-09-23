-- 0019_fire_plan_map.sql
-- What the live map needs in order to draw a firing order and animate its shells.
--
-- Two separate problems, one file, because both are display metadata on the
-- firing order rather than new behaviour.
--
-- 1. THE PLAN'S LAUNCH PARAMETERS. A shot row records the aim it was fired with
--    (yaw and pitch), so the direction of any shot can be redrawn from the shot
--    itself. The SHAPE and TIMING of the flight cannot: those depend on the
--    muzzle velocity (powder charges) and the shell's drag, which live on the
--    plan. The page freezes them when the order is opened, so they are recorded
--    there — that also means a second officer, or the same one after a reload,
--    replays exactly the shots that are being fired rather than whatever their
--    own sliders happen to say.
--
-- 2. WHEN A SHOT ACTUALLY LEFT THE BARREL. `done_at` is not it: a cannon acks a
--    sequence the moment it CLAIMS it, before disassembling, reloading, aiming
--    and firing, which is several seconds earlier. Anchoring a shell animation
--    to that would fly the shell during the reload. A cannon now reports the
--    instant it fires (os.epoch("utc")), which is recorded here.
--
--    Nullable on purpose: a computer still running the previous version of the
--    program reports no fire time, and the page falls back to `done_at` and says
--    the timing is estimated rather than pretending to be exact.
--
-- Apply with:
--   npx wrangler d1 migrations apply regnum-aeternum-db --remote

ALTER TABLE ballistics_fire_plans ADD COLUMN drag       REAL;
ALTER TABLE ballistics_fire_plans ADD COLUMN charges    INTEGER;
ALTER TABLE ballistics_fire_plans ADD COLUMN trajectory TEXT;

ALTER TABLE ballistics_fire_queue ADD COLUMN fired_at TEXT;
