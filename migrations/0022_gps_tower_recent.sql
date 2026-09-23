-- Regnum Aeternum — D1 schema addition: GPS tower health that clears itself
-- Migration 0022 — recent-window exclusion counts for the tower registry
--
-- Apply with (already-applied files are skipped):
--   wrangler d1 migrations apply regnum-aeternum-db --local
--   wrangler d1 migrations apply regnum-aeternum-db --remote
--
-- WHY
--   The registry used to judge a tower by its LIFETIME exclusion count, and the
--   website showed a red "Suspect" badge the moment that count was 1. That is a
--   badge nobody can clear and nobody can act on: a tower is left out of a fix
--   for all sorts of ordinary reasons (its geometry from where the receiver is
--   standing, one slow reply out of thousands, a single bad measurement), and
--   once flagged it stayed flagged for ever — including towers that had been
--   moved, whose OLD position sits in the table as a ghost and keeps being
--   blamed for fixes it can no longer be part of.
--
--   So the lifetime totals stay (they are useful history), and three columns are
--   added to judge a tower by its RECENT behaviour instead:
--
--   excluded_recent  exclusions inside the current window
--   recent_at        when that window started (reset when the window rolls over)
--   excluded_at      when that tower was last left out at all
--
--   A tower is only called out on the website when it has been left out
--   REPEATEDLY inside one window, and the warning then clears on its own. A
--   tower that has stopped answering entirely leaves the registry quietly: the
--   computers only report towers they have heard from recently (see
--   luatxtfiles/Cannon Programs/GPS Network V1.txt), so last_seen_at stops
--   moving and the tower ages off the list.
-- ============================================================

ALTER TABLE ballistics_gps_towers ADD COLUMN excluded_recent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ballistics_gps_towers ADD COLUMN recent_at TEXT;
ALTER TABLE ballistics_gps_towers ADD COLUMN excluded_at TEXT;
