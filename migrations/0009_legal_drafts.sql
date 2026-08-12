-- Regnum Aeternum — D1 schema addition: Legal drafts (Adapter workflow)
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0009_legal_drafts.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0009_legal_drafts.sql
--
-- Users with the "adapter" role can open the Legal Information System
-- editor but may only *suggest drafts* — nothing they write is published.
-- Drafts live here, fully separate from legal_acts / legal_case_law, so a
-- draft can never leak into the public dataset (which currently selects
-- all rows from those two tables). Admins review drafts in the admin
-- panel's "Draft Review" tab and may request changes, edit, or publish
-- them; publishing copies the payload into the live table.

CREATE TABLE IF NOT EXISTS legal_drafts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,                 -- 'act' | 'case'
  target_slug   TEXT,                          -- slug of the live doc being amended; NULL for brand-new docs
  title         TEXT NOT NULL,                 -- display title for the review list
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | changes_requested | published | rejected
  author        TEXT NOT NULL,                 -- username of the adapter who proposed it
  payload       TEXT NOT NULL,                 -- JSON: the full act/case body (same shape as the write endpoints)
  reviewer_note TEXT,                          -- admin comment / requested changes
  reviewed_by   TEXT,                          -- username of the reviewing admin
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_legal_drafts_status ON legal_drafts(status);
