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
