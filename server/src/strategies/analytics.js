const { query } = require('../db/pool');

/**
 * What each strategy has actually done, split by the timeframe it did it on.
 *
 * Two separate questions get answered side by side, and they must not be
 * confused: what a backtest predicted, and what the live/demo loop produced.
 * A strategy can pass every backtest and have taken no trade at all, so the
 * live columns are counted from the trades table rather than inferred from a
 * verdict.
 */

function ratio(part, whole) {
  return whole > 0 ? Number(((part / whole) * 100).toFixed(2)) : null;
}

/**
 * Live and demo results per strategy and timeframe.
 *
 * Open trades are counted separately from closed ones. Folding an open
 * position's floating P&L into a win rate would report a result that has not
 * happened yet.
 */
async function liveByStrategyTimeframe({ mode = 'demo' } = {}) {
  const rows = await query(
    `SELECT st.name          AS strategy,
            sig.timeframe    AS timeframe,
            COUNT(*)                                                  AS signals,
            SUM(sig.status = 'rejected')                              AS rejected,
            SUM(t.id IS NOT NULL)                                     AS tradesOpened,
            SUM(t.status = 'CLOSED')                                  AS tradesClosed,
            SUM(t.status = 'OPEN')                                    AS tradesOpen,
            SUM(t.status = 'CLOSED' AND t.pnl > 0)                    AS wins,
            SUM(t.status = 'CLOSED' AND t.pnl <= 0)                   AS losses,
            COALESCE(SUM(CASE WHEN t.status = 'CLOSED' THEN t.pnl END), 0) AS pnl
       FROM signals sig
       JOIN strategies st ON st.id = sig.strategy_id
       LEFT JOIN trades t ON t.signal_id = sig.id AND t.mode = sig.mode
      WHERE sig.mode = ?
      GROUP BY st.name, sig.timeframe
      ORDER BY st.name, sig.timeframe`,
    [mode]
  );

  return rows.map((r) => {
    const closed = Number(r.tradesClosed);
    return {
      strategy: r.strategy,
      timeframe: r.timeframe,
      signals: Number(r.signals),
      rejected: Number(r.rejected),
      tradesOpened: Number(r.tradesOpened),
      tradesClosed: closed,
      tradesOpen: Number(r.tradesOpen),
      wins: Number(r.wins),
      losses: Number(r.losses),
      pnl: Number(r.pnl),
      winRatePct: ratio(Number(r.wins), closed),
      avgPnl: closed > 0 ? Number((Number(r.pnl) / closed).toFixed(2)) : null
    };
  });
}

/**
 * Every backtest verdict, keyed by strategy, symbol and timeframe.
 *
 * Only the newest run for each combination is reported. Older runs are the
 * history of the parameters, not a second opinion on them, and averaging them
 * together would let a stale failure drag down a fixed strategy for ever.
 */
async function backtestMatrix() {
  const rows = await query(
    `SELECT r.id, r.timeframe, r.passed, r.metrics, r.created_at,
            s.name AS strategy, sym.broker_symbol AS symbol
       FROM backtest_runs r
       JOIN strategies s   ON s.id = r.strategy_id
       JOIN symbols sym    ON sym.id = r.symbol_id
       JOIN (SELECT strategy_id, symbol_id, timeframe, MAX(id) AS newest
               FROM backtest_runs GROUP BY strategy_id, symbol_id, timeframe) latest
         ON latest.newest = r.id
      ORDER BY s.name, sym.broker_symbol, r.timeframe`
  );

  return rows.map((r) => {
    const oos = r.metrics?.walkForward?.outOfSample || {};
    return {
      runId: r.id,
      strategy: r.strategy,
      symbol: r.symbol,
      timeframe: r.timeframe,
      passed: r.passed === 1,
      createdAt: r.created_at,
      trades: oos.trades ?? null,
      profitFactor: Number.isFinite(oos.profitFactor) ? oos.profitFactor : null,
      netProfit: oos.netProfit ?? null,
      winRatePct: oos.winRatePct ?? null,
      maxDrawdownPct: oos.maxDrawdownPct ?? null,
      failures: r.metrics?.failures || []
    };
  });
}

/**
 * The whole picture for the strategies screen: registration state, the
 * backtest matrix, and what each one has produced live.
 */
async function strategyAnalytics({ mode = 'demo' } = {}) {
  const registered = await query('SELECT * FROM strategies ORDER BY name');
  const live = await liveByStrategyTimeframe({ mode });
  const matrix = await backtestMatrix();

  const strategies = registered.map((row) => {
    const mine = live.filter((l) => l.strategy === row.name);
    const runs = matrix.filter((m) => m.strategy === row.name);
    const closed = mine.reduce((n, l) => n + l.tradesClosed, 0);
    const wins = mine.reduce((n, l) => n + l.wins, 0);

    return {
      id: row.id,
      name: row.name,
      version: row.version,
      status: row.status,
      enabled: row.enabled === 1,
      params: row.params,
      byTimeframe: mine,
      totals: {
        signals: mine.reduce((n, l) => n + l.signals, 0),
        tradesClosed: closed,
        tradesOpen: mine.reduce((n, l) => n + l.tradesOpen, 0),
        wins,
        losses: mine.reduce((n, l) => n + l.losses, 0),
        pnl: Number(mine.reduce((n, l) => n + l.pnl, 0).toFixed(2)),
        winRatePct: ratio(wins, closed)
      },
      backtests: {
        runs: runs.length,
        passed: runs.filter((r) => r.passed).length,
        best: runs.filter((r) => r.passed)
          .sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))[0] || null
      }
    };
  });

  return { mode, strategies, matrix };
}

async function setStrategyEnabled(id, enabled) {
  await query('UPDATE strategies SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, Number(id)]);
  const rows = await query('SELECT * FROM strategies WHERE id = ?', [Number(id)]);
  return rows[0] || null;
}

const STATUSES = ['draft', 'backtested', 'demo', 'live'];

async function setStrategyStatus(id, status) {
  if (!STATUSES.includes(status)) {
    throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  }
  await query('UPDATE strategies SET status = ? WHERE id = ?', [status, Number(id)]);
  const rows = await query('SELECT * FROM strategies WHERE id = ?', [Number(id)]);
  return rows[0] || null;
}

module.exports = {
  strategyAnalytics,
  liveByStrategyTimeframe,
  backtestMatrix,
  setStrategyEnabled,
  setStrategyStatus,
  STATUSES
};
