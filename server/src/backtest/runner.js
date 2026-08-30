const { query } = require('../db/pool');
const { getCandles, syncCandles } = require('../market/candles');
const { getStrategy, mergeParams } = require('../strategies/registry');
const { runBacktest } = require('./engine');
const { computeMetrics } = require('./metrics');

const DEFAULT_THRESHOLDS = { minProfitFactor: 1.3, maxDrawdownPct: 15, minTrades: 50 };

/**
 * Split point for walk-forward validation.
 *
 * Returns index ranges rather than sliced arrays. The engine is then handed
 * the FULL candle series with a restricted trading window, so indicators warm
 * up from real history in both halves. Slicing instead makes the same bar
 * produce a different EMA in each window, and the out-of-sample result stops
 * predicting live behaviour.
 */
function splitWalkForward(candles, { inSampleFraction = 0.7 } = {}) {
  const cut = Math.floor(candles.length * inSampleFraction);
  return {
    cut,
    inSample: candles.slice(0, cut),
    outOfSample: candles.slice(cut),
    inSampleRange: { tradeFrom: 0, tradeTo: cut },
    outOfSampleRange: { tradeFrom: cut, tradeTo: candles.length }
  };
}

function evaluateThresholds(metrics, thresholds) {
  const failures = [];

  if (metrics.profitFactor < thresholds.minProfitFactor) {
    failures.push(
      `profit factor ${Number(metrics.profitFactor).toFixed(2)} is below ${thresholds.minProfitFactor}`
    );
  }
  if (metrics.maxDrawdownPct > thresholds.maxDrawdownPct) {
    failures.push(
      `max drawdown ${metrics.maxDrawdownPct.toFixed(2)}% exceeds ${thresholds.maxDrawdownPct}%`
    );
  }
  if (metrics.trades < thresholds.minTrades) {
    failures.push(`only ${metrics.trades} trades, ${thresholds.minTrades} required`);
  }
  if (metrics.expectancy <= 0) {
    failures.push(`expectancy ${metrics.expectancy.toFixed(4)} is not positive`);
  }

  return { passed: failures.length === 0, failures };
}

async function loadThresholds() {
  const rows = await query('SELECT setting_value FROM settings WHERE setting_key = ?', [
    'backtestThresholds'
  ]);
  return rows.length ? { ...DEFAULT_THRESHOLDS, ...rows[0].setting_value } : DEFAULT_THRESHOLDS;
}

function toMysqlDateTime(isoString) {
  return isoString.slice(0, 19).replace('T', ' ');
}

/**
 * Pull history for a symbol/timeframe that has none stored.
 *
 * "Backtest is failing" almost always means this: the dashboard offers every
 * timeframe, the scheduler only ever syncs one, and the other five have an
 * empty candle table. Rather than telling the operator to go and press
 * Backfill on another screen, fetch it here - but only when a broker
 * connection was actually handed in, and never silently on a symbol that has
 * partial history, which would paper over a gap.
 */
async function backfillIfEmpty({ bridge, symbol, timeframe, bars }) {
  if (!bridge) return { attempted: false, reason: 'no broker bridge available' };
  try {
    const result = await syncCandles(bridge, {
      symbolId: symbol.id,
      brokerSymbol: symbol.broker_symbol,
      timeframe,
      count: bars
    });
    return { attempted: true, ...result };
  } catch (error) {
    return { attempted: true, error: error.message };
  }
}

async function executeRun({
  strategyName, symbolId, timeframe = 'H1', params = {}, options = {},
  // Optional. When present, a missing candle store is filled rather than
  // being reported back as a failure the operator has to go and fix.
  bridge = null,
  backfillBars = 2000
}) {
  // Resolve the strategy first: an unknown name should fail before any query.
  const strategy = getStrategy(strategyName);

  const symbolRows = await query('SELECT * FROM symbols WHERE id = ?', [symbolId]);
  if (symbolRows.length === 0) throw new Error(`unknown symbolId ${symbolId}`);
  const symbol = symbolRows[0];

  let candles = await getCandles({ symbolId, timeframe, limit: 20000 });
  let backfill = null;
  if (candles.length === 0) {
    backfill = await backfillIfEmpty({ bridge, symbol, timeframe, bars: backfillBars });
    candles = await getCandles({ symbolId, timeframe, limit: 20000 });
  }
  if (candles.length === 0) {
    const detail = backfill?.error ? ` (backfill failed: ${backfill.error})` : '';
    throw new Error(`no candles stored for ${symbol.broker_symbol} ${timeframe} — backfill first${detail}`);
  }

  const mergedParams = mergeParams(strategy, params);
  const startingBalance = options.startingBalance ?? 10000;
  const runOptions = { startingBalance, riskPctPerTrade: 1, ...options };

  const full = runBacktest({ candles, strategy, params: mergedParams, symbol, options: runOptions });
  const metrics = computeMetrics(full.trades, { startingBalance });

  const { inSampleRange, outOfSampleRange } = splitWalkForward(candles, {
    inSampleFraction: options.inSampleFraction ?? 0.7
  });
  const inResult = runBacktest({
    candles, strategy, params: mergedParams, symbol,
    options: { ...runOptions, ...inSampleRange }
  });
  const outResult = runBacktest({
    candles, strategy, params: mergedParams, symbol,
    options: { ...runOptions, ...outOfSampleRange }
  });

  const walkForward = {
    inSample: computeMetrics(inResult.trades, { startingBalance }),
    outOfSample: computeMetrics(outResult.trades, { startingBalance })
  };

  // The verdict comes from out-of-sample only. Judging a strategy on the data
  // its parameters were chosen against is how overfitting reaches production.
  const thresholds = await loadThresholds();
  const { passed, failures } = evaluateThresholds(walkForward.outOfSample, thresholds);

  const strategyRow = await query('SELECT id FROM strategies WHERE name = ? AND version = ?', [
    strategy.name,
    strategy.version
  ]);
  if (strategyRow.length === 0) {
    throw new Error(`strategy ${strategy.name} ${strategy.version} is not registered`);
  }

  const result = await query(
    `INSERT INTO backtest_runs
       (strategy_id, symbol_id, timeframe, sample, from_time, to_time, params, metrics, passed, created_at)
     VALUES (?, ?, ?, 'full', ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, UTC_TIMESTAMP())`,
    [
      strategyRow[0].id,
      symbolId,
      timeframe,
      toMysqlDateTime(candles[0].open_time),
      toMysqlDateTime(candles.at(-1).open_time),
      JSON.stringify(mergedParams),
      JSON.stringify({
        full: metrics,
        walkForward,
        thresholds,
        failures,
        costs: {
          spreadPrice: runOptions.spreadPrice ?? 0,
          slippagePrice: runOptions.slippagePrice ?? 0,
          commissionPerLot: runOptions.commissionPerLot ?? 0
        }
      }),
      passed ? 1 : 0
    ]
  );
  const runId = result.insertId;

  if (full.trades.length > 0) {
    const rows = full.trades.map((t) => [
      runId,
      t.side,
      t.lot,
      toMysqlDateTime(t.entryTime),
      t.entryPrice,
      toMysqlDateTime(t.exitTime),
      t.exitPrice,
      t.sl,
      t.tp,
      t.pnl,
      t.exitReason
    ]);
    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',');
    await query(
      `INSERT INTO backtest_trades
         (run_id, side, lot, entry_time, entry_price, exit_time, exit_price, sl, tp, pnl, exit_reason)
       VALUES ${placeholders}`,
      rows.flat()
    );
  }

  return { runId, metrics, walkForward, passed, failures, thresholds, backfill, bars: candles.length };
}

async function listRuns({ limit = 25 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 200);
  return query(
    `SELECT r.*, s.name AS strategy_name, sym.broker_symbol
       FROM backtest_runs r
       JOIN strategies s ON s.id = r.strategy_id
       JOIN symbols sym  ON sym.id = r.symbol_id
      ORDER BY r.id DESC
      LIMIT ${safeLimit}`
  );
}

async function getRun(runId) {
  const runs = await query(
    `SELECT r.*, s.name AS strategy_name, sym.broker_symbol
       FROM backtest_runs r
       JOIN strategies s ON s.id = r.strategy_id
       JOIN symbols sym  ON sym.id = r.symbol_id
      WHERE r.id = ?`,
    [runId]
  );
  if (runs.length === 0) return null;

  const trades = await query(
    'SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY entry_time',
    [runId]
  );
  return { run: runs[0], trades };
}

/**
 * Run one symbol across many timeframes and strategies in one request.
 *
 * Sequential on purpose: each run can trigger a backfill, and firing six
 * concurrent history requests at a single MT5 terminal is how the bridge
 * stops answering. A failure on one combination is recorded and the sweep
 * carries on - a missing D1 history must not cost the operator the H4 result
 * they were actually after.
 */
async function sweep({
  symbolId,
  strategyNames,
  timeframes,
  params = {},
  options = {},
  bridge = null,
  backfillBars = 2000
}) {
  const results = [];

  for (const strategyName of strategyNames) {
    for (const timeframe of timeframes) {
      try {
        const run = await executeRun({
          strategyName, symbolId, timeframe, params, options, bridge, backfillBars
        });
        results.push({
          strategyName,
          timeframe,
          ok: true,
          runId: run.runId,
          passed: run.passed,
          failures: run.failures,
          outOfSample: run.walkForward.outOfSample,
          bars: run.bars
        });
      } catch (error) {
        results.push({ strategyName, timeframe, ok: false, error: error.message });
      }
    }
  }

  return {
    symbolId,
    combinations: results.length,
    passed: results.filter((r) => r.ok && r.passed).length,
    failed: results.filter((r) => r.ok && !r.passed).length,
    errored: results.filter((r) => !r.ok).length,
    results
  };
}

module.exports = { executeRun, sweep, splitWalkForward, evaluateThresholds, listRuns, getRun };
