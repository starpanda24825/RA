/* ============================================================
   Regnum Aeternum — Worker
   Fiducia Exchange: Anti-Market Manipulation Layer
   Wash-trade detection, pump & dump, spoofing, position limits.
   ============================================================ */

// ---------- check order before placement ----------

export async function validateOrderPreTrade(db, order) {
  const flags = [];
  
  // 1. Wash trade detection: same account buying and selling same stock
  if (order.side === 'BUY') {
    const selfer = await db.prepare(
      `SELECT id FROM fdx_orders
       WHERE company_id = ? AND account_id = ? AND side = 'SELL'
         AND status IN ('open','partial')`
    ).bind(order.company_id, order.account_id).first();
    if (selfer) {
      flags.push({ reason: 'WASH_TRADE_POTENTIAL', severity: 'high' });
    }
  }

  // 2. Check position limit (max 15% of float)
  const company = await db.prepare(
    'SELECT * FROM fdx_companies WHERE id = ?'
  ).bind(order.company_id).first();
  
  if (company && order.side === 'BUY') {
    const maxPosPct = await getSettingNum(db, 'max_position_pct', 15) / 100;
    const float = company.shares_in_float || company.total_shares;
    const portfolio = await db.prepare(
      'SELECT quantity FROM fdx_portfolios WHERE account_id = ? AND company_id = ?'
    ).bind(order.account_id, order.company_id).first();
    
    const currentQty = (portfolio && portfolio.quantity) || 0;
    const openBuyQty = await db.prepare(
      `SELECT COALESCE(SUM(quantity - quantity_filled), 0) AS total
       FROM fdx_orders WHERE company_id = ? AND account_id = ? AND side = 'BUY'
       AND status IN ('open','partial')`
    ).bind(order.company_id, order.account_id).first();
    
    const potentialTotal = currentQty + (openBuyQty.total || 0) + order.quantity;
    const maxAllowed = Math.floor(float * maxPosPct);
    
    if (maxAllowed > 0 && potentialTotal > maxAllowed) {
      flags.push({
        reason: `POSITION_LIMIT: would hold ${potentialTotal}/${float} shares (max ${(maxPosPct*100).toFixed(0)}%)`,
        severity: 'high',
      });
    }
  }

  // 3. Check max order size (5% of float)
  if (company) {
    const maxOrderPct = await getSettingNum(db, 'max_order_pct', 5) / 100;
    const float = company.shares_in_float || company.total_shares;
    const maxOrderSize = Math.floor(float * maxOrderPct);
    if (maxOrderSize > 0 && order.quantity > maxOrderSize) {
      flags.push({
        reason: `ORDER_SIZE: ${order.quantity} exceeds max ${maxOrderSize} (${(maxOrderPct*100).toFixed(0)}% of float)`,
        severity: 'medium',
      });
    }
  }

  // 4. Check rate limiting (10 orders per minute per account)
  const oneMinuteAgo = new Date(Date.now() - 60000).toISOString();
  const recentOrderCount = await db.prepare(
    `SELECT COUNT(*) AS c FROM fdx_orders
     WHERE account_id = ? AND placed_at > ?`
  ).bind(order.account_id, oneMinuteAgo).first();

  if (recentOrderCount && recentOrderCount.c >= 10) {
    flags.push({ reason: 'RATE_LIMIT: max 10 orders per minute', severity: 'high' });
  }

  // 5. Price sanity check
  if (order.limit_price && company && company.current_price) {
    const lastPrice = company.current_price;
    if (order.limit_price > lastPrice * 10 || order.limit_price < lastPrice * 0.1) {
      flags.push({
        reason: `PRICE_SANITY: limit ${order.limit_price} is far from last price ${lastPrice}`,
        severity: 'medium',
      });
    }
  }

  // 6. Pump & dump detection
  if (order.side === 'SELL') {
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const buyVolume = await db.prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS total FROM fdx_orders
       WHERE company_id = ? AND account_id = ? AND side = 'BUY'
         AND status IN ('filled','partial') AND placed_at > ?`
    ).bind(order.company_id, order.account_id, oneHourAgo).first();

    const totalHourlyVolume = await db.prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS total FROM fdx_trades
       WHERE company_id = ? AND executed_at > ?`
    ).bind(order.company_id, oneHourAgo).first();

    if (totalHourlyVolume.total > 0 && buyVolume.total / totalHourlyVolume.total > 0.3) {
      // Account placed >30% of buy orders in last hour
      if (company && company.prev_close_price && company.current_price) {
        const dayChange = ((company.current_price - company.prev_close_price) / company.prev_close_price) * 100;
        if (dayChange > 15) {
          flags.push({
            reason: 'PUMP_AND_DUMP: large buy volume + price up >15% + now selling',
            severity: 'high',
          });
        }
      }
    }
  }

  return flags;
}

// ---------- check after trade execution ----------

export async function validateTradePostExecution(db, trade) {
  const flags = [];

  // 1. Same-account wash trade check
  if (trade.buyer_account === trade.seller_account) {
    flags.push({ reason: 'WASH_TRADE: buyer and seller are the same account', severity: 'critical' });
    await flagTrade(db, trade.id, 'WASH_TRADE: same account');
  }

  // 2. Check for suspicious timing (multiple trades within seconds)
  const recentTrades = await db.prepare(
    `SELECT COUNT(*) AS c FROM fdx_trades
     WHERE company_id = ? AND buyer_account = ? AND
       executed_at > datetime(?, '-5 seconds') AND id != ?`
  ).bind(trade.company_id, trade.buyer_account, trade.executed_at, trade.id).first();

  if (recentTrades && recentTrades.c >= 3) {
    flags.push({
      reason: 'RAPID_TRADING: 3+ trades in 5 seconds on same stock',
      severity: 'low',
    });
  }

  return flags;
}

// ---------- spoofing detection ----------

export async function checkSpoofing(db, order, cancelledAfterSeconds) {
  if (cancelledAfterSeconds > 120) return null; // Only flag quick cancels (<2min)

  const company = await db.prepare(
    'SELECT current_price, prev_close_price FROM fdx_companies WHERE id = ?'
  ).bind(order.company_id).first();

  if (!company) return null;

  // Check if price moved >1% while the order was open
  if (company.prev_close_price && company.current_price) {
    const pctMove = Math.abs((company.current_price - company.prev_close_price) / company.prev_close_price) * 100;
    if (pctMove > 1 && order.quantity > 500) {
      return { reason: 'SPOOFING: large order (>500 shares) cancelled within 2 min while price moved >1%', severity: 'medium' };
    }
  }

  return null;
}

// ---------- helpers ----------

async function getSettingNum(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM fdx_settings WHERE key = ?').bind(key).first();
  return row ? Number(row.value) : fallback;
}

async function flagTrade(db, tradeId, reason) {
  await db.prepare(
    'UPDATE fdx_trades SET flagged = 1, flag_reason = ? WHERE id = ?'
  ).bind(reason, tradeId).run();
}

export async function flagOrder(db, orderId, reason) {
  await db.prepare(
    'UPDATE fdx_orders SET flagged = 1, flag_reason = ? WHERE id = ?'
  ).bind(reason, orderId).run();
}
