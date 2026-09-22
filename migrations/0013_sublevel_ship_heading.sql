-- Regnum Aeternum — D1 schema addition: Sublevel ship heading
-- Migration 0013 — Ballistics: ship orientation for mobile cannons
--
-- Apply with (already-applied files are skipped):
--   wrangler d1 migrations apply regnum-aeternum-db --local
--   wrangler d1 migrations apply regnum-aeternum-db --remote
--
-- A sublevel (mobile) cannon sits on a ship that can rotate. Two dedicated
-- computers run the "Sublevel Ship GPS" program (one FRONT/bow, one BACK/
-- stern) and broadcast their positions; the cannon computer listens to both,
-- derives the ship's heading, and pushes it on every poll.
--
-- ship_yaw uses the same convention as the rest of the calculator
-- (0 = south/+Z, 90 = west, 180 = north, 270 = east). It is NULL until both
-- receivers have reported a fix.

ALTER TABLE ballistics_cannons ADD COLUMN ship_yaw REAL;
