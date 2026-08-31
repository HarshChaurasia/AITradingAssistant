const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_runner_test';

async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  // A gold-shaped contract (100 units) is used deliberately. With a 100,000
  // unit FX contract, an ATR-based stop on a price-100 series makes every
  // risk-sized lot fall below min_lot, so the engine correctly skips every
  // trade and the assertions below would pass vacuously.
  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, synced_at, trade_mode, market_open, market_reason, market_checked_at)
     VALUES ('XAUUSD', 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, 1, UTC_TIMESTAMP(), 4, 1, 'open (test fixture)', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['XAUUSD']);

  // A trending series with periodic pullbacks, long enough for EMA(100).
  const rows = [];
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < 600; i += 1) {
    const drift = i * 0.02;
    const wave = Math.sin(i / 9) * 1.2;
    const close = 100 + drift + wave;
    const open = close - 0.02;
    // Bar ranges are kept tight relative to the per-bar move. With wide bars
    // the Donchian high can never be exceeded, the strategy never fires, and
    // the assertions below would pass while testing nothing.
    rows.push([
      sym.id, 'H1',
      new Date(start + i * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      open, close + 0.05, close - 0.05, close, 100, 0, 8
    ]);
  }
  const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',');
  await query(
    `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close,
       tick_volume, real_volume, spread) VALUES ${placeholders}`,
    rows.flat()
  );

  return sym.id;
}

test('splitWalkForward divides candles without overlap or loss', async (t) => {
  await seeded(t);
  const { splitWalkForward } = require('../src/backtest/runner');

  const candles = Array.from({ length: 100 }, (_, i) => ({ open_time: i }));
  const { inSample, outOfSample } = splitWalkForward(candles, { inSampleFraction: 0.7 });

  assert.equal(inSample.length, 70);
  assert.equal(outOfSample.length, 30);
  assert.equal(inSample.at(-1).open_time, 69);
  assert.equal(outOfSample[0].open_time, 70, 'out-of-sample starts where in-sample ends');
});

test('evaluateThresholds names every failing criterion', async (t) => {
  await seeded(t);
  const { evaluateThresholds } = require('../src/backtest/runner');

  const thresholds = { minProfitFactor: 1.3, maxDrawdownPct: 15, minTrades: 50 };

  const good = evaluateThresholds(
    { profitFactor: 2.0, maxDrawdownPct: 5, trades: 80, expectancy: 1 }, thresholds
  );
  assert.equal(good.passed, true);
  assert.deepEqual(good.failures, []);

  const bad = evaluateThresholds(
    { profitFactor: 1.0, maxDrawdownPct: 25, trades: 10, expectancy: -1 }, thresholds
  );
  assert.equal(bad.passed, false);
  assert.equal(bad.failures.length, 4, 'profit factor, drawdown, trade count and expectancy all fail');
});

test('executeRun persists a run with metrics and per-trade rows', async (t) => {
  const symbolId = await seeded(t);
  const { executeRun } = require('../src/backtest/runner');
  const { registerStrategies } = require('../src/strategies/registry');
  const { query } = require('../src/db/pool');
  await registerStrategies();

  const result = await executeRun({
    strategyName: 'trend-breakout',
    symbolId,
    timeframe: 'H1',
    params: {},
    options: { startingBalance: 10000, riskPctPerTrade: 1, spreadPrice: 0.0002, commissionPerLot: 7 }
  });

  assert.ok(result.runId > 0);
  assert.ok(result.metrics.trades > 0, 'the fixture series must produce trades');
  assert.equal(typeof result.passed, 'boolean');

  const runs = await query('SELECT * FROM backtest_runs WHERE id = ?', [result.runId]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].timeframe, 'H1');
  assert.ok(runs[0].metrics, 'metrics JSON stored');

  const stored = await query('SELECT COUNT(*) AS n FROM backtest_trades WHERE run_id = ?', [result.runId]);
  assert.equal(stored[0].n, result.metrics.trades, 'one row per trade');
});

test('executeRun reports in-sample and out-of-sample separately', async (t) => {
  const symbolId = await seeded(t);
  const { executeRun } = require('../src/backtest/runner');
  const { registerStrategies } = require('../src/strategies/registry');
  await registerStrategies();

  const result = await executeRun({
    strategyName: 'trend-breakout',
    symbolId,
    timeframe: 'H1',
    params: {},
    options: { startingBalance: 10000, riskPctPerTrade: 1 }
  });

  assert.ok(result.walkForward.inSample, 'in-sample metrics present');
  assert.ok(result.walkForward.outOfSample, 'out-of-sample metrics present');
  assert.equal(typeof result.walkForward.outOfSample.profitFactor, 'number');
});

test('the verdict is taken from out-of-sample results, not the full run', async (t) => {
  const symbolId = await seeded(t);
  const { executeRun } = require('../src/backtest/runner');
  const { registerStrategies } = require('../src/strategies/registry');
  const { query } = require('../src/db/pool');
  await registerStrategies();

  // Thresholds nothing can clear, so passing would prove the verdict came
  // from the wrong window.
  await query(
    `UPDATE settings SET setting_value = JSON_OBJECT(
       'minProfitFactor', 99, 'maxDrawdownPct', 0.001, 'minTrades', 100000)
     WHERE setting_key = 'backtestThresholds'`
  );

  const result = await executeRun({
    strategyName: 'trend-breakout', symbolId, timeframe: 'H1', params: {},
    options: { startingBalance: 10000, riskPctPerTrade: 1 }
  });

  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test('an unknown strategy is rejected by name', async (t) => {
  const symbolId = await seeded(t);
  const { executeRun } = require('../src/backtest/runner');

  await assert.rejects(
    () => executeRun({ strategyName: 'no-such-strategy', symbolId, timeframe: 'H1' }),
    /unknown strategy/
  );
});

test('a run over a symbol with no candles fails clearly', async (t) => {
  await seeded(t);
  const { executeRun } = require('../src/backtest/runner');
  const { registerStrategies } = require('../src/strategies/registry');
  const { query } = require('../src/db/pool');
  await registerStrategies();

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, synced_at, trade_mode, market_open, market_reason, market_checked_at)
     VALUES ('GBPUSD', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, UTC_TIMESTAMP(), 4, 1, 'open (test fixture)', UTC_TIMESTAMP())`
  );
  const [empty] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['GBPUSD']);

  await assert.rejects(
    () => executeRun({ strategyName: 'trend-breakout', symbolId: empty.id, timeframe: 'H1' }),
    /no candles/i
  );
});

test('getRun returns the run with its trades', async (t) => {
  const symbolId = await seeded(t);
  const { executeRun, getRun, listRuns } = require('../src/backtest/runner');
  const { registerStrategies } = require('../src/strategies/registry');
  await registerStrategies();

  const { runId, metrics } = await executeRun({
    strategyName: 'trend-breakout', symbolId, timeframe: 'H1', params: {},
    options: { startingBalance: 10000, riskPctPerTrade: 1 }
  });

  const detail = await getRun(runId);
  assert.equal(detail.run.id, runId);
  assert.equal(detail.trades.length, metrics.trades);

  const runs = await listRuns({ limit: 10 });
  assert.ok(runs.some((r) => r.id === runId));
});

/**
 * Thresholds a window can actually deliver.
 *
 * A flat 50-trade minimum is unreachable by arithmetic rather than by merit
 * on the slower bars: a year of D1 is about 260 bars, a quarter of that is
 * 65, and no strategy takes 50 trades in 65 bars. Those runs were then
 * reported as failures beside genuinely bad strategies, which hid which was
 * which.
 */
test('the trade minimum scales with the timeframe', () => {
  const { minTradesFor } = require('../src/backtest/runner');
  const thresholds = { minTrades: 50 };

  assert.equal(minTradesFor('M5', thresholds), 60);
  assert.equal(minTradesFor('H4', thresholds), 15);
  assert.equal(minTradesFor('D1', thresholds), 8);
  // An unknown timeframe falls back rather than inventing a number.
  assert.equal(minTradesFor('W1', thresholds), 50);
});

test('an operator who sets the minimum explicitly is obeyed', () => {
  const { minTradesFor } = require('../src/backtest/runner');

  assert.equal(minTradesFor('D1', { minTrades: 100, minTradesExplicit: true }), 100);
});

test('the trade-count failure names the timeframe it applied', () => {
  const { evaluateThresholds } = require('../src/backtest/runner');
  const metrics = { profitFactor: 2, maxDrawdownPct: 1, trades: 5, expectancy: 10 };

  const { passed, failures } = evaluateThresholds(
    metrics, { minProfitFactor: 1.3, maxDrawdownPct: 15, minTrades: 50 }, 'D1'
  );

  assert.equal(passed, false);
  assert.match(failures.join(' '), /only 5 trades, 8 required for D1/);
});

/**
 * Three winners and no losers is a profit factor of Infinity, and it sorted
 * straight to the top of the sweep table above a strategy with 300 trades and
 * a real edge.
 */
test('a profit factor from too few trades is unrankable, not excellent', () => {
  const { rankableProfitFactor } = require('../src/backtest/runner');

  assert.equal(rankableProfitFactor({ profitFactor: Infinity, trades: 2 }, 'D1'), 0);
  assert.equal(rankableProfitFactor({ profitFactor: 4.08, trades: 5 }, 'D1'), 0);
  // Enough trades on that timeframe, so the number is allowed to count.
  assert.equal(rankableProfitFactor({ profitFactor: 1.4, trades: 20 }, 'D1'), 1.4);
  assert.equal(rankableProfitFactor({ profitFactor: NaN, trades: 500 }, 'M5'), 0);
});

test('the default split reserves a quarter of the history untouched', () => {
  const { DEFAULT_SPLIT } = require('../src/backtest/runner');

  assert.equal(DEFAULT_SPLIT.optimise + DEFAULT_SPLIT.validate + DEFAULT_SPLIT.holdout, 1);
  assert.ok(DEFAULT_SPLIT.holdout > 0, 'promotion has nothing to rest on without it');
});
