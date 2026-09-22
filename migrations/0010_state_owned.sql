-- Regnum Aeternum — D1 schema addition: State-owned company flag
-- Apply with (already-applied files are skipped):
--   wrangler d1 migrations apply regnum-aeternum-db --local
--   wrangler d1 migrations apply regnum-aeternum-db --remote
--
-- Company accounts can be flagged as state-owned. This is offered at
-- creation time for public listings and can be toggled later via the
-- admin panel. Only admins may untick (remove state ownership).

ALTER TABLE banking_accounts ADD COLUMN state_owned INTEGER NOT NULL DEFAULT 0;
