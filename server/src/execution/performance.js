const { query } = require('../db/pool');

/**
 * Daily performance, for answering "how is it actually doing".
 *
 * Deliberately reports activity as well as profit. On a strategy that trades
 * roughly once every four days, a run of zero-trade days is the expected
 * shape - and without showing evaluations and signals alongside the P&L, a
 * quiet week is indistinguishable from a broken system.
 */

async function dailyPerformance({ mode = 'demo', days = 30 } = {}) {
  const window = Math.min(Math.max(Number.parseInt(days, 10) || 30, 1), 365);

  const closed = await query(
    `SELECT DATE(closed_at) AS day,
            COUNT(*)                        AS trades,
            SUM(pnl > 0)                    AS wins,
            SUM(pnl <= 0)                   AS losses,
            COALESCE(SUM(pnl), 0)           AS pnl
       FROM trades
      WHERE mode = ? AND status = 'CLOSED' AND closed_at IS NOT NULL
        AND closed_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${window} DAY)
      GROUP BY DATE(closed_at) ORDER BY day`,
    [mode]
  );

  const opened = await query(
    `SELECT DATE(opened_at) AS day, COUNT(*) AS opened
       FROM trades
      WHERE mode = ? AND opened_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${window} DAY)
      GROUP BY DATE(opened_at) ORDER BY day`,
    [mode]
  );

  const signals = await query(
    `SELECT DATE(generated_at) AS day, status, COUNT(*) AS n
       FROM signals
      WHERE mode = ? AND generated_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${window} DAY)
      GROUP BY DATE(generated_at), status ORDER BY day`,
    [mode]
  );

  // One row per calendar day, including days with nothing at all - a gap in a
  // chart reads as missing data, whereas a zero reads as a quiet day.
  const equity = await query(
    `SELECT DATE(captured_at) AS day,
            MIN(equity) AS low, MAX(equity) AS high,
            SUBSTRING_INDEX(GROUP_CONCAT(equity ORDER BY captured_at DESC), ',', 1) AS close,
            COUNT(*) AS ticks
       FROM equity_snapshots
      WHERE mode = ? AND captured_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${window} DAY)
      GROUP BY DATE(captured_at) ORDER BY day`,
    [mode]
  );

  const key = (d) => new Date(d).toISOString().slice(0, 10);
  const byDay = new Map();
  const touch = (d) => {
    const k = key(d);
    if (!byDay.has(k)) {
      byDay.set(k, {
        day: k, trades: 0, wins: 0, losses: 0, pnl: 0, opened: 0,
        signalsCreated: 0, signalsRejected: 0, signalsExecuted: 0,
        equityClose: null, equityLow: null, equityHigh: null, ticks: 0
      });
    }
    return byDay.get(k);
  };

  for (const r of closed) {
    const d = touch(r.day);
    d.trades = Number(r.trades);
    d.wins = Number(r.wins);
    d.losses = Number(r.losses);
    d.pnl = Number(r.pnl);
  }
  for (const r of opened) touch(r.day).opened = Number(r.opened);
  for (const r of signals) {
    const d = touch(r.day);
    d.signalsCreated += Number(r.n);
    if (r.status === 'rejected') d.signalsRejected += Number(r.n);
    if (r.status === 'executed') d.signalsExecuted += Number(r.n);
  }
  for (const r of equity) {
    const d = touch(r.day);
    d.equityClose = Number(r.close);
    d.equityLow = Number(r.low);
    d.equityHigh = Number(r.high);
    d.ticks = Number(r.ticks);
  }

  const rows = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  let running = 0;
  for (const r of rows) {
    running += r.pnl;
    r.cumulativePnl = Number(running.toFixed(2));
    r.winRatePct = r.trades > 0 ? Number(((r.wins / r.trades) * 100).toFixed(1)) : null;
  }

  return rows;
}

async function breakdown({ mode = 'demo' } = {}) {
  const byStrategy = await query(
    `SELECT st.name AS strategy, st.status,
            COUNT(t.id)                                        AS trades,
            COALESCE(SUM(t.status = 'CLOSED' AND t.pnl > 0), 0) AS wins,
            COALESCE(SUM(CASE WHEN t.status = 'CLOSED' THEN t.pnl ELSE 0 END), 0) AS pnl
       FROM strategies st
       LEFT JOIN signals sig ON sig.strategy_id = st.id AND sig.mode = ?
       LEFT JOIN trades  t   ON t.signal_id = sig.id
      GROUP BY st.id ORDER BY st.name`,
    [mode]
  );

  const bySymbol = await query(
    `SELECT sym.broker_symbol AS symbol, sym.enabled, sym.watched,
            COUNT(t.id)                                        AS trades,
            COALESCE(SUM(t.status = 'CLOSED' AND t.pnl > 0), 0) AS wins,
            COALESCE(SUM(CASE WHEN t.status = 'CLOSED' THEN t.pnl ELSE 0 END), 0) AS pnl
       FROM symbols sym
       LEFT JOIN trades t ON t.symbol_id = sym.id AND t.mode = ?
      WHERE sym.watched = 1 OR sym.enabled = 1
      GROUP BY sym.id ORDER BY sym.broker_symbol`,
    [mode]
  );

  const runs = await query(
    `SELECT s.name AS strategy, sym.broker_symbol AS symbol, r.timeframe, r.passed,
            r.metrics->>'$.walkForward.outOfSample.profitFactor' AS pf,
            r.metrics->>'$.walkForward.outOfSample.trades'       AS trades
       FROM backtest_runs r
       JOIN strategies s ON s.id = r.strategy_id
       JOIN symbols sym  ON sym.id = r.symbol_id
      ORDER BY r.id DESC LIMIT 100`
  );

  return {
    byStrategy: byStrategy.map((r) => ({ ...r, trades: Number(r.trades), wins: Number(r.wins), pnl: Number(r.pnl) })),
    bySymbol: bySymbol.map((r) => ({ ...r, trades: Number(r.trades), wins: Number(r.wins), pnl: Number(r.pnl) })),
    backtests: runs.map((r) => ({
      strategy: r.strategy, symbol: r.symbol, timeframe: r.timeframe,
      passed: r.passed === 1,
      profitFactor: r.pf === null ? null : Number(r.pf),
      trades: r.trades === null ? null : Number(r.trades)
    }))
  };
}

module.exports = { dailyPerformance, breakdown };
