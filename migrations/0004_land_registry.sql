-- Regnum Aeternum — D1 schema addition: Land Registry System
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0004_land_registry.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0004_land_registry.sql
--
-- Storage shape mirrors legal_acts (0002_legal.sql): flat, filterable
-- columns (register_number, division_code, world, owner, resident,
-- status, the y-range) live as real columns; everything else (the 4
-- corner coordinates, plot type, rent details, notes) is a JSON blob
-- in `data`. worker/routes/landregistry.js reassembles the public
-- shape regnum-aeternum/land-registry/assets/land-registry-app.js and
-- the cadastral map (land-registry/map/) expect.
--
-- register_number is the realm's register identifier, e.g.
-- "RA1M/00000123/4" — DIVISION/BOOKNUMBER(8 digits)/CONTROLDIGIT(1
-- digit), matching the numbering scheme already in use by the
-- reference search tool this system replaces. It is the primary key
-- and, once a plot is created, division/book/control are immutable
-- (the same convention as legal_acts.slug) — admins recreate the
-- record under a new number if a plot's register number is wrong.
--
-- Corners are stored as an array of 4 {x,z} points (plots are NOT
-- fixed 16x16 chunks — they're arbitrary quadrilaterals). y_lower/
-- y_upper give the plot's vertical extent. The cadastral map draws
-- the real quadrilateral in its 2D (DynMap tile) view, but collapses
-- each plot to its axis-aligned bounding box when rendering the 3D
-- cube view — see land-registry/map/index.html for why.

CREATE TABLE IF NOT EXISTS land_plots (
  register_number TEXT PRIMARY KEY,
  division_code   TEXT NOT NULL,              -- RA1M | RA2V | RA3D | RA4L | RA5A
  book_number     TEXT NOT NULL,               -- 8-digit, zero-padded
  control_digit   TEXT NOT NULL,               -- single digit, 0-9
  world           TEXT NOT NULL DEFAULT '',    -- Minecraft world name (DynMap)
  owner           TEXT NOT NULL DEFAULT '',
  resident        TEXT NOT NULL DEFAULT '',    -- may differ from owner (tenant, steward, etc.)
  is_rented       INTEGER NOT NULL DEFAULT 0,
  y_lower         INTEGER NOT NULL DEFAULT 0,
  y_upper         INTEGER NOT NULL DEFAULT 255,
  status          TEXT NOT NULL DEFAULT 'registered', -- registered | vacant | disputed | archived
  data            TEXT NOT NULL,                -- JSON: { corners[4], plotType, renter, rentAmount, rentCurrency, rentDueDate, registeredDate, notes }
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_land_plots_division ON land_plots(division_code);
CREATE INDEX IF NOT EXISTS idx_land_plots_world    ON land_plots(world);
CREATE INDEX IF NOT EXISTS idx_land_plots_owner    ON land_plots(owner);
CREATE INDEX IF NOT EXISTS idx_land_plots_status   ON land_plots(status);

-- ============================================================
-- Seed data — five worked examples, one per division, plus a pair
-- of plots stacked on the exact same footprint (RA3D/00000005/1 and
-- /2: a cellar and the shop built over it) to demonstrate the
-- cadastral map's "only the topmost plot is drawn in 2D when plots
-- overlap" behaviour. Mirrored verbatim in the offline static
-- fallback at land-registry/assets/land-registry-data.js so the
-- live (D1-backed) site and the no-backend fallback agree.
-- ============================================================

INSERT INTO land_plots (register_number, division_code, book_number, control_digit, world, owner, resident, is_rented, y_lower, y_upper, status, data, created_at, updated_at)
VALUES (
  'RA1M/00000001/7', 'RA1M', '00000001', '7', 'world', 'Liora Ashgrove', 'Liora Ashgrove', 0, 63, 80, 'registered',
  '{"corners":[{"x":120,"z":340},{"x":136,"z":340},{"x":136,"z":356},{"x":120,"z":356}],"plotType":"residential","renter":"","rentAmount":0,"rentCurrency":"","rentDueDate":"","registeredDate":"2025-04-11","notes":"Timber cottage and kitchen garden near the Ardoritha market square."}',
  '2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z'
);

INSERT INTO land_plots (register_number, division_code, book_number, control_digit, world, owner, resident, is_rented, y_lower, y_upper, status, data, created_at, updated_at)
VALUES (
  'RA2V/00000014/3', 'RA2V', '00000014', '3', 'world', 'Mireille Costanza', 'Tobias Wren', 1, 63, 90, 'registered',
  '{"corners":[{"x":-220,"z":58},{"x":-196,"z":58},{"x":-196,"z":82},{"x":-220,"z":82}],"plotType":"commercial","renter":"Tobias Wren","rentAmount":40,"rentCurrency":"crowns","rentDueDate":"2026-07-01","registeredDate":"2025-09-02","notes":"The Salt Anchor tavern, let to its current keeper on a standing lease."}',
  '2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z'
);

INSERT INTO land_plots (register_number, division_code, book_number, control_digit, world, owner, resident, is_rented, y_lower, y_upper, status, data, created_at, updated_at)
VALUES (
  'RA3D/00000005/1', 'RA3D', '00000005', '1', 'world', 'Hendrick Vass', 'Hendrick Vass', 0, 50, 62, 'registered',
  '{"corners":[{"x":400,"z":120},{"x":416,"z":120},{"x":416,"z":136},{"x":400,"z":136}],"plotType":"storage","renter":"","rentAmount":0,"rentCurrency":"","rentDueDate":"","registeredDate":"2025-11-19","notes":"Sealed cellar vault beneath the Meridia bookbindery. Same footprint as RA3D/00000005/2, one level down."}',
  '2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z'
);

INSERT INTO land_plots (register_number, division_code, book_number, control_digit, world, owner, resident, is_rented, y_lower, y_upper, status, data, created_at, updated_at)
VALUES (
  'RA3D/00000005/2', 'RA3D', '00000005', '2', 'world', 'Hendrick Vass', 'Hendrick Vass', 0, 63, 85, 'registered',
  '{"corners":[{"x":400,"z":120},{"x":416,"z":120},{"x":416,"z":136},{"x":400,"z":136}],"plotType":"commercial","renter":"","rentAmount":0,"rentCurrency":"","rentDueDate":"","registeredDate":"2025-11-19","notes":"Meridia bookbindery and the owner''s upstairs apartment. Built directly over the vault at RA3D/00000005/1 — the map shows this one in its flat view since it is the topmost of the pair."}',
  '2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z'
);

INSERT INTO land_plots (register_number, division_code, book_number, control_digit, world, owner, resident, is_rented, y_lower, y_upper, status, data, created_at, updated_at)
VALUES (
  'RA4L/00000002/0', 'RA4L', '00000002', '0', 'world', '', '', 0, 62, 78, 'vacant',
  '{"corners":[{"x":-60,"z":-410},{"x":-40,"z":-410},{"x":-40,"z":-392},{"x":-60,"z":-392}],"plotType":"vacant","renter":"","rentAmount":0,"rentCurrency":"","rentDueDate":"","registeredDate":"2026-01-30","notes":"Cleared harbourside lot, surveyed but not yet claimed."}',
  '2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z'
);

INSERT INTO land_plots (register_number, division_code, book_number, control_digit, world, owner, resident, is_rented, y_lower, y_upper, status, data, created_at, updated_at)
VALUES (
  'RA5A/00000010/5', 'RA5A', '00000010', '5', 'world', 'Order of the Sandwrought Vine', 'Order of the Sandwrought Vine', 0, 61, 70, 'registered',
  '{"corners":[{"x":610,"z":-140},{"x":660,"z":-140},{"x":660,"z":-96},{"x":610,"z":-96}],"plotType":"agricultural","renter":"","rentAmount":0,"rentCurrency":"","rentDueDate":"","registeredDate":"2025-07-08","notes":"Terraced vineyard held in common by the Order. Boundary follows the old irrigation ditch, not a chunk grid."}',
  '2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z'
);
