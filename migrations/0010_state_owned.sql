-- Regnum Aeternum — D1 schema addition: State-owned company flag
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0010_state_owned.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0010_state_owned.sql
--
-- Company accounts can be flagged as state-owned. This is offered at
-- creation time for public listings and can be toggled later via the
-- admin panel. Only admins may untick (remove state ownership).

ALTER TABLE banking_accounts ADD COLUMN state_owned INTEGER NOT NULL DEFAULT 0;
