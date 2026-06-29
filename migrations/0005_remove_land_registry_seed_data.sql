-- Regnum Aeternum — D1 schema fixup: remove Land Registry example data
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0005_remove_land_registry_seed_data.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0005_remove_land_registry_seed_data.sql
--
-- migrations/0004_land_registry.sql used to seed 6 worked examples.
-- That seeding was removed from 0004 itself, but if you already ran
-- 0004 against your D1 database before that change, those rows are
-- still sitting in it. This migration deletes them by register
-- number. Safe to run even if you never had the seed rows (or have
-- already deleted them) — DELETE on a non-existent row is a no-op.
--
-- This does NOT touch any real plot you've since registered through
-- the admin panel, even if its register number happens to collide
-- with one of these (unlikely, but in that case re-create it after
-- running this).

DELETE FROM land_plots WHERE register_number IN (
  'RA1M/00000001/7',
  'RA2V/00000014/3',
  'RA3D/00000005/1',
  'RA3D/00000005/2',
  'RA4L/00000002/0',
  'RA5A/00000010/5'
);
