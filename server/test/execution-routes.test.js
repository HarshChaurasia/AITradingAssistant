require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_execroutes_test';

function stubBridge() {
  return {
    positions: async () => ({ positions: [] }),
    deals: async () => ({ deals: [] }),
    account: async () => ({ balance: 10000, equity: 10050, margin_free: 9000 }),
    order: async (p) => ({ ok: true, ticket: 4242, price: 100.1, volume: p.lot, retcode: 10009, comment: 'Done' }),
    closePosition: async () => ({ ok: true, retcode: 10009 })
  };
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
       tick_value, min_lot, lot_step, max_lot, enabled, currency_profit, currency_margin, synced_at, trade_mode, market_open, market_reason, market_checked_at)
     VALUES ('XAUUSD', 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, 1, 'USD', 'USD', UTC_TIMESTAMP(), 4, 1, 'open (test fixture)', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['XAUUSD']);
  const [st] = await query("SELECT id FROM strategies WHERE name = 'trend-breakout'");

  await query(
    `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
       side, entry, sl, tp, status)
     VALUES (?, ?, 'H1', 'demo', UTC_TIMESTAMP(), '2026-02-01 00:00:00', 'BUY', 100, 99, 102, 'approved')`,
    [st.id, sym.id]
  );

  const { createExecutionRouter } = require('../src/routes/execution');
  const app = express();
  app.use(express.json());
  app.use('/api', createExecutionRouter({ bridge: stubBridge() }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());

  return { base: `http://127.0.0.1:${server.address().port}`, symbolId: sym.id };
}

test('POST /api/execution/run fills the approved signal', async (t) => {
  const { base } = await startApp(t);

  const res = await fetch(`${base}/api/execution/run`, { method: 'POST' });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.filled, 1);

  const trades = await (await fetch(`${base}/api/trades?mode=demo`)).json();
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'OPEN');
  assert.equal(Number(trades[0].broker_ticket), 4242);
  assert.equal(trades[0].broker_symbol, 'XAUUSD');
});

test('reconcile closes the trade the stub broker no longer reports', async (t) => {
  const { base } = await startApp(t);
  await fetch(`${base}/api/execution/run`, { method: 'POST' });

  const res = await fetch(`${base}/api/execution/reconcile`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).closed, 1);

  const trades = await (await fetch(`${base}/api/trades?mode=demo`)).json();
  assert.equal(trades[0].status, 'CLOSED');
});

test('GET /api/trades/stats aggregates the journal', async (t) => {
  const { base } = await startApp(t);
  await fetch(`${base}/api/execution/run`, { method: 'POST' });
  await fetch(`${base}/api/execution/reconcile`, { method: 'POST' });

  const stats = await (await fetch(`${base}/api/trades/stats?mode=demo`)).json();
  assert.equal(stats.closed, 1);
  assert.equal(typeof stats.netPnl, 'number');
  assert.equal(typeof stats.winRatePct, 'number');
});

test('GET /api/equity returns snapshots after reconciliation', async (t) => {
  const { base } = await startApp(t);
  await fetch(`${base}/api/execution/reconcile`, { method: 'POST' });

  const equity = await (await fetch(`${base}/api/equity?mode=demo`)).json();
  assert.equal(equity.length, 1);
  assert.equal(Number(equity[0].equity), 10050);
});

test('closing an unknown trade is a 404', async (t) => {
  const { base } = await startApp(t);
  const res = await fetch(`${base}/api/execution/close/999999`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('a manual close sends the ticket to the broker', async (t) => {
  const { base } = await startApp(t);
  await fetch(`${base}/api/execution/run`, { method: 'POST' });

  const [trade] = await (await fetch(`${base}/api/trades?mode=demo`)).json();
  const res = await fetch(`${base}/api/execution/close/${trade.id}`, { method: 'POST' });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});
