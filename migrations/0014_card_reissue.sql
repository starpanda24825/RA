-- Regnum Aeternum — D1 schema addition: Card reissue requests
-- Migration 0014 — Banking System: citizen card lost/reissue self-service
--
-- Apply with (already-applied files are skipped):
--   wrangler d1 migrations apply regnum-aeternum-db --local
--   wrangler d1 migrations apply regnum-aeternum-db --remote
--
-- Lets citizens report a card lost from the banking website. Reporting a card
-- lost cancels it and flags a reissue request that a banker can see and fulfil
-- (by issuing a new card) from the admin panel or the CC Admin Terminal.
--
-- Card passwords are PBKDF2-only (worker/lib/passwords.js); the old CC-side
-- ASHA-512 hashing path has been retired, so there is a single credential
-- source of truth.

ALTER TABLE banking_cards ADD COLUMN reissue_requested    INTEGER NOT NULL DEFAULT 0;   -- 0 | 1
ALTER TABLE banking_cards ADD COLUMN reissue_reason       TEXT    NOT NULL DEFAULT '';
ALTER TABLE banking_cards ADD COLUMN reissue_requested_at TEXT    NOT NULL DEFAULT '';
