-- 0020_gun_reload.sql
-- Reload state per gun, for the live map's per-gun reload indicator.
--
-- THE PROBLEM. The map shows a shell travelling along its trajectory, but a gun
-- spends most of a barrage reloading rather than firing, and nothing on the
-- website knew how long that takes. The reload mechanism lives on the cannon
-- computer in subcannon_cfg.txt (reloadType + reloadTime) and had never been
-- reported anywhere.
--
-- 1. THE RELOAD WINDOW OF A SHOT. A cannon reloads ITSELF only in one case: a
--    mechanical-arm shot in a multi-shot run, where the arm reloads during the
--    stand-down after firing and the cannon is left assembled and loaded for
--    the shot that follows. Every other case (a single shot, an auto-loader,
--    the last shot of a run) leaves the cannon DISASSEMBLED — its reload
--    happens inside the next command instead, so there is no wall-clock instant
--    to count down to.
--
--    That distinction is the cannon's own business, not the website's: the
--    program knows its mechanism, its reload time and whether another shot
--    follows, so it reports the answer as ONE number alongside the fire time it
--    already sends — milliseconds after that instant at which it will be loaded
--    again, or 0 when it left itself unloaded. The website does not re-derive it
--    from timings hard-coded here, so the two can never disagree.
--
--    Nullable on purpose: it arrives on the same poll as `fired_at`, so a
--    computer running the previous version of the program reports neither and
--    the map shows no ring rather than a confidently wrong one.
--
-- 2. THE GUN'S RELOAD PROFILE. Reported continuously (not per shot) so the map
--    can say WHICH mechanism a gun has and why it is or is not counting down:
--    "mechanical arm · reloads in place" against "auto-loader · reloads inside
--    the next order".
--
-- Apply with:
--   npx wrangler d1 migrations apply regnum-aeternum-db --remote

ALTER TABLE ballistics_fire_queue ADD COLUMN reload_ms INTEGER;

ALTER TABLE ballistics_cannons ADD COLUMN reload_type TEXT;   -- 'arm' | 'autoloader'
ALTER TABLE ballistics_cannons ADD COLUMN reload_time REAL;   -- reload delay, seconds
