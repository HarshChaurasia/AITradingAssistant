require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_riskroutes_test';

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
     VALUES (?, ?, 'H1', 'live', UTC_TIMESTAMP(), '2026-02-01 00:00:00', 'BUY', 100, 99, 102, 'new')`,
    [st.id, sym.id]
  );

  const { createSignalRouter } = require('../src/routes/signals');
  const { createRiskRouter } = require('../src/routes/risk');
  const scheduler = { isRunning: () => false, lastRun: () => null, runOnce: async () => ({ ok: true }) };

  const app = express();
  app.use(express.json());
  app.use('/api', createSignalRouter());
  app.use('/api', createRiskRouter({ scheduler }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());

  return { base: `http://127.0.0.1:${server.address().port}`, symbolId: sym.id };
}

test('GET /api/signals filters by mode and status', async (t) => {
  const { base } = await startApp(t);

  const all = await (await fetch(`${base}/api/signals`)).json();
  assert.equal(all.length, 1);
  assert.equal(all[0].broker_symbol, 'XAUUSD');
  assert.equal(all[0].strategy_name, 'trend-breakout');

  const demo = await (await fetch(`${base}/api/signals?mode=demo`)).json();
  assert.equal(demo.length, 0);
});

test('approve moves a signal out of the queue', async (t) => {
  const { base } = await startApp(t);
  const [signal] = await (await fetch(`${base}/api/signals?status=new`)).json();

  const res = await fetch(`${base}/api/signals/${signal.id}/approve`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'approved');

  assert.equal((await (await fetch(`${base}/api/signals?status=new`)).json()).length, 0);
});

test('reject records the operator reason', async (t) => {
  const { base } = await startApp(t);
  const [signal] = await (await fetch(`${base}/api/signals?status=new`)).json();

  const res = await fetch(`${base}/api/signals/${signal.id}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'spread too wide' })
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.status, 'rejected');
  assert.match(JSON.stringify(body.decision), /spread too wide/);
});

test('approving an unknown signal is a 404', async (t) => {
  const { base } = await startApp(t);
  const res = await fetch(`${base}/api/signals/999999/approve`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('risk settings round-trip through a partial patch', async (t) => {
  const { base } = await startApp(t);

  const before = await (await fetch(`${base}/api/risk/settings`)).json();
  assert.equal(before.riskPctPerTrade, 1.0);

  const res = await fetch(`${base}/api/risk/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ riskPctPerTrade: 0.5 })
  });
  assert.equal(res.status, 200);

  const after = await (await fetch(`${base}/api/risk/settings`)).json();
  assert.equal(after.riskPctPerTrade, 0.5);
  assert.equal(after.dailyLossCapPct, 5.0, 'other settings are untouched');
});

test('the kill switch can be tripped and reset through the API', async (t) => {
  const { base } = await startApp(t);

  const on = await (await fetch(`${base}/api/risk/kill-switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'demo', on: true, reason: 'operator halt' })
  })).json();
  assert.equal(on.kill_switch, 1);
  assert.equal(on.kill_switch_reason, 'operator halt');

  const state = await (await fetch(`${base}/api/risk/state?mode=demo`)).json();
  assert.equal(state.kill_switch, 1);

  const off = await (await fetch(`${base}/api/risk/kill-switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'demo', on: false })
  })).json();
  assert.equal(off.kill_switch, 0);
});

test('POST /api/risk/assess dry-runs the gates without storing anything', async (t) => {
  const { base, symbolId } = await startApp(t);

  const res = await fetch(`${base}/api/risk/assess`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      symbolId, mode: 'demo', balance: 10000,
      signal: { side: 'BUY', entry: 100, sl: 99, tp: 102 }
    })
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.allowed, true, body.denialReasons?.join('; '));
  assert.ok(body.lot > 0);
  assert.ok(body.checks.length >= 7);

  const signals = await (await fetch(`${base}/api/signals`)).json();
  assert.equal(signals.length, 1, 'a dry run stores nothing');
});

test('assess reports the denial when the account is too small', async (t) => {
  const { base, symbolId } = await startApp(t);

  const body = await (await fetch(`${base}/api/risk/assess`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      symbolId, mode: 'demo', balance: 100,
      signal: { side: 'BUY', entry: 100, sl: 90, tp: 120 }
    })
  })).json();

  assert.equal(body.allowed, false);
  assert.ok(body.denialReasons.some((r) => /below the broker minimum/i.test(r)));
});

test('GET /api/scheduler reports state', async (t) => {
  const { base } = await startApp(t);
  const body = await (await fetch(`${base}/api/scheduler`)).json();
  assert.equal(body.running, false);
});
