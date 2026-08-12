/* ============================================================
   Regnum Aeternum — Worker
   Fiducia Exchange: Market Engine
   Core simulation — order matching, price drift, fair value,
   candle management, and index computation.
   ============================================================ */

// ---------- constants ----------

const SECTOR_PE_RATIOS = {
  BANKING:     12,
  TRADE:       18,
  MINING:      10,
  AGRICULTURE:  9,
  SERVICES:    20,
  MILITARY:    14,
};

const SECTOR_REVENUE_MULTIPLES = {
  BANKING:     2.0,
  TRADE:       1.5,
  MINING:      1.0,
  AGRICULTURE: 0.8,
  SERVICES:    3.0,
  MILITARY:    2.5,
};

const BASE_VOLATILITY = 0.005; // 0.5% per tick
const FUNDAMENTAL_PULL = 0.02; // 2% reversion toward fair value per tick
const MOMENTUM_FACTOR = 0.3;   // 30% continuation
const VOLUME_PRESSURE_FACTOR = 0.003; // max ±0.3% per tick

function nowIso() { return new Date().toISOString(); }

// ---------- helpers ----------

function gaussianRandom() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

async function getSetting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM fdx_settings WHERE key = ?').bind(key).first();
  return row ? row.value : String(fallback);
}

async function getSettingNum(db, key, fallback) {
  const v = await getSetting(db, key, fallback);
  return Number(v);
}

// ---------- fair value ----------

export function calculateFairValue(company, sectorOverrides = {}) {
  const {
    fundamental_earnings, fundamental_assets,
    fundamental_liabilities, fundamental_revenue,
    fundamental_growth_rate, total_shares, sector,
  } = company;

  if (!total_shares || total_shares <= 0) return 0.01;

  const netAssets = fundamental_assets - fundamental_liabilities;
  const bookValuePerShare = netAssets / total_shares;
  const eps = fundamental_earnings / total_shares;

  const sectorPE = sectorOverrides[sector] || SECTOR_PE_RATIOS[sector] || 15;
  const peValue = eps * sectorPE;

  const discountRate = 0.08;
  const growth = Math.min(Math.max(fundamental_growth_rate, 0), 0.25);
  let dcfValue;
  if (growth >= discountRate) {
    dcfValue = (eps * (1 + growth)) / 0.01; // cap when growth >= discount rate
  } else {
    dcfValue = eps / (discountRate - growth);
  }

  const revenuePerShare = fundamental_revenue / total_shares;
  const sectorRevMultiple = SECTOR_REVENUE_MULTIPLES[sector] || 1.5;
  const revValue = revenuePerShare * sectorRevMultiple;

  const fair = (
    bookValuePerShare * 0.25 +
    peValue            * 0.35 +
    dcfValue           * 0.25 +
    revValue           * 0.15
  );

  return Math.max(fair, 0.01);
}

// ---------- price drift simulation ----------

export async function runPriceDrift(db, company) {
  const lastPrice = company.current_price || company.ipo_price;
  if (!lastPrice || lastPrice <= 0) return lastPrice;

  const sectorPEOverrides = {};
  const sectors = Object.keys(SECTOR_PE_RATIOS);
  for (const s of sectors) {
    const pe = await getSettingNum(db, 'sector_pe_' + s, SECTOR_PE_RATIOS[s]);
    sectorPEOverrides[s] = pe;
  }

  // 1. Fundamental pull
  const fairValue = calculateFairValue(company, sectorPEOverrides);
  const fundamentalPull = (fairValue - lastPrice) * FUNDAMENTAL_PULL;

  // 2. Sentiment noise
  const beta = company.fundamental_beta || 1.0;
  const baseVol = await getSettingNum(db, 'base_volatility', BASE_VOLATILITY);
  const sigma = beta * baseVol;
  const epsilon = gaussianRandom();
  const sentimentNoise = lastPrice * sigma * epsilon;

  // 3. Momentum
  const candles = await db.prepare(
    "SELECT close FROM fdx_candles WHERE company_id = ? AND interval = '5m' ORDER BY open_time DESC LIMIT 3"
  ).bind(company.id).all();
  let momentum = 0;
  if (candles.results && candles.results.length >= 3) {
    const closes = candles.results.map(c => c.close);
    let sumReturns = 0;
    for (let i = 0; i < closes.length - 1; i++) {
      if (closes[i + 1] > 0) sumReturns += (closes[i] - closes[i + 1]) / closes[i + 1];
    }
    momentum = (sumReturns / (closes.length - 1)) * MOMENTUM_FACTOR;
  }
  const momentumComponent = lastPrice * momentum;

  // 4. Volume pressure
  const buyVol = await db.prepare(
    "SELECT COALESCE(SUM(quantity - quantity_filled), 0) AS total FROM fdx_orders WHERE company_id = ? AND side = 'BUY' AND status IN ('open','partial')"
  ).bind(company.id).first();
  const sellVol = await db.prepare(
    "SELECT COALESCE(SUM(quantity - quantity_filled), 0) AS total FROM fdx_orders WHERE company_id = ? AND side = 'SELL' AND status IN ('open','partial')"
  ).bind(company.id).first();

  const buyTotal = (buyVol && buyVol.total) || 0;
  const sellTotal = (sellVol && sellVol.total) || 0;
  const imbalance = (buyTotal - sellTotal) / (buyTotal + sellTotal + 1);
  const volumePressure = lastPrice * imbalance * VOLUME_PRESSURE_FACTOR;

  let newPrice = lastPrice + fundamentalPull + sentimentNoise + momentumComponent + volumePressure;
  newPrice = Math.round(newPrice * 100) / 100;
  newPrice = Math.max(newPrice, 0.01);

  return newPrice;
}

// ---------- market tick ----------

export async function runMarketTick(db) {
  const now = new Date();
  const marketOpen = isMarketOpen(now);
  const afterHours = isAfterHours(now);
  const preMarket = isPreMarket(now);

  // Get all active companies
  const { results: companies } = await db.prepare(
    "SELECT * FROM fdx_companies WHERE status = 'active'"
  ).all();

  for (const company of companies) {
    // Only run price drift during market hours
    let newPrice = company.current_price || company.ipo_price;
    if (marketOpen) {
      newPrice = await runPriceDrift(db, company);
    }

    // Update company price and high/low during market hours
    if (marketOpen) {
      const dayHigh = company.day_high ? Math.max(company.day_high, newPrice) : newPrice;
      const dayLow  = company.day_low   ? Math.min(company.day_low, newPrice)   : newPrice;
      const marketCap = Math.round(newPrice * company.total_shares * 100) / 100;

      await db.prepare(
        `UPDATE fdx_companies SET
           current_price = ?, day_high = ?, day_low = ?, market_cap = ?, updated_at = ?
         WHERE id = ?`
      ).bind(newPrice, dayHigh, dayLow, marketCap, nowIso(), company.id).run();
    }

    // Always update candles regardless of session (preserves full day's data)
    if (marketOpen || afterHours || preMarket) {
      await updateCandle(db, company.id, '5m', newPrice, 0, 0);
      await updateCandle(db, company.id, '1h', newPrice, 0, 0);
      await updateCandle(db, company.id, '1d', newPrice, 0, 0);
    }
  }

  if (marketOpen) {
    // Activate any stop orders whose prices have been crossed
    await activateStopOrders(db);

    // Run matching engine on newly activated orders
    await runMatchingEngine(db);

    // Check circuit breakers
    await checkCircuitBreakers(db);

    // DAY order expiry is handled by the EOD cron trigger (0 20 * * *),
    // not per-tick, since market hours end at 20:00 UTC
  }

  // Auto-resume companies whose halt duration has elapsed
  await autoResumeHaltedCompanies(db, now);

  // Inject market maker orders during all active sessions
  if (marketOpen || afterHours || preMarket) {
    await injectMarketMakerOrders(db);
  }

  // Compute index during market hours only
  if (marketOpen) {
    await computeAndSnapshotIndex(db);
  }
}

// ---------- candle management ----------

async function updateCandle(db, companyId, interval, price, volume, tradeCount) {
  const now = new Date();
  const openTime = getCandleOpenTime(now, interval);

  const existing = await db.prepare(
    'SELECT * FROM fdx_candles WHERE company_id = ? AND interval = ? AND open_time = ?'
  ).bind(companyId, interval, openTime).first();

  if (existing) {
    await db.prepare(
      `UPDATE fdx_candles SET
         close = ?, high = MAX(high, ?), low = MIN(low, ?),
         volume = volume + ?, trade_count = trade_count + ?
       WHERE id = ?`
    ).bind(price, price, price, volume, tradeCount, existing.id).run();
  } else {
    await db.prepare(
      `INSERT INTO fdx_candles (company_id, interval, open_time, open, high, low, close, volume, trade_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(companyId, interval, openTime, price, price, price, price, volume, tradeCount).run();
  }
}

function getCandleOpenTime(date, interval) {
  const d = new Date(date);
  if (interval === '5m') {
    d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
    return d.toISOString();
  }
  if (interval === '1h') {
    d.setMinutes(0, 0, 0);
    return d.toISOString();
  }
  if (interval === '1d') {
    d.setUTCHours(8, 0, 0, 0); // market open 08:00 UTC
    if (date < d) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString();
  }
  return date.toISOString();
}

// ---------- market session ----------

function isMarketOpen(now) {
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const time = hour * 60 + minute;
  // Open: 08:00–20:00 UTC (full trading)
  return time >= 8 * 60 && time < 20 * 60;
}

function isPreMarket(now) {
  const time = now.getUTCHours() * 60 + now.getUTCMinutes();
  // Pre-market: 06:00–08:00 UTC
  return time >= 6 * 60 && time < 8 * 60;
}

function isAfterHours(now) {
  const time = now.getUTCHours() * 60 + now.getUTCMinutes();
  // After-hours: 20:00–22:00 UTC
  return time >= 20 * 60 && time < 22 * 60;
}

// ---------- order matching engine ----------

export async function runMatchingEngine(db) {
  const { results: companies } = await db.prepare(
    "SELECT * FROM fdx_companies WHERE status = 'active'"
  ).all();

  for (const company of companies) {
    // Skip market maker self-matching by cancelling old MM orders first
    await db.prepare(
      `UPDATE fdx_orders SET status = 'cancelled', cancelled_at = ?
       WHERE company_id = ? AND account_id = '__exchange_treasury__' AND status IN ('open','partial')`
    ).bind(nowIso(), company.id).run();
    await matchCompanyOrders(db, company);
  }
}

async function matchCompanyOrders(db, company) {
  const feeRate = await getSettingNum(db, 'exchange_fee_rate', 0.005);

  // Get open buy orders sorted by price DESC, time ASC
  const { results: buyOrders } = await db.prepare(
    `SELECT * FROM fdx_orders
     WHERE company_id = ? AND side = 'BUY'
       AND status IN ('open','partial')
     ORDER BY COALESCE(limit_price, 99999999) DESC, placed_at ASC`
  ).bind(company.id).all();

  if (!buyOrders || buyOrders.length === 0) return;

  for (const buy of buyOrders) {
    const buyRemaining = buy.quantity - buy.quantity_filled;
    if (buyRemaining <= 0) continue;

    // Get open sell orders sorted by price ASC, time ASC
    const { results: sellOrders } = await db.prepare(
      `SELECT * FROM fdx_orders
       WHERE company_id = ? AND side = 'SELL'
         AND status IN ('open','partial')
       ORDER BY COALESCE(limit_price, -1) ASC, placed_at ASC`
    ).bind(company.id).all();

    if (!sellOrders || sellOrders.length === 0) break;

    let buyFilled = buy.quantity_filled || 0;

    for (const sell of sellOrders) {
      const sellRemaining = sell.quantity - (sell.quantity_filled || 0);
      if (sellRemaining <= 0) continue;

      // Check if prices cross
      const buyPrice = buy.limit_price ?? Infinity;
      const sellPrice = sell.limit_price ?? -Infinity;
      const buyIsMarket = buy.order_type === 'MARKET' || (buy.order_type === 'STOP_LOSS' && buy.status === 'open');
      const sellIsMarket = sell.order_type === 'MARKET';

      if (!buyIsMarket && !sellIsMarket && buyPrice < sellPrice) continue;

      // Execution price = sell's limit price (price improvement for buyer)
      let executionPrice;
      if (buyIsMarket && sellIsMarket) {
        executionPrice = company.current_price || company.ipo_price;
      } else if (buyIsMarket) {
        executionPrice = sellPrice > 0 ? sellPrice : (company.current_price || company.ipo_price);
      } else if (sellIsMarket) {
        executionPrice = buyPrice;
      } else {
        executionPrice = sellPrice; // price improvement: buyer's limit was higher
      }
      executionPrice = Math.round(executionPrice * 100) / 100;
      if (executionPrice <= 0) executionPrice = 0.01;

      const matchQty = Math.min(buyRemaining - (buyFilled - buy.quantity_filled), sellRemaining);
      if (matchQty <= 0) break;

      const totalValue = Math.round(matchQty * executionPrice * 100) / 100;
      const exchangeFee = Math.round(totalValue * feeRate * 100) / 100;
      const halfFee = Math.round(exchangeFee / 2 * 100) / 100;

      // Attempt bank transfers
      try {
        // Debit buyer
        const buyerTotal = Math.round((totalValue + halfFee) * 100) / 100;
        await debitBankAccount(db, buy.account_id, buyerTotal, 'EXCHANGE_BUY', `Buy ${matchQty} ${company.ticker} @ ${executionPrice}`);

        // Credit seller (less fee)
        const sellerCredit = Math.round((totalValue - halfFee) * 100) / 100;
        await creditBankAccount(db, sell.account_id, sellerCredit, 'EXCHANGE_SELL', `Sell ${matchQty} ${company.ticker} @ ${executionPrice}`);

        // Credit exchange treasury fees
        await creditBankAccount(db, '__exchange_treasury__', exchangeFee, 'EXCHANGE_FEE', `Exchange fee: ${company.ticker}`);

        // Record trade
        const tradeResult = await db.prepare(
          `INSERT INTO fdx_trades
             (company_id, buy_order_id, sell_order_id, buyer_account, seller_account,
              quantity, price, total_value, exchange_fee, buyer_fee, seller_fee)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(company.id, buy.id, sell.id, buy.account_id, sell.account_id,
               matchQty, executionPrice, totalValue, exchangeFee, halfFee, halfFee).run();

        // Update portfolios
        await updatePortfolio(db, buy.account_id, company.id, matchQty, executionPrice);
        await updatePortfolio(db, sell.account_id, company.id, -matchQty, executionPrice);

        // Update order fill quantities
        const buyNewFilled = (buy.quantity_filled || 0) + matchQty;
        const sellNewFilled = (sell.quantity_filled || 0) + matchQty;
        const buyRemainingAfter = buy.quantity - buyNewFilled;
        const sellRemainingAfter = sell.quantity - sellNewFilled;

        const buyStatus = buyRemainingAfter <= 0 ? 'filled' : 'partial';
        const sellStatus = sellRemainingAfter <= 0 ? 'filled' : 'partial';
        const now = nowIso();

        await db.prepare(
          `UPDATE fdx_orders SET quantity_filled = ?, status = ?, filled_at = ?
           WHERE id = ?`
        ).bind(buyNewFilled, buyStatus, buyStatus === 'filled' ? now : null, buy.id).run();

        await db.prepare(
          `UPDATE fdx_orders SET quantity_filled = ?, status = ?, filled_at = ?
           WHERE id = ?`
        ).bind(sellNewFilled, sellStatus, sellStatus === 'filled' ? now : null, sell.id).run();

        // Update company day stats
        const dayHigh = company.day_high ? Math.max(company.day_high, executionPrice) : executionPrice;
        const dayLow  = company.day_low   ? Math.min(company.day_low, executionPrice)   : executionPrice;
        const dayVol  = (company.day_volume || 0) + matchQty;
        const totalVol = (company.total_volume || 0) + matchQty;
        const marketCap = Math.round(executionPrice * company.total_shares * 100) / 100;

        await db.prepare(
          `UPDATE fdx_companies SET
             current_price = ?, day_high = ?, day_low = ?, day_volume = ?,
             total_volume = ?, market_cap = ?, updated_at = ?
           WHERE id = ?`
        ).bind(executionPrice, dayHigh, dayLow, dayVol, totalVol, marketCap, nowIso(), company.id).run();

        // Update candle
        await updateCandle(db, company.id, '5m', executionPrice, matchQty, 1);
        await updateCandle(db, company.id, '1h', executionPrice, matchQty, 1);
        await updateCandle(db, company.id, '1d', executionPrice, matchQty, 1);

        buyFilled = buyNewFilled;
        if (buyRemainingAfter <= 0) break; // Buy order fully filled

      } catch (err) {
        // If banking fails, mark the matching attempt as failed but continue
        console.error('Trade execution banking error:', err.message);
        // Don't stop matching — just skip this seller and try next
        continue;
      }
    }
  }
}

// ---------- stop order activation ----------

async function activateStopOrders(db) {
  const { results: companies } = await db.prepare(
    "SELECT * FROM fdx_companies WHERE status = 'active'"
  ).all();

  for (const company of companies) {
    const price = company.current_price || company.ipo_price;

    // SELL STOP_LOSS: activates when price DROPS to or below stop_price
    // SELL STOP_LIMIT: activates when price DROPS to or below stop_price
    const { results: sellStopOrders } = await db.prepare(
      `SELECT * FROM fdx_orders
       WHERE company_id = ? AND side = 'SELL'
         AND order_type IN ('STOP_LOSS','STOP_LIMIT')
         AND status = 'open' AND stop_price >= ?`
    ).bind(company.id, price).all();

    for (const order of (sellStopOrders || [])) {
      const newType = order.order_type === 'STOP_LOSS' ? 'MARKET' : 'LIMIT';
      await db.prepare(
        `UPDATE fdx_orders SET order_type = ?, status = 'open' WHERE id = ?`
      ).bind(newType, order.id).run();
    }

    // BUY STOP_LOSS: activates when price RISES to or above stop_price
    // BUY STOP_LIMIT: activates when price RISES to or above stop_price
    const { results: buyStopOrders } = await db.prepare(
      `SELECT * FROM fdx_orders
       WHERE company_id = ? AND side = 'BUY'
         AND order_type IN ('STOP_LOSS','STOP_LIMIT')
         AND status = 'open' AND stop_price <= ?`
    ).bind(company.id, price).all();

    for (const order of (buyStopOrders || [])) {
      const newType = order.order_type === 'STOP_LOSS' ? 'MARKET' : 'LIMIT';
      await db.prepare(
        `UPDATE fdx_orders SET order_type = ?, status = 'open' WHERE id = ?`
      ).bind(newType, order.id).run();
    }
  }
}

// ---------- order expiry ----------

// expireDayOrders: no longer used in runMarketTick (handled by EOD cron).
// The function remains for external use by the EOD cron handler. Kept as a
// simple status update only — no fund release needed because reservations
// are virtual (getAvailableBalance subtracts open order costs, no actual debit).
// When an order expires, the virtual reservation disappears automatically.
async function expireDayOrders(db, now) {
  await db.prepare(
    `UPDATE fdx_orders SET status = 'expired', cancelled_at = ?
     WHERE time_in_force = 'DAY' AND status IN ('open','partial')`
  ).bind(nowIso()).run();
}

// ---------- circuit breakers ----------

async function checkCircuitBreakers(db) {
  const l3Pct = await getSettingNum(db, 'circuit_breaker_l3_pct', 35);    const l2Pct = await getSettingNum(db, 'circuit_breaker_l2_pct', 20);
    const l1Pct = await getSettingNum(db, 'circuit_breaker_l1_pct', 10);
    const volPct = await getSettingNum(db, 'volatility_pause_pct', 5);
    const volMins = await getSettingNum(db, 'volatility_pause_mins', 2);

  const { results: companies } = await db.prepare(
    "SELECT * FROM fdx_companies WHERE status = 'active'"
  ).all();

  for (const company of companies) {
    const price = company.current_price || company.ipo_price;
    const prevClose = company.prev_close_price;
    if (!prevClose || prevClose <= 0) continue;

    const changePct = Math.abs((price - prevClose) / prevClose) * 100;

    // Level 3 (35%+ day): halt for rest of day
    if (changePct >= l3Pct) {
      await haltCompany(db, company.id, 'CIRCUIT_BREAKER_' + (price > prevClose ? 'UP' : 'DOWN'),
        `Price moved ${changePct.toFixed(1)}% today. Trading halted for rest of day.`, 'system');
      continue;
    }

    // Level 2 (20%+ day): 60-min halt
    if (changePct >= l2Pct) {
      await haltCompany(db, company.id, 'CIRCUIT_BREAKER_' + (price > prevClose ? 'UP' : 'DOWN'),
        `Price moved ${changePct.toFixed(1)}% today. 60-min halt.`, 'system');
      continue;
    }

    // Level 1 (10%+ day): 15-min halt (deduplicate within 30 min)
    if (changePct >= l1Pct) {
      const recentHalt = await db.prepare(
        `SELECT id FROM fdx_halt_log WHERE company_id = ? AND halted_at > datetime('now', '-30 minutes') AND resumed_at IS NULL`
      ).bind(company.id).first();
      if (!recentHalt) {
        await haltCompany(db, company.id, 'CIRCUIT_BREAKER_' + (price > prevClose ? 'UP' : 'DOWN'),
          `Price moved ${changePct.toFixed(1)}% today. 15-min halt.`, 'system');
      }
      continue;
    }

    // Volatility pause (5% in 5 minutes): check against previous 5m candle
    const prevCandle = await db.prepare(
      `SELECT close, open_time FROM fdx_candles
       WHERE company_id = ? AND interval = '5m'
       ORDER BY open_time DESC LIMIT 1 OFFSET 1`
    ).bind(company.id).first();

    if (prevCandle && prevCandle.close > 0 && prevCandle.open_time) {
      const fiveMinChange = Math.abs((price - prevCandle.close) / prevCandle.close) * 100;
      if (fiveMinChange >= volPct) {
        const recentVolPause = await db.prepare(
          `SELECT id FROM fdx_halt_log WHERE company_id = ? AND halt_type = 'VOLATILITY_PAUSE'
           AND halted_at > datetime('now', '-5 minutes') AND resumed_at IS NULL`
        ).bind(company.id).first();
        if (!recentVolPause) {
          await haltCompany(db, company.id, 'VOLATILITY_PAUSE',
            `Price moved ${fiveMinChange.toFixed(1)}% in 5 minutes. ${volMins}-min pause.`, 'system');
        }
      }
    }
  }
}

async function autoResumeHaltedCompanies(db, now) {
  // Resume companies halted by circuit breakers or volatility pauses
  // after their duration has passed (based on halt type and settings)
  const volMins = await getSettingNum(db, 'volatility_pause_mins', 2);
  const l1Mins = await getSettingNum(db, 'circuit_breaker_l1_mins', 15);
  const l2Mins = await getSettingNum(db, 'circuit_breaker_l2_mins', 60);

  const { results: halted } = await db.prepare(
    `SELECT h.*, c.ticker FROM fdx_halt_log h
     JOIN fdx_companies c ON c.id = h.company_id AND c.status = 'halted'
     WHERE h.resumed_at IS NULL AND h.company_id IS NOT NULL
     ORDER BY h.halted_at ASC`
  ).all();

  for (const halt of (halted || [])) {
    let durationMins = null;

    if (halt.halt_type === 'VOLATILITY_PAUSE') durationMins = volMins;
    else if (halt.halt_type === 'CIRCUIT_BREAKER_UP' || halt.halt_type === 'CIRCUIT_BREAKER_DOWN') {
      // Determine level: check the company's prev_close vs current price
      const company = await db.prepare(
        'SELECT current_price, prev_close_price FROM fdx_companies WHERE id = ?'
      ).bind(halt.company_id).first();
      if (company && company.prev_close_price) {
        const changePct = Math.abs((company.current_price - company.prev_close_price) / company.prev_close_price) * 100;
        const l3Pct = await getSettingNum(db, 'circuit_breaker_l3_pct', 35);
        const l2Pct = await getSettingNum(db, 'circuit_breaker_l2_pct', 20);
        const l1Pct = await getSettingNum(db, 'circuit_breaker_l1_pct', 10);
        if (changePct >= l3Pct) durationMins = null; // L3: rest of day, no auto-resume
        else if (changePct >= l2Pct) durationMins = l2Mins;
        else if (changePct >= l1Pct) durationMins = l1Mins;
        else durationMins = volMins; // below L1 = volatility pause
      }
    }
    // ADMIN_HALT, PENDING_NEWS, REGULATORY, DELISTING_NOTICE — manual resume only (durationMins stays null)

    if (durationMins !== null) {
      const haltedAt = new Date(halt.halted_at);
      const resumeAt = new Date(haltedAt.getTime() + durationMins * 60000);

      if (now >= resumeAt) {
        // Resume the company
        await db.prepare(
          `UPDATE fdx_companies SET status = 'active', halt_reason = NULL, updated_at = ? WHERE id = ?`
        ).bind(nowIso(), halt.company_id).run();

        await db.prepare(
          `UPDATE fdx_halt_log SET resumed_at = ?, duration_mins = ?
           WHERE id = ?`
        ).bind(nowIso(), durationMins, halt.id).run();

        // Market maker will inject fresh orders on the next tick for the resumed company
      }
    }
  }
}

async function haltCompany(db, companyId, haltType, reason, triggeredBy) {
  // Already halted?
  const company = await db.prepare('SELECT status FROM fdx_companies WHERE id = ?').bind(companyId).first();
  if (company && company.status !== 'active') return;

  await db.prepare(
    `UPDATE fdx_companies SET status = 'halted', halt_reason = ?, updated_at = ? WHERE id = ?`
  ).bind(reason, nowIso(), companyId).run();

  await db.prepare(
    `INSERT INTO fdx_halt_log (company_id, halt_type, triggered_by, reason)
     VALUES (?, ?, ?, ?)`
  ).bind(companyId, haltType, triggeredBy, reason).run();
}

// ---------- market maker orders ----------

async function injectMarketMakerOrders(db) {
  const feeRate = await getSettingNum(db, 'exchange_fee_rate', 0.005);
  const spreadPct = await getSettingNum(db, 'market_maker_spread_pct', 3) / 100;
  const mmQty = await getSettingNum(db, 'market_maker_qty', 50);
  const treasuryKey = '__exchange_treasury__';

  const { results: companies } = await db.prepare(
    "SELECT * FROM fdx_companies WHERE status = 'active'"
  ).all();

  for (const company of companies) {
    const price = company.current_price || company.ipo_price;
    if (price <= 0) continue;

    // Check if we need market maker support
    const bestBid = await db.prepare(
      `SELECT COALESCE(MAX(limit_price), 0) AS price FROM fdx_orders
       WHERE company_id = ? AND side = 'BUY' AND status IN ('open','partial') AND limit_price IS NOT NULL`
    ).bind(company.id).first();

    const bestAsk = await db.prepare(
      `SELECT COALESCE(MIN(limit_price), 0) AS price FROM fdx_orders
       WHERE company_id = ? AND side = 'SELL' AND status IN ('open','partial') AND limit_price IS NOT NULL`
    ).bind(company.id).first();

    const bidPrice = (bestBid && bestBid.price) || 0;
    const askPrice = (bestAsk && bestAsk.price) || 0;

    const bidExists = bidPrice > 0;
    const askExists = askPrice > 0;
    const spread = bidExists && askExists ? (askPrice - bidPrice) / ((bidPrice + askPrice) / 2) : 1;

    // Remove old market maker orders for this company
    await db.prepare(
      `UPDATE fdx_orders SET status = 'cancelled', cancelled_at = ?
       WHERE company_id = ? AND account_id = ? AND status IN ('open','partial')`
    ).bind(nowIso(), company.id, treasuryKey).run();

    // Inject new ones if spread is too wide or one side is missing
    if (!bidExists || !askExists || spread > 0.05) {
      const fairValue = calculateFairValue(company);
      const synthBid = Math.round(fairValue * (1 - spreadPct) * 100) / 100;
      const synthAsk = Math.round(fairValue * (1 + spreadPct) * 100) / 100;

      if (synthBid > 0) {
        await db.prepare(
          `INSERT INTO fdx_orders
             (company_id, account_id, player_name, side, order_type, quantity, limit_price, time_in_force, status)
           VALUES (?, ?, ?, 'BUY', 'LIMIT', ?, ?, 'GTC', 'open')`
        ).bind(company.id, treasuryKey, 'Market Maker', mmQty, synthBid).run();
      }

      if (synthAsk > 0) {
        await db.prepare(
          `INSERT INTO fdx_orders
             (company_id, account_id, player_name, side, order_type, quantity, limit_price, time_in_force, status)
           VALUES (?, ?, ?, 'SELL', 'LIMIT', ?, ?, 'GTC', 'open')`
        ).bind(company.id, treasuryKey, 'Market Maker', mmQty, synthAsk).run();
      }
    }
  }
}

// ---------- portfolio management ----------

async function updatePortfolio(db, accountId, companyId, deltaQty, price) {
  const existing = await db.prepare(
    'SELECT * FROM fdx_portfolios WHERE account_id = ? AND company_id = ?'
  ).bind(accountId, companyId).first();

  if (existing) {
    const newQty = existing.quantity + deltaQty;
    let newAvgCost = existing.average_cost;
    let newInvested = existing.total_invested;

    if (deltaQty > 0) {
      // Buying: update average cost
      newInvested = Math.round((existing.total_invested + deltaQty * price) * 100) / 100;
      newAvgCost = newQty > 0 ? Math.round((newInvested / newQty) * 100) / 100 : 0;
    } else if (deltaQty < 0) {
      // Selling: reduce invested proportionally
      const soldQty = Math.abs(deltaQty);
      const costBasis = existing.average_cost * soldQty;
      const proceeds = price * soldQty;
      const pnl = Math.round((proceeds - costBasis) * 100) / 100;
      newInvested = Math.round((existing.total_invested - costBasis) * 100) / 100;
      if (newInvested < 0) newInvested = 0;
      newAvgCost = newQty > 0 ? Math.round((newInvested / newQty) * 100) / 100 : 0;

      await db.prepare(
        `UPDATE fdx_portfolios SET quantity = ?, average_cost = ?, total_invested = ?,
           realised_pnl = realised_pnl + ?, last_updated = ?
         WHERE id = ?`
      ).bind(newQty, newAvgCost, newInvested, pnl, nowIso(), existing.id).run();
      return;
    }

    await db.prepare(
      `UPDATE fdx_portfolios SET quantity = ?, average_cost = ?, total_invested = ?,
         last_updated = ?
       WHERE id = ?`
    ).bind(newQty, newAvgCost, newInvested, nowIso(), existing.id).run();
  } else if (deltaQty > 0) {
    await db.prepare(
      `INSERT INTO fdx_portfolios (account_id, company_id, quantity, average_cost, total_invested)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(accountId, companyId, deltaQty, price, Math.round(deltaQty * price * 100) / 100).run();
  }
  // If deltaQty < 0 and no existing entry, something is wrong — ignore
}

// ---------- banking integration ----------

async function debitBankAccount(db, accountKey, amount, type, description) {
  if (accountKey === '__exchange_treasury__') return; // Treasury can't be debited by trades

  const account = await db.prepare(
    'SELECT balance, frozen FROM banking_accounts WHERE key = ?'
  ).bind(accountKey).first();

  if (!account) throw new Error('Account not found: ' + accountKey);
  if (account.frozen) throw new Error('Account is frozen: ' + accountKey);
  if (account.balance < amount) throw new Error('Insufficient balance: ' + accountKey);

  const newBalance = Math.round((account.balance - amount) * 100) / 100;
  const now = nowIso();

  await db.batch([
    db.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?')
      .bind(newBalance, now, accountKey),
    db.prepare(
      `INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(accountKey, '__exchange__', amount, newBalance, 0, description, 'exchange:' + type, now),
  ]);
}

async function creditBankAccount(db, accountKey, amount, type, description) {
  const account = await db.prepare(
    'SELECT balance, frozen FROM banking_accounts WHERE key = ?'
  ).bind(accountKey).first();

  if (!account) {
    // Create a treasury account for exchange fees if it doesn't exist
    if (accountKey === '__exchange_treasury__') {
      await db.prepare(
        'INSERT OR IGNORE INTO banking_accounts (key, name, balance, color, type, owner_key, treasury_key, password_hash, shares, tag, frozen, cumulative, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)'
      ).bind('__exchange_treasury__', 'Fiducia Exchange Treasury', amount, 16766720, 'treasury', '', '', '', 0, 'FDX', nowIso(), nowIso()).run();
      // If it already existed, credit normally
      const existing = await db.prepare('SELECT balance FROM banking_accounts WHERE key = ?').bind(accountKey).first();
      if (existing) {
        const newBalance = Math.round((existing.balance + amount) * 100) / 100;
        const now = nowIso();
        await db.batch([
          db.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?').bind(newBalance, now, accountKey),
          db.prepare('INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind('__exchange__', accountKey, amount, 0, newBalance, description, 'exchange:' + type, now),
        ]);
      }
    } else {
      throw new Error('Account not found: ' + accountKey);
    }
    return;
  }
  if (account.frozen) throw new Error('Account is frozen: ' + accountKey);

  const newBalance = Math.round((account.balance + amount) * 100) / 100;
  const now = nowIso();

  await db.batch([
    db.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?')
      .bind(newBalance, now, accountKey),
    db.prepare(
      `INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind('__exchange__', accountKey, amount, 0, newBalance, description, 'exchange:' + type, now),
  ]);
}

export async function getAvailableBalance(db, accountKey) {
  const account = await db.prepare(
    'SELECT balance FROM banking_accounts WHERE key = ?'
  ).bind(accountKey).first();
  if (!account) return 0;

  // Subtract reserved funds for open buy orders, using each company's current price
  const { results: reserves } = await db.prepare(
    `SELECT COALESCE(SUM(
       CASE WHEN o.order_type = 'MARKET'
         THEN o.quantity * COALESCE(c.current_price, c.ipo_price)
         ELSE o.quantity * COALESCE(o.limit_price, c.current_price, c.ipo_price)
       END
     ), 0) AS reserved
     FROM fdx_orders o
     JOIN fdx_companies c ON c.id = o.company_id
     WHERE o.account_id = ? AND o.side = 'BUY' AND o.status IN ('open','partial','pending_ipo')`
  ).bind(accountKey).all();

  const reserved = (reserves && reserves[0] && reserves[0].reserved) || 0;
  return Math.max(0, Math.round((account.balance - reserved) * 100) / 100);
}

// ---------- index computation ----------

export async function computeAndSnapshotIndex(db) {
  const { results: companies } = await db.prepare(
    "SELECT * FROM fdx_companies WHERE status = 'active'"
  ).all();

  if (!companies || companies.length === 0) {
    await db.prepare(
      'INSERT INTO fdx_index_snapshots (index_value, total_market_cap, advancing, declining, unchanged) VALUES (?, ?, ?, ?, ?)'
    ).bind(1000, 0, 0, 0, 0).run();
    return;
  }

  let totalMarketCap = 0;
  let advancing = 0, declining = 0, unchanged = 0;

  for (const company of companies) {
    const price = company.current_price || company.ipo_price;
    const shares = company.total_shares || 0;
    totalMarketCap += price * shares;

    if (company.prev_close_price && company.prev_close_price > 0) {
      if (price > company.prev_close_price) advancing++;
      else if (price < company.prev_close_price) declining++;
      else unchanged++;
    }
  }

  // Base: find the first snapshot's market cap for calibration
  const firstSnapshot = await db.prepare(
    'SELECT total_market_cap FROM fdx_index_snapshots ORDER BY id ASC LIMIT 1'
  ).first();

  let indexValue = 1000;
  if (firstSnapshot && firstSnapshot.total_market_cap > 0) {
    indexValue = Math.round((totalMarketCap / firstSnapshot.total_market_cap) * 1000 * 100) / 100;
  }

  await db.prepare(
    'INSERT INTO fdx_index_snapshots (index_value, total_market_cap, advancing, declining, unchanged) VALUES (?, ?, ?, ?, ?)'
  ).bind(indexValue, Math.round(totalMarketCap * 100) / 100, advancing, declining, unchanged).run();
}

// ---------- fundamental sync from banking ----------

export async function syncFundamentalsFromBank(db) {
  const { results: companies } = await db.prepare(
    "SELECT * FROM fdx_companies WHERE linked_bank_account IS NOT NULL AND status IN ('active','halted')"
  ).all();

  for (const company of companies) {
    const account = await db.prepare(
      'SELECT balance, total_deposited, total_withdrawn FROM banking_accounts WHERE key = ?'
    ).bind(company.linked_bank_account).first();

    if (!account) continue;

    await db.prepare(
      `UPDATE fdx_companies SET
         fundamental_assets     = ?,
         fundamental_revenue    = ?,
         fundamental_earnings   = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    ).bind(
      account.balance || 0,
      account.total_deposited || 0,
      (account.total_deposited || 0) - (account.total_withdrawn || 0),
      company.id
    ).run();
  }
}
