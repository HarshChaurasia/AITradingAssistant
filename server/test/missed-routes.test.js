require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_missed_test';

/**
 * A price series that walks upward in a straight line.
 *
 * Deliberately monotonic: a rejected BUY at the bottom of it must grade as
 * 'costly', and a rejected SELL must grade as 'correct'. Anything noisier and
 * the assertions would be measuring the fixture rather than the grader.
 */
function risingCandles(count, start = 100, step = 1) {
  return Array.from({ length: count }, (_, i) => {
    const open = start + i * step;
    return {
      open_time: new Date(Date.UTC(2026, 2, 1, i)).toISOString().slice(0, 19).replace('T', ' '),
      open,
      high: open + step,
      low: open - step * 0.2,
      close: open + step * 0.8
    };
  });
}

async function startApp(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await runMigrations({ silent: true });
  await registerStrategies();

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, watched, synced_at, trade_mode, market_open, market_reason, market_checked_at)
     VALUES ('BTCUSD', 2, 0.01, 1, 0.01, 1, 0.01, 0.01, 100, 1, 1, UTC_TIMESTAMP(), 4, 1, 'open (test fixture)', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['BTCUSD']);
  const [st] = await query("SELECT id FROM strategies WHERE name = 'trend-breakout'");

  const candles = risingCandles(40);
  for (const c of candles) {
    await query(
      `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close, tick_volume)
       VALUES (?, 'H4', ?, ?, ?, ?, ?, 100)`,
      [sym.id, c.open_time, c.open, c.high, c.low, c.close]
    );
  }

  const { createSignalRouter } = require('../src/routes/signals');
  const app = express();
  app.use(express.json());
  app.use('/api', createSignalRouter());
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    symbolId: sym.id,
    strategyId: st.id,
    candles
  };
}

async function rejectedSignal({ strategyId, symbolId, side, entry, sl, tp, barIndex, reason }) {
  const { query } = require('../src/db/pool');
  const barTime = new Date(Date.UTC(2026, 2, 1, barIndex)).toISOString().slice(0, 19).replace('T', ' ');
  await query(
    `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
       side, entry, sl, tp, reason, decision, status)
     VALUES (?, ?, 'H4', 'demo', UTC_TIMESTAMP(), ?, ?, ?, ?, ?, 'setup fired',
             CAST(? AS JSON), 'rejected')`,
    [strategyId, symbolId, barTime, side, entry, sl, tp,
      JSON.stringify({ allowed: false, denialReasons: [reason] })]
  );
}

test('a refused BUY that the market then rewarded is graded costly', async (t) => {
  const { base, symbolId, strategyId } = await startApp(t);
  await rejectedSignal({
    strategyId, symbolId, side: 'BUY', entry: 105, sl: 103, tp: 109, barIndex: 5,
    reason: 'lot below the broker minimum'
  });

  await fetch(`${base}/api/missed/evaluate`, { method: 'POST' });
  const body = await (await fetch(`${base}/api/missed?mode=demo`)).json();

  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].outcome, 'tp');
  assert.equal(body.rows[0].verdict, 'costly');
  assert.equal(body.summary.costly, 1);
  assert.equal(body.summary.byReason[0].reason, 'lot below the broker minimum');
});

test('a refused SELL into a rising market is graded correct', async (t) => {
  const { base, symbolId, strategyId } = await startApp(t);
  await rejectedSignal({
    strategyId, symbolId, side: 'SELL', entry: 105, sl: 107, tp: 101, barIndex: 5,
    reason: 'kill switch is on'
  });

  await fetch(`${base}/api/missed/evaluate`, { method: 'POST' });
  const body = await (await fetch(`${base}/api/missed?mode=demo`)).json();

  assert.equal(body.rows[0].verdict, 'correct');
  assert.equal(body.summary.accuracyPct, 100);
});

test('a signal on the newest bar is left undecided rather than guessed at', async (t) => {
  const { base, symbolId, strategyId } = await startApp(t);
  // Bar 39 is the last one stored, so nothing has closed after it.
  await rejectedSignal({
    strategyId, symbolId, side: 'BUY', entry: 139, sl: 137, tp: 143, barIndex: 39,
    reason: 'daily loss cap reached'
  });

  await fetch(`${base}/api/missed/evaluate`, { method: 'POST' });
  const body = await (await fetch(`${base}/api/missed?mode=demo`)).json();

  assert.equal(body.rows[0].outcome, 'no_data');
  assert.equal(body.rows[0].verdict, 'undecided');
  assert.equal(body.summary.accuracyPct, null, 'no accuracy is claimed from zero decided cases');
});

test('re-grading is idempotent rather than duplicating rows', async (t) => {
  const { base, symbolId, strategyId } = await startApp(t);
  await rejectedSignal({
    strategyId, symbolId, side: 'BUY', entry: 105, sl: 103, tp: 109, barIndex: 5,
    reason: 'kill switch is on'
  });

  await fetch(`${base}/api/missed/evaluate`, { method: 'POST' });
  await fetch(`${base}/api/missed/evaluate`, { method: 'POST' });

  const body = await (await fetch(`${base}/api/missed?mode=demo`)).json();
  assert.equal(body.rows.length, 1, 'one verdict per signal, however often it is re-run');
});

test('an approved signal is never graded as a miss', async (t) => {
  const { base, symbolId, strategyId } = await startApp(t);
  const { query } = require('../src/db/pool');

  // Only refusals belong here. Grading a trade the system actually took would
  // double-count it against the real P&L.
  await query(
    `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
       side, entry, sl, tp, status)
     VALUES (?, ?, 'H4', 'demo', UTC_TIMESTAMP(), '2026-03-01 05:00:00', 'BUY', 105, 103, 109, 'approved')`,
    [strategyId, symbolId]
  );

  await fetch(`${base}/api/missed/evaluate`, { method: 'POST' });
  const body = await (await fetch(`${base}/api/missed?mode=demo`)).json();

  assert.equal(body.rows.length, 0);
});

test('the verdict filter narrows the list', async (t) => {
  const { base, symbolId, strategyId } = await startApp(t);
  await rejectedSignal({
    strategyId, symbolId, side: 'BUY', entry: 105, sl: 103, tp: 109, barIndex: 5, reason: 'a'
  });
  await rejectedSignal({
    strategyId, symbolId, side: 'SELL', entry: 110, sl: 112, tp: 106, barIndex: 10, reason: 'b'
  });

  await fetch(`${base}/api/missed/evaluate`, { method: 'POST' });

  const costly = await (await fetch(`${base}/api/missed?mode=demo&verdict=costly`)).json();
  assert.equal(costly.rows.length, 1);
  assert.equal(costly.rows[0].side, 'BUY');

  const correct = await (await fetch(`${base}/api/missed?mode=demo&verdict=correct`)).json();
  assert.equal(correct.rows.length, 1);
  assert.equal(correct.rows[0].side, 'SELL');
});
