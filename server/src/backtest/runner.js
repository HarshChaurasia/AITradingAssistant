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

/**
 * Trim a candle series to a date range.
 *
 * Bars OUTSIDE the range are kept, not discarded - the range restricts where
 * trades may be taken, not what the indicators may see. Slicing the array
 * instead would warm a 200-bar EMA from a truncated history, so the same bar
 * would produce a different value here than it did live, and the result would
 * stop predicting anything.
 */
function tradeWindowFor(candles, { from, to }) {
  if (!from && !to) return null;

  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;

  let tradeFrom = 0;
  let tradeTo = candles.length;

  if (Number.isFinite(fromMs)) {
    const found = candles.findIndex((c) => Date.parse(c.open_time) >= fromMs);
    tradeFrom = found === -1 ? candles.length : found;
  }
  if (Number.isFinite(toMs)) {
    const found = candles.findIndex((c) => Date.parse(c.open_time) > toMs);
    tradeTo = found === -1 ? candles.length : found;
  }

  return { tradeFrom, tradeTo };
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
  /**
   * The spread comes from the broker unless the caller insists otherwise.
   *
   * One number cannot serve a sweep: 0.0002 is about right for EURUSD and is
   * effectively ZERO for BTCUSD, whose real spread is twelve dollars. A
   * multi-symbol sweep with a single spread silently flatters whichever
   * instruments are priced in the larger units, which on this account is
   * every one that matters.
   */
  const brokerSpread = Number(symbol.spread_points) * Number(symbol.point);
  const spreadPrice = Number.isFinite(Number(options.spreadPrice))
    && options.spreadPrice !== null
    && options.spreadPrice !== ''
    ? Number(options.spreadPrice)
    : (brokerSpread > 0 ? brokerSpread : 0);

  // A time stop is a property of the setup, not of the caller, so it comes
  // from the strategy's own parameters rather than from the request.
  const runOptions = {
    startingBalance,
    riskPctPerTrade: 1,
    maxHoldBars: mergedParams.maxHoldBars ?? null,
    ...options,
    spreadPrice
  };

  // A date range narrows the tradeable window and the walk-forward split is
  // then taken WITHIN it, so "the last year" means a year of in-sample and
  // out-of-sample, not a year plus whatever else happens to be stored.
  const window = tradeWindowFor(candles, { from: options.from, to: options.to });
  const rangeFrom = window ? window.tradeFrom : 0;
  const rangeTo = window ? window.tradeTo : candles.length;
  if (rangeTo - rangeFrom < 2) {
    throw new Error(
      `no candles stored for ${symbol.broker_symbol} ${timeframe} between ` +
      `${options.from || 'the start'} and ${options.to || 'now'}`
    );
  }

  const full = runBacktest({
    candles, strategy, params: mergedParams, symbol,
    options: { ...runOptions, tradeFrom: rangeFrom, tradeTo: rangeTo }
  });
  const metrics = computeMetrics(full.trades, { startingBalance });

  // The split is taken across the chosen window, not the whole store.
  const span = rangeTo - rangeFrom;
  const cut = rangeFrom + Math.floor(span * (options.inSampleFraction ?? 0.7));
  const inSampleRange = { tradeFrom: rangeFrom, tradeTo: cut };
  const outOfSampleRange = { tradeFrom: cut, tradeTo: rangeTo };
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

  /**
   * Why a window produced no trades.
   *
   * A zero-trade result reads as "this strategy never fires", and that is
   * usually wrong: the commonest cause by far is an account too small to
   * afford one minimum lot at the configured risk, which refuses every setup
   * silently. Saying so turns an unreadable verdict into a one-line fix.
   */
  const diagnose = (result) => {
    if (result.trades.length > 0 || result.skipped.length === 0) return null;
    // Bucket on the shape of the reason, not its text: every message carries
    // the specific numbers for that bar, so counting raw strings would report
    // eighty-five distinct "reasons" for one cause.
    const family = (reason) => reason.replace(/-?[\d.]+/g, '#');
    const reasons = new Map();
    for (const s of result.skipped) {
      const key = family(s.reason);
      const seen = reasons.get(key) || { count: 0, example: s.reason };
      seen.count += 1;
      reasons.set(key, seen);
    }
    const [, best] = [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)[0];
    const reason = best.example;
    const count = best.count;
    return {
      setupsFired: result.skipped.length,
      commonest: reason,
      count,
      detail:
        `${result.skipped.length} setups fired but every one was skipped — ` +
        `${count} of them because ${reason}. ` +
        `With a starting balance of ${startingBalance} at ${runOptions.riskPctPerTrade}% risk, ` +
        `the risk budget is ${(startingBalance * runOptions.riskPctPerTrade / 100).toFixed(2)} per trade.`
    };
  };

  const skips = {
    full: full.skipped.length,
    inSample: inResult.skipped.length,
    outOfSample: outResult.skipped.length,
    diagnosis: diagnose(outResult) || diagnose(full)
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
        skips,
        range: {
          from: candles[rangeFrom]?.open_time ?? null,
          to: candles[Math.max(rangeFrom, rangeTo - 1)]?.open_time ?? null,
          bars: span
        },
        costs: {
          spreadPrice: runOptions.spreadPrice ?? 0,
          spreadSource: options.spreadPrice ? 'caller' : 'broker',
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

  return {
    runId, metrics, walkForward, passed, failures, thresholds, skips, backfill,
    bars: span,
    costs: { spreadPrice, spreadSource: options.spreadPrice ? 'caller' : 'broker' },
    // Scalps are judged partly on how they leave: a strategy whose exits are
    // nearly all time stops is not reaching its targets.
    exits: full.trades.reduce((acc, t) => {
      acc[t.exitReason] = (acc[t.exitReason] || 0) + 1;
      return acc;
    }, {}),
    range: {
      from: candles[rangeFrom]?.open_time ?? null,
      to: candles[Math.max(rangeFrom, rangeTo - 1)]?.open_time ?? null
    }
  };
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
  symbolIds,
  symbolId,
  strategyNames,
  timeframes,
  params = {},
  options = {},
  bridge = null,
  backfillBars = 2000,
  onProgress = null
}) {
  const symbols = symbolIds && symbolIds.length ? symbolIds : [symbolId];
  const results = [];
  const total = symbols.length * strategyNames.length * timeframes.length;
  let done = 0;

  for (const sym of symbols) {
    for (const strategyName of strategyNames) {
      for (const timeframe of timeframes) {
        try {
          const run = await executeRun({
            strategyName, symbolId: sym, timeframe, params, options, bridge, backfillBars
          });
          results.push({
            symbolId: sym,
            strategyName,
            timeframe,
            ok: true,
            runId: run.runId,
            passed: run.passed,
            failures: run.failures,
            skips: run.skips,
            range: run.range,
            costs: run.costs,
            exits: run.exits,
            outOfSample: run.walkForward.outOfSample,
            bars: run.bars
          });
        } catch (error) {
          results.push({ symbolId: sym, strategyName, timeframe, ok: false, error: error.message });
        }
        done += 1;
        if (onProgress) onProgress({ done, total, symbolId: sym, strategyName, timeframe });
      }
    }
  }

  return {
    symbolIds: symbols,
    combinations: results.length,
    passed: results.filter((r) => r.ok && r.passed).length,
    failed: results.filter((r) => r.ok && !r.passed).length,
    errored: results.filter((r) => !r.ok).length,
    results
  };
}

module.exports = { executeRun, sweep, tradeWindowFor, splitWalkForward, evaluateThresholds, listRuns, getRun };
