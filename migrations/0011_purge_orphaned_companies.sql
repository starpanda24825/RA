-- Regnum Aeternum — D1 data cleanup: purge orphaned exchange companies
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0011_purge_orphaned_companies.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0011_purge_orphaned_companies.sql
--
-- Before the delete flow was fixed, deleting a company banking account left
-- its fdx_companies row (and dependent exchange rows) behind. The listing
-- queries now hide those orphans, but the rows still sit in the database and
-- still hold their ticker in the uniqueness namespace. This migration
-- physically removes them.
--
-- An orphan is any fdx_companies row whose linked_bank_account no longer
-- resolves to a live banking account. Rows with a NULL linked_bank_account
-- (none exist today, but kept for safety) are left untouched.
--
-- Children are deleted before parents so the cleanup succeeds even if
-- foreign keys are enforced. Safe to run repeatedly — the deletes are no-ops
-- once nothing matches.

DELETE FROM fdx_trades
 WHERE company_id IN (
   SELECT id FROM fdx_companies
    WHERE linked_bank_account IS NOT NULL
      AND linked_bank_account NOT IN (SELECT key FROM banking_accounts)
 );

DELETE FROM fdx_orders
 WHERE company_id IN (
   SELECT id FROM fdx_companies
    WHERE linked_bank_account IS NOT NULL
      AND linked_bank_account NOT IN (SELECT key FROM banking_accounts)
 );

DELETE FROM fdx_portfolios
 WHERE company_id IN (
   SELECT id FROM fdx_companies
    WHERE linked_bank_account IS NOT NULL
      AND linked_bank_account NOT IN (SELECT key FROM banking_accounts)
 );

DELETE FROM fdx_candles
 WHERE company_id IN (
   SELECT id FROM fdx_companies
    WHERE linked_bank_account IS NOT NULL
      AND linked_bank_account NOT IN (SELECT key FROM banking_accounts)
 );

DELETE FROM fdx_dividends
 WHERE company_id IN (
   SELECT id FROM fdx_companies
    WHERE linked_bank_account IS NOT NULL
      AND linked_bank_account NOT IN (SELECT key FROM banking_accounts)
 );

DELETE FROM fdx_company_reports
 WHERE company_id IN (
   SELECT id FROM fdx_companies
    WHERE linked_bank_account IS NOT NULL
      AND linked_bank_account NOT IN (SELECT key FROM banking_accounts)
 );

DELETE FROM fdx_halt_log
 WHERE company_id IN (
   SELECT id FROM fdx_companies
    WHERE linked_bank_account IS NOT NULL
      AND linked_bank_account NOT IN (SELECT key FROM banking_accounts)
 );

DELETE FROM fdx_watchlist
 WHERE company_id IN (
   SELECT id FROM fdx_companies
    WHERE linked_bank_account IS NOT NULL
      AND linked_bank_account NOT IN (SELECT key FROM banking_accounts)
 );

DELETE FROM fdx_companies
 WHERE linked_bank_account IS NOT NULL
   AND linked_bank_account NOT IN (SELECT key FROM banking_accounts);
