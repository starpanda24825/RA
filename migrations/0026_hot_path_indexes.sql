-- 0026_hot_path_indexes.sql
-- Indexes for queries that run on a timer, and therefore have to stay cheap
-- however large their tables grow.
--
-- 1. banking_value_history(company_key, recorded_at).
--    0006 gave this table two single-column indexes, (company_key) and
--    (recorded_at). The write path queries on BOTH at once:
--
--      DELETE FROM banking_value_history WHERE company_key = ? AND recorded_at < ?
--
--    so neither single-column index can serve the whole predicate. SQLite picks
--    one and then filters on the other, which means the prune re-reads a
--    company's entire retained history just to find the few rows that have
--    actually expired. The composite index turns that into a range scan over
--    only the expired rows — and the leaderboard's "value as of 24h ago" lookup
--    (company_key = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1)
--    into a single backward seek rather than a full per-company read.
--
-- 2. fdx_companies(status).
--    The market engine reads "the active companies" several times per 5-minute
--    tick (drift, matching, stop orders, circuit breakers, market maker, index).
--    Without an index on status each of those is a full table scan.
--
-- Apply with:
--   npx wrangler d1 migrations apply regnum-aeternum-db --remote

CREATE INDEX IF NOT EXISTS idx_bk_val_company_at ON banking_value_history(company_key, recorded_at);
CREATE INDEX IF NOT EXISTS idx_fdx_companies_status ON fdx_companies(status);
