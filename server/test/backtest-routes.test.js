const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_btroutes_test';

async function startApp(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, synced_at)
     VALUES ('XAUUSD', 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, 1, UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['XAUUSD']);

  const rows = [];
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < 600; i += 1) {
    const close = 100 + i * 0.02 + Math.sin(i / 9) * 1.2;
    rows.push([
      sym.id, 'H1',
      new Date(start + i * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      close - 0.02, close + 0.05, close - 0.05, close, 100, 0, 8
    ]);
  }
  await query(
    `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close,
       tick_volume, real_volume, spread) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
    rows.flat()
  );

  const { createBacktestRouter } = require('../src/routes/backtests');
  const app = express();
  app.use(express.json());
  app.use('/api', createBacktestRouter());
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());

  return { base: `http://127.0.0.1:${server.address().port}`, symbolId: sym.id };
}

test('GET /api/strategies lists the shipped strategies', async (t) => {
  const { base } = await startApp(t);
  const rows = await (await fetch(`${base}/api/strategies`)).json();

  // Asserted against the registry rather than a hardcoded list, so adding a
  // strategy does not break an unrelated route test.
  const { strategies } = require('../src/strategies/registry');
  const names = rows.map((r) => r.name).sort();
  assert.deepEqual(names, strategies.map((s) => s.name).sort());
  assert.ok(rows.every((r) => ['draft', 'backtested', 'demo', 'live'].includes(r.status)));
});

test('POST /api/backtests runs and stores a backtest', async (t) => {
  const { base, symbolId } = await startApp(t);

  const res = await fetch(`${base}/api/backtests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      strategyName: 'trend-breakout',
      symbolId,
      timeframe: 'H1',
      options: { startingBalance: 10000, riskPctPerTrade: 1, spreadPrice: 0.0002 }
    })
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(body.runId > 0);
  assert.ok(body.metrics.trades > 0);
  assert.ok(body.walkForward.outOfSample);
  assert.equal(typeof body.passed, 'boolean');
});

test('GET /api/backtests/:id returns the run with its trades', async (t) => {
  const { base, symbolId } = await startApp(t);

  const created = await (await fetch(`${base}/api/backtests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategyName: 'trend-breakout', symbolId, timeframe: 'H1' })
  })).json();

  const detail = await (await fetch(`${base}/api/backtests/${created.runId}`)).json();
  assert.equal(detail.run.id, created.runId);
  assert.equal(detail.run.strategy_name, 'trend-breakout');
  assert.equal(detail.trades.length, created.metrics.trades);
});

test('a missing strategyName is rejected with 400', async (t) => {
  const { base, symbolId } = await startApp(t);
  const res = await fetch(`${base}/api/backtests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbolId })
  });
  assert.equal(res.status, 400);
});

test('an unknown strategy is rejected with 400, not 500', async (t) => {
  const { base, symbolId } = await startApp(t);
  const res = await fetch(`${base}/api/backtests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategyName: 'nope', symbolId })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown strategy/);
});

test('GET /api/backtests/:id is 404 for a run that does not exist', async (t) => {
  const { base } = await startApp(t);
  const res = await fetch(`${base}/api/backtests/999999`);
  assert.equal(res.status, 404);
});
