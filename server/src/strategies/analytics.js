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
            -- DISTINCT because the joins below fan out: one signal with 278
            -- cancelled retry rows counted as 278 signals, which is how a
            -- timeframe with two signals reported 279.
            COUNT(DISTINCT sig.id)                                    AS signals,
            COUNT(DISTINCT CASE WHEN sig.status = 'rejected' THEN sig.id END) AS rejected,
            COUNT(DISTINCT CASE WHEN t.status <> 'CANCELLED' THEN t.id END) AS tradesOpened,
            COUNT(DISTINCT CASE WHEN t.status = 'CLOSED' THEN t.id END)     AS tradesClosed,
            COUNT(DISTINCT CASE WHEN t.status = 'OPEN' THEN t.id END)       AS tradesOpen,
            COUNT(DISTINCT CASE WHEN t.status = 'CLOSED' AND t.pnl > 0 THEN t.id END)  AS wins,
            COUNT(DISTINCT CASE WHEN t.status = 'CLOSED' AND t.pnl <= 0 THEN t.id END) AS losses,
            COALESCE(SUM(CASE WHEN t.status = 'CLOSED' THEN t.pnl END), 0) AS pnl,
            COALESCE(SUM(CASE WHEN t.status = 'CLOSED' AND t.pnl > 0 THEN t.pnl END), 0)  AS grossWin,
            COALESCE(SUM(CASE WHEN t.status = 'CLOSED' AND t.pnl <= 0 THEN t.pnl END), 0) AS grossLoss,
            MAX(CASE WHEN t.status = 'CLOSED' THEN t.pnl END)          AS bestTrade,
            MIN(CASE WHEN t.status = 'CLOSED' THEN t.pnl END)          AS worstTrade,
            -- Refusals the missed-signal grader has since judged. This is the
            -- only measure there is of a signal the system never acted on.
            COUNT(DISTINCT CASE WHEN o.verdict = 'costly' THEN sig.id END)  AS refusedButWorked,
            COUNT(DISTINCT CASE WHEN o.verdict = 'correct' THEN sig.id END) AS refusedRightly
       FROM signals sig
       JOIN strategies st ON st.id = sig.strategy_id
       LEFT JOIN trades t ON t.signal_id = sig.id AND t.mode = sig.mode
       LEFT JOIN signal_outcomes o ON o.signal_id = sig.id
      WHERE sig.mode = ?
      GROUP BY st.name, sig.timeframe
      ORDER BY st.name, sig.timeframe`,
    [mode]
  );

  return rows.map((r) => {
    const closed = Number(r.tradesClosed);
    const grossWin = Number(r.grossWin);
    const grossLoss = Math.abs(Number(r.grossLoss));
    const refusedWorked = Number(r.refusedButWorked);
    const refusedRight = Number(r.refusedRightly);

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
      pnl: Number(Number(r.pnl).toFixed(2)),
      winRatePct: ratio(Number(r.wins), closed),
      // Expectancy per trade is what compounds. A 70% win rate with a negative
      // expectancy is a losing strategy that feels like a winning one, which
      // is exactly the trap a bare win rate sets.
      expectancy: closed > 0 ? Number((Number(r.pnl) / closed).toFixed(2)) : null,
      // Infinity is the honest answer when there are wins and no losses, but
      // it does not survive JSON - so it is null, with the win count beside it
      // rather than a fabricated number.
      profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : null,
      bestTrade: r.bestTrade === null ? null : Number(r.bestTrade),
      worstTrade: r.worstTrade === null ? null : Number(r.worstTrade),
      refusedButWorked: refusedWorked,
      refusedRightly: refusedRight,
      // Of the refusals the market has since judged, how often was refusing
      // the right call?
      refusalAccuracyPct: ratio(refusedRight, refusedRight + refusedWorked)
    };
  });
}

/**
 * The same figures again, split by symbol instead of timeframe.
 *
 * A strategy that works on BTCUSD and loses on EURUSD reads as mediocre when
 * the two are pooled. Splitting both ways is the only way to see which half
 * of the average is carrying the other.
 */
async function liveByStrategySymbol({ mode = 'demo' } = {}) {
  const rows = await query(
    `SELECT st.name           AS strategy,
            sym.broker_symbol AS symbol,
            COUNT(DISTINCT sig.id)                                          AS signals,
            COUNT(DISTINCT CASE WHEN sig.status = 'rejected' THEN sig.id END) AS rejected,
            COUNT(DISTINCT CASE WHEN t.status = 'CLOSED' THEN t.id END)     AS tradesClosed,
            COUNT(DISTINCT CASE WHEN t.status = 'OPEN' THEN t.id END)       AS tradesOpen,
            COUNT(DISTINCT CASE WHEN t.status = 'CLOSED' AND t.pnl > 0 THEN t.id END)  AS wins,
            COUNT(DISTINCT CASE WHEN t.status = 'CLOSED' AND t.pnl <= 0 THEN t.id END) AS losses,
            COALESCE(SUM(CASE WHEN t.status = 'CLOSED' THEN t.pnl END), 0)  AS pnl
       FROM signals sig
       JOIN strategies st ON st.id = sig.strategy_id
       JOIN symbols sym   ON sym.id = sig.symbol_id
       LEFT JOIN trades t ON t.signal_id = sig.id AND t.mode = sig.mode
      WHERE sig.mode = ?
      GROUP BY st.name, sym.broker_symbol
      ORDER BY st.name, sym.broker_symbol`,
    [mode]
  );

  return rows.map((r) => {
    const closed = Number(r.tradesClosed);
    return {
      strategy: r.strategy,
      symbol: r.symbol,
      signals: Number(r.signals),
      rejected: Number(r.rejected),
      tradesClosed: closed,
      tradesOpen: Number(r.tradesOpen),
      wins: Number(r.wins),
      losses: Number(r.losses),
      pnl: Number(Number(r.pnl).toFixed(2)),
      winRatePct: ratio(Number(r.wins), closed),
      expectancy: closed > 0 ? Number((Number(r.pnl) / closed).toFixed(2)) : null
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
  const registered = await query('SELECT * FROM strategies WHERE superseded_at IS NULL ORDER BY name');
  const live = await liveByStrategyTimeframe({ mode });
  const perSymbol = await liveByStrategySymbol({ mode });
  const matrix = await backtestMatrix();
  const scopes = await query(
    `SELECT sc.strategy_id, sc.symbol_id, sc.timeframe, sym.broker_symbol
       FROM strategy_scopes sc LEFT JOIN symbols sym ON sym.id = sc.symbol_id`
  );

  const strategies = registered.map((row) => {
    const mine = live.filter((l) => l.strategy === row.name);
    const mineBySymbol = perSymbol.filter((l) => l.strategy === row.name);
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
      bySymbol: mineBySymbol,
      // An empty list means "runs everywhere", which is the default and is a
      // different statement from "runs nowhere".
      scopes: scopes
        .filter((sc) => sc.strategy_id === row.id)
        .map((sc) => ({ symbolId: sc.symbol_id, symbol: sc.broker_symbol, timeframe: sc.timeframe })),
      totals: {
        signals: mine.reduce((n, l) => n + l.signals, 0),
        rejected: mine.reduce((n, l) => n + l.rejected, 0),
        tradesClosed: closed,
        tradesOpen: mine.reduce((n, l) => n + l.tradesOpen, 0),
        wins,
        losses: mine.reduce((n, l) => n + l.losses, 0),
        pnl: Number(mine.reduce((n, l) => n + l.pnl, 0).toFixed(2)),
        winRatePct: ratio(wins, closed),
        expectancy: closed > 0
          ? Number((mine.reduce((n, l) => n + l.pnl, 0) / closed).toFixed(2))
          : null,
        refusedButWorked: mine.reduce((n, l) => n + l.refusedButWorked, 0),
        refusedRightly: mine.reduce((n, l) => n + l.refusedRightly, 0)
      },
      // The timeframe this strategy has done best on, by expectancy rather
      // than total P&L: total rewards whichever timeframe simply traded most,
      // which is not the same as the one that traded best.
      bestTimeframe: mine
        .filter((l) => l.tradesClosed > 0)
        .sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity))[0] || null,
      bestSymbol: mineBySymbol
        .filter((l) => l.tradesClosed > 0)
        .sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity))[0] || null,
      backtests: {
        runs: runs.length,
        passed: runs.filter((r) => r.passed).length,
        best: runs.filter((r) => r.passed)
          .sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))[0] || null
      }
    };
  });

  /**
   * A ranking, so the screen can lead with an answer rather than a table.
   *
   * A strategy with no closed trades ranks last however good its backtest
   * looks. An untested claim and a measured result do not belong on the same
   * scale, and putting a promising backtest above a strategy that has actually
   * made money would be precisely the wrong advice.
   */
  const order = [...strategies].sort((a, b) => {
    const aTraded = a.totals.tradesClosed > 0;
    const bTraded = b.totals.tradesClosed > 0;
    if (aTraded !== bTraded) return bTraded ? 1 : -1;
    if (aTraded && bTraded) return (b.totals.expectancy ?? 0) - (a.totals.expectancy ?? 0);
    return b.backtests.passed - a.backtests.passed
      || (b.backtests.best?.profitFactor ?? 0) - (a.backtests.best?.profitFactor ?? 0);
  });
  order.forEach((s, i) => { s.rank = i + 1; });

  /**
   * Which timeframe is working, across every strategy.
   *
   * This is the question multi-timeframe trading exists to answer, and it
   * cannot be read off the per-strategy tables without doing the arithmetic
   * by eye.
   */
  const buckets = new Map();
  for (const s of strategies) {
    for (const t of s.byTimeframe) {
      const bucket = buckets.get(t.timeframe) || {
        timeframe: t.timeframe, signals: 0, rejected: 0, tradesClosed: 0, wins: 0, losses: 0, pnl: 0
      };
      bucket.signals += t.signals;
      bucket.rejected += t.rejected;
      bucket.tradesClosed += t.tradesClosed;
      bucket.wins += t.wins;
      bucket.losses += t.losses;
      bucket.pnl += t.pnl;
      buckets.set(t.timeframe, bucket);
    }
  }

  const byTimeframe = [...buckets.values()]
    .map((b) => ({
      ...b,
      pnl: Number(b.pnl.toFixed(2)),
      winRatePct: ratio(b.wins, b.tradesClosed),
      expectancy: b.tradesClosed > 0 ? Number((b.pnl / b.tradesClosed).toFixed(2)) : null
    }))
    .sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity));

  const symbolBuckets = new Map();
  for (const row of perSymbol) {
    const bucket = symbolBuckets.get(row.symbol) || {
      symbol: row.symbol, signals: 0, rejected: 0, tradesClosed: 0, wins: 0, losses: 0, pnl: 0
    };
    bucket.signals += row.signals;
    bucket.rejected += row.rejected;
    bucket.tradesClosed += row.tradesClosed;
    bucket.wins += row.wins;
    bucket.losses += row.losses;
    bucket.pnl += row.pnl;
    symbolBuckets.set(row.symbol, bucket);
  }

  const bySymbol = [...symbolBuckets.values()]
    .map((b) => ({
      ...b,
      pnl: Number(b.pnl.toFixed(2)),
      winRatePct: ratio(b.wins, b.tradesClosed),
      expectancy: b.tradesClosed > 0 ? Number((b.pnl / b.tradesClosed).toFixed(2)) : null
    }))
    .sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity));

  return { mode, strategies, matrix, byTimeframe, bySymbol };
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
  liveByStrategySymbol,
  backtestMatrix,
  setStrategyEnabled,
  setStrategyStatus,
  STATUSES
};
