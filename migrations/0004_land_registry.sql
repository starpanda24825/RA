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
--
-- No seed rows: this office starts empty and is populated entirely
-- from the admin panel's Land Registry tab.

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
