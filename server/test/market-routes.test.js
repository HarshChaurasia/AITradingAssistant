const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_routes_test';

const FAKE_BRIDGE = {
  health: async () => ({ ok: true, account_login: 50045322, server_utc_offset_seconds: 7200 }),
  symbols: async () => ({
    symbols: [
      { name: 'EURUSD', description: 'Euro', digits: 5, point: 0.00001, contract_size: 100000,
        tick_size: 0.00001, tick_value: 1, min_lot: 0.01, lot_step: 0.01, max_lot: 100,
        spread: 8, currency_profit: 'USD', currency_margin: 'EUR' }
    ]
  }),
  candles: async () => ({
    server_utc_offset_seconds: 7200,
    candles: [
      { time: Date.UTC(2026, 0, 15, 12, 0, 0) / 1000, open: 1.1, high: 1.2, low: 1.0,
        close: 1.15, tick_volume: 10, real_volume: 0, spread: 8 }
    ]
  })
};

async function startApp(t, bridge) {
  await freshDatabase(t, SCRATCH_DB);

  const { runMigrations } = require('../src/db/migrate');
  await runMigrations({ silent: true });

  const { createMarketRouter } = require('../src/routes/market');
  const app = express();
  app.use(express.json());
  app.use('/api', createMarketRouter({ bridge }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());

  return `http://127.0.0.1:${server.address().port}`;
}

test('POST /api/symbols/sync stores symbols and GET returns them', async (t) => {
  const base = await startApp(t, FAKE_BRIDGE);

  const sync = await fetch(`${base}/api/symbols/sync`, { method: 'POST' });
  assert.equal(sync.status, 200);
  assert.equal((await sync.json()).total, 1);

  const list = await (await fetch(`${base}/api/symbols`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].broker_symbol, 'EURUSD');
});

test('PATCH /api/symbols/:id toggles enabled and enabledOnly filters', async (t) => {
  const base = await startApp(t, FAKE_BRIDGE);
  await fetch(`${base}/api/symbols/sync`, { method: 'POST' });

  const [symbol] = await (await fetch(`${base}/api/symbols`)).json();
  assert.equal((await (await fetch(`${base}/api/symbols?enabledOnly=1`)).json()).length, 0);

  const patch = await fetch(`${base}/api/symbols/${symbol.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(patch.status, 200);

  assert.equal((await (await fetch(`${base}/api/symbols?enabledOnly=1`)).json()).length, 1);
});

test('PATCH /api/symbols/:id rejects a body without a boolean enabled', async (t) => {
  const base = await startApp(t, FAKE_BRIDGE);
  await fetch(`${base}/api/symbols/sync`, { method: 'POST' });
  const [symbol] = await (await fetch(`${base}/api/symbols`)).json();

  const res = await fetch(`${base}/api/symbols/${symbol.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes' })
  });
  assert.equal(res.status, 400);
});

test('candle sync then fetch returns UTC-shifted bars', async (t) => {
  const base = await startApp(t, FAKE_BRIDGE);
  await fetch(`${base}/api/symbols/sync`, { method: 'POST' });
  const [symbol] = await (await fetch(`${base}/api/symbols`)).json();

  const sync = await fetch(`${base}/api/candles/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbolId: symbol.id, timeframe: 'H1', count: 10 })
  });
  assert.equal(sync.status, 200);

  const candles = await (await fetch(`${base}/api/candles?symbolId=${symbol.id}&timeframe=H1`)).json();
  assert.equal(candles.length, 1);
  assert.equal(candles[0].open_time, '2026-01-15T10:00:00.000Z');
});

test('an unknown timeframe is rejected with 400', async (t) => {
  const base = await startApp(t, FAKE_BRIDGE);
  const res = await fetch(`${base}/api/candles?symbolId=1&timeframe=H7`);
  assert.equal(res.status, 400);
});

test('syncing candles for an unknown symbol returns 404', async (t) => {
  const base = await startApp(t, FAKE_BRIDGE);
  const res = await fetch(`${base}/api/candles/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbolId: 9999, timeframe: 'H1' })
  });
  assert.equal(res.status, 404);
});

test('bridge health reports unreachable instead of throwing', async (t) => {
  const brokenBridge = {
    ...FAKE_BRIDGE,
    health: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8000'); }
  };
  const base = await startApp(t, brokenBridge);

  const res = await fetch(`${base}/api/bridge/health`);
  assert.equal(res.status, 200, 'the dashboard must render even with the bridge down');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /ECONNREFUSED/);
});
