require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_scantrade_test';

function stubBridge() {
  const calls = [];
  return {
    calls,
    order: async (p) => {
      calls.push(p);
      return { ok: true, ticket: 9001, price: p.sl + 10, volume: p.lot, retcode: 10009, comment: 'Done' };
    },
    positions: async () => ({ positions: [] }),
    deals: async () => ({ deals: [] }),
    closePosition: async () => ({ ok: true })
  };
}

async function addSymbol({ name, enabled }) {
  const { query } = require('../src/db/pool');
  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, watched, currency_profit,
       currency_margin, synced_at)
     VALUES (?, 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, ?, 1, 'USD', 'USD', UTC_TIMESTAMP())`,
    [name, enabled]
  );
  const [row] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', [name]);
  return row.id;
}

async function addCandles(symbolId, { breakout }) {
  const { query } = require('../src/db/pool');
  const rows = [];
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);

  for (let i = 0; i < 300; i += 1) {
    const close = 100 + i * 0.02 + Math.sin(i / 9) * 1.2;
    rows.push([symbolId, 'H1',
      new Date(start + i * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      close - 0.02, close + 0.05, close - 0.05, close, 100, 0, 8]);
  }
  if (breakout) {
    const base = 100 + 299 * 0.02 + Math.sin(299 / 9) * 1.2;
    const high = base + 6;
    rows.push([symbolId, 'H1', new Date(start + 300 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      base, high + 0.1, base - 0.05, high, 100, 0, 8]);
    rows.push([symbolId, 'H1', new Date(start + 301 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      high, high + 0.1, high - 0.1, high, 100, 0, 8]);
  }

  await query(
    `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close,
       tick_volume, real_volume, spread) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
    rows.flat()
  );
}

async function startApp(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { registerStrategies } = require('../src/strategies/registry');
  await runMigrations({ silent: true });
  await registerStrategies();

  const bridge = stubBridge();
  const { createScannerRouter } = require('../src/routes/scanner');
  const app = express();
  app.use(express.json());
  app.use('/api', createScannerRouter({ bridge }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());

  return { base: `http://127.0.0.1:${server.address().port}`, bridge };
}

function trade(base, body) {
  return fetch(`${base}/api/scanner/trade`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('a firing setup on an enabled symbol is traded through the normal path', async (t) => {
  const { base, bridge } = await startApp(t);
  const symbolId = await addSymbol({ name: 'GOUSD', enabled: 1 });
  await addCandles(symbolId, { breakout: true });

  const res = await trade(base, { symbolId, strategy: 'trend-breakout', timeframe: 'H1', balance: 100000 });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.status, 'filled');
  assert.equal(body.ticket, 9001);

  assert.equal(bridge.calls.length, 1);
  assert.ok(bridge.calls[0].sl > 0, 'a manual trade still carries a stop loss');

  const { query } = require('../src/db/pool');
  const [signal] = await query('SELECT * FROM signals WHERE id = ?', [body.signalId]);
  assert.equal(signal.status, 'executed');
  assert.equal(signal.decided_by, 'user');
  assert.match(signal.reason, /^manual:/);
});

test('a watched but not enabled symbol is refused', async (t) => {
  const { base, bridge } = await startApp(t);
  const symbolId = await addSymbol({ name: 'LOOKUSD', enabled: 0 });
  await addCandles(symbolId, { breakout: true });

  const res = await trade(base, { symbolId, strategy: 'trend-breakout', timeframe: 'H1', balance: 100000 });

  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'symbol_not_enabled');
  assert.equal(bridge.calls.length, 0, 'watching is not permission to trade');
});

test('a setup that has gone is refused rather than invented', async (t) => {
  const { base, bridge } = await startApp(t);
  const symbolId = await addSymbol({ name: 'QUIETUSD', enabled: 1 });
  await addCandles(symbolId, { breakout: false });

  const res = await trade(base, { symbolId, strategy: 'trend-breakout', timeframe: 'H1', balance: 100000 });

  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'setup_gone');
  assert.equal(bridge.calls.length, 0);
});

test('the risk engine still applies - a tripped kill switch blocks a manual trade', async (t) => {
  const { base, bridge } = await startApp(t);
  const symbolId = await addSymbol({ name: 'HALTUSD', enabled: 1 });
  await addCandles(symbolId, { breakout: true });

  const { tripKillSwitch } = require('../src/risk/state');
  await tripKillSwitch({ mode: 'demo', reason: 'manual trade test halt' });

  const res = await trade(base, { symbolId, strategy: 'trend-breakout', timeframe: 'H1', balance: 100000 });

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.status, 'skipped');
  assert.match(body.reason, /kill switch/i);
  assert.equal(bridge.calls.length, 0, 'a click cannot override a risk gate');
});

test('the caller cannot dictate side, size or stop', async (t) => {
  const { base, bridge } = await startApp(t);
  const symbolId = await addSymbol({ name: 'FIXEDUSD', enabled: 1 });
  await addCandles(symbolId, { breakout: true });

  // Every one of these should be ignored: the levels come from the strategy.
  const res = await trade(base, {
    symbolId, strategy: 'trend-breakout', timeframe: 'H1', balance: 100000,
    side: 'SELL', lot: 99, sl: 1, entry: 1, tp: 1
  });
  assert.equal(res.status, 200);

  const sent = bridge.calls[0];
  assert.equal(sent.side, 'BUY', 'the strategy decided the side, not the request');
  assert.notEqual(sent.lot, 99, 'the risk engine decided the size');
  assert.ok(sent.sl > 100, 'the stop came from the strategy, not the request');
});

test('an unknown strategy is a 400', async (t) => {
  const { base } = await startApp(t);
  const symbolId = await addSymbol({ name: 'ANYUSD', enabled: 1 });
  await addCandles(symbolId, { breakout: true });

  const res = await trade(base, { symbolId, strategy: 'not-a-strategy', timeframe: 'H1' });
  assert.equal(res.status, 400);
});
