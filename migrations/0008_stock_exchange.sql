-- ============================================================
-- Regnum Aeternum — Migration 0008: Fiducia Exchange (FDX)
-- Stock exchange with order book, market data, and banking integration.
-- Depends on: 0001_init.sql (users, sessions), 0006_banking.sql (accounts, transactions)
-- ============================================================

-- 1. fdx_companies — listed companies
CREATE TABLE fdx_companies (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker             TEXT NOT NULL UNIQUE,         -- e.g. "RNBK", "IRMN"
  name               TEXT NOT NULL,
  sector             TEXT NOT NULL,                -- BANKING | TRADE | MINING | AGRICULTURE | SERVICES | MILITARY
  description        TEXT,
  logo_emoji         TEXT DEFAULT '🏢',
  linked_bank_account TEXT,                        -- FK to banking_accounts.key (for fundamental pulling)
  total_shares       INTEGER NOT NULL DEFAULT 1000000,
  shares_in_float    INTEGER NOT NULL DEFAULT 750000,
  ipo_price          REAL NOT NULL,
  current_price      REAL NOT NULL,
  prev_close_price   REAL,
  day_high           REAL,
  day_low            REAL,
  day_volume         INTEGER DEFAULT 0,
  total_volume       INTEGER DEFAULT 0,
  market_cap         REAL,
  -- Fundamental inputs (admin-adjustable)
  fundamental_earnings   REAL DEFAULT 0,
  fundamental_assets     REAL DEFAULT 0,
  fundamental_liabilities REAL DEFAULT 0,
  fundamental_revenue    REAL DEFAULT 0,
  fundamental_growth_rate REAL DEFAULT 0.0,
  fundamental_beta       REAL DEFAULT 1.0,
  -- State
  status             TEXT DEFAULT 'active',        -- active | halted | ipo | delisted
  halt_reason        TEXT,
  listed_at          TEXT DEFAULT (datetime('now')),
  updated_at         TEXT DEFAULT (datetime('now'))
);

-- 2. fdx_orders — live order book
CREATE TABLE fdx_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES fdx_companies(id),
  account_id    TEXT NOT NULL,                     -- banking account key
  player_name   TEXT NOT NULL,
  side          TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  order_type    TEXT NOT NULL CHECK(order_type IN ('MARKET','LIMIT','STOP_LOSS','STOP_LIMIT')),
  quantity      INTEGER NOT NULL CHECK(quantity > 0),
  quantity_filled INTEGER DEFAULT 0,
  limit_price   REAL,
  stop_price    REAL,
  time_in_force TEXT DEFAULT 'GTC' CHECK(time_in_force IN ('GTC','DAY','IOC','FOK')),
  status        TEXT DEFAULT 'open' CHECK(status IN ('open','partial','filled','cancelled','expired','rejected','pending_ipo')),
  ip_hash       TEXT,
  flagged       INTEGER DEFAULT 0,
  flag_reason   TEXT,
  placed_at     TEXT DEFAULT (datetime('now')),
  expires_at    TEXT,
  filled_at     TEXT,
  cancelled_at  TEXT
);

CREATE INDEX idx_orders_company_side_status ON fdx_orders(company_id, side, status);
CREATE INDEX idx_orders_account ON fdx_orders(account_id, status);
CREATE INDEX idx_orders_placed_at ON fdx_orders(placed_at DESC);

-- 3. fdx_trades — immutable trade records
CREATE TABLE fdx_trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES fdx_companies(id),
  buy_order_id    INTEGER NOT NULL REFERENCES fdx_orders(id),
  sell_order_id   INTEGER NOT NULL REFERENCES fdx_orders(id),
  buyer_account   TEXT NOT NULL,
  seller_account  TEXT NOT NULL,
  quantity        INTEGER NOT NULL,
  price           REAL NOT NULL,
  total_value     REAL NOT NULL,
  exchange_fee    REAL NOT NULL,
  buyer_fee       REAL NOT NULL,
  seller_fee      REAL NOT NULL,
  flagged         INTEGER DEFAULT 0,
  flag_reason     TEXT,
  executed_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_trades_company ON fdx_trades(company_id, executed_at DESC);
CREATE INDEX idx_trades_buyer ON fdx_trades(buyer_account);
CREATE INDEX idx_trades_seller ON fdx_trades(seller_account);

-- 4. fdx_portfolios — per-account holdings
CREATE TABLE fdx_portfolios (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL,
  company_id    INTEGER NOT NULL REFERENCES fdx_companies(id),
  quantity      INTEGER NOT NULL DEFAULT 0,
  average_cost  REAL NOT NULL DEFAULT 0,
  total_invested REAL NOT NULL DEFAULT 0,
  realised_pnl  REAL DEFAULT 0,
  last_updated  TEXT DEFAULT (datetime('now')),
  UNIQUE(account_id, company_id)
);

CREATE INDEX idx_portfolios_account ON fdx_portfolios(account_id);
CREATE INDEX idx_portfolios_company ON fdx_portfolios(company_id);

-- 5. fdx_candles — OHLCV data
CREATE TABLE fdx_candles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES fdx_companies(id),
  interval    TEXT NOT NULL CHECK(interval IN ('5m','1h','1d')),
  open_time   TEXT NOT NULL,
  open        REAL NOT NULL,
  high        REAL NOT NULL,
  low         REAL NOT NULL,
  close       REAL NOT NULL,
  volume      INTEGER NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(company_id, interval, open_time)
);

CREATE INDEX idx_candles_lookup ON fdx_candles(company_id, interval, open_time DESC);

-- 6. fdx_dividends
CREATE TABLE fdx_dividends (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES fdx_companies(id),
  dividend_per_share REAL NOT NULL,
  record_date     TEXT NOT NULL,
  pay_date        TEXT NOT NULL,
  status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled')),
  total_paid      REAL,
  declared_by     TEXT NOT NULL,
  declared_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_dividends_company ON fdx_dividends(company_id);

-- 7. fdx_company_reports
CREATE TABLE fdx_company_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES fdx_companies(id),
  report_type   TEXT NOT NULL CHECK(report_type IN ('QUARTERLY','ANNUAL','SPECIAL')),
  period_label  TEXT NOT NULL,
  headline      TEXT NOT NULL,
  body          TEXT NOT NULL,
  earnings_change REAL,
  revenue_change  REAL,
  assets_change   REAL,
  filed_by      TEXT NOT NULL,
  filed_at      TEXT DEFAULT (datetime('now')),
  published     INTEGER DEFAULT 1
);

CREATE INDEX idx_reports_company ON fdx_company_reports(company_id, filed_at DESC);

-- 8. fdx_halt_log
CREATE TABLE fdx_halt_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER REFERENCES fdx_companies(id),
  halt_type     TEXT NOT NULL CHECK(halt_type IN (
    'CIRCUIT_BREAKER_UP','CIRCUIT_BREAKER_DOWN',
    'VOLATILITY_PAUSE','ADMIN_HALT',
    'PENDING_NEWS','REGULATORY','DELISTING_NOTICE'
  )),
  triggered_by  TEXT,
  reason        TEXT,
  halted_at     TEXT DEFAULT (datetime('now')),
  resumed_at    TEXT,
  duration_mins INTEGER
);

CREATE INDEX idx_halt_company ON fdx_halt_log(company_id, halted_at DESC);

-- 9. fdx_audit_log
CREATE TABLE fdx_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   INTEGER,
  details     TEXT,
  performed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_entity ON fdx_audit_log(entity_type, entity_id);

-- 10. fdx_watchlist
CREATE TABLE fdx_watchlist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  company_id  INTEGER NOT NULL REFERENCES fdx_companies(id),
  added_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(account_id, company_id)
);

CREATE INDEX idx_watchlist_account ON fdx_watchlist(account_id);

-- 11. fdx_index_snapshots
CREATE TABLE fdx_index_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  index_value   REAL NOT NULL,
  total_market_cap REAL NOT NULL,
  advancing     INTEGER DEFAULT 0,
  declining     INTEGER DEFAULT 0,
  unchanged     INTEGER DEFAULT 0,
  snapped_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_snapshots_time ON fdx_index_snapshots(snapped_at DESC);

-- 12. fdx_settings — key-value store for market parameters
CREATE TABLE fdx_settings (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO fdx_settings (key, value, updated_by) VALUES
  ('exchange_fee_rate',        '0.005',  'system'),
  ('market_open_utc',          '08:00',  'system'),
  ('market_close_utc',         '20:00',  'system'),
  ('circuit_breaker_l1_pct',   '10',     'system'),
  ('circuit_breaker_l2_pct',   '20',     'system'),
  ('circuit_breaker_l3_pct',   '35',     'system'),
  ('circuit_breaker_l1_mins',  '15',     'system'),
  ('circuit_breaker_l2_mins',  '60',     'system'),
  ('volatility_pause_pct',     '5',      'system'),
  ('volatility_pause_mins',    '2',      'system'),
  ('max_position_pct',         '15',     'system'),
  ('max_order_pct',            '5',      'system'),
  ('market_maker_spread_pct',  '3',      'system'),
  ('market_maker_qty',         '50',     'system'),
  ('sector_pe_BANKING',        '12',     'system'),
  ('sector_pe_TRADE',          '18',     'system'),
  ('sector_pe_MINING',         '10',     'system'),
  ('sector_pe_AGRICULTURE',    '9',      'system'),
  ('sector_pe_SERVICES',       '20',     'system'),
  ('sector_pe_MILITARY',       '14',     'system'),
  ('base_volatility',          '0.005',  'system'),
  ('ipo_allocation_method',    'FCFS',   'system'),
  ('spoof_score_threshold',    '3',      'system'),
  ('base_discount_rate',       '0.08',   'system');
