const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_candles_test';

async function migratedWithSymbol(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });
  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, synced_at, trade_mode, market_open, market_reason, market_checked_at)
     VALUES ('EURUSD', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, 1, UTC_TIMESTAMP(), 4, 1, 'open (test fixture)', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['EURUSD']);
  return sym.id;
}

function bridgeReturning(candles, offsetSeconds = 7200) {
  return {
    candles: async () => ({
      symbol: 'EURUSD',
      timeframe: 'H1',
      server_utc_offset_seconds: offsetSeconds,
      candles
    })
  };
}

test('syncCandles stores bars shifted from broker time to UTC', async (t) => {
  const symbolId = await migratedWithSymbol(t);
  const { syncCandles, getCandles } = require('../src/market/candles');

  // Broker clock 12:00 with a +2h offset is 10:00 UTC.
  const bridge = bridgeReturning([
    { time: Date.UTC(2026, 0, 15, 12, 0, 0) / 1000, open: 1.10, high: 1.12, low: 1.09, close: 1.11,
      tick_volume: 100, real_volume: 0, spread: 8 },
    { time: Date.UTC(2026, 0, 15, 13, 0, 0) / 1000, open: 1.11, high: 1.13, low: 1.10, close: 1.125,
      tick_volume: 120, real_volume: 0, spread: 9 }
  ]);

  const result = await syncCandles(bridge, { symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 10 });
  assert.equal(result.received, 2);
  assert.equal(result.stored, 2);

  const rows = await getCandles({ symbolId, timeframe: 'H1', limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].open_time, '2026-01-15T10:00:00.000Z');
  assert.equal(rows[1].open_time, '2026-01-15T11:00:00.000Z');
  assert.equal(rows[0].close, 1.11);
});

test('re-syncing the same bar updates it instead of failing', async (t) => {
  const symbolId = await migratedWithSymbol(t);
  const { syncCandles, getCandles } = require('../src/market/candles');
  const { query } = require('../src/db/pool');

  const barTime = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;

  await syncCandles(
    bridgeReturning([{ time: barTime, open: 1.10, high: 1.12, low: 1.09, close: 1.11, tick_volume: 100, real_volume: 0, spread: 8 }]),
    { symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 10 }
  );

  // The bar is still forming: the close moves and volume grows.
  await syncCandles(
    bridgeReturning([{ time: barTime, open: 1.10, high: 1.15, low: 1.09, close: 1.148, tick_volume: 260, real_volume: 0, spread: 8 }]),
    { symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 10 }
  );

  const count = await query('SELECT COUNT(*) AS n FROM candles');
  assert.equal(count[0].n, 1, 'the forming bar is updated, not duplicated');

  const rows = await getCandles({ symbolId, timeframe: 'H1', limit: 10 });
  assert.equal(rows[0].close, 1.148);
  assert.equal(rows[0].high, 1.15);
  assert.equal(rows[0].tick_volume, 260);
});

test('getCandles returns oldest-first and respects the limit', async (t) => {
  const symbolId = await migratedWithSymbol(t);
  const { syncCandles, getCandles } = require('../src/market/candles');

  const base = Date.UTC(2026, 0, 15, 0, 0, 0) / 1000;
  const candles = Array.from({ length: 5 }, (_, i) => ({
    time: base + i * 3600, open: 1 + i, high: 1 + i, low: 1 + i, close: 1 + i,
    tick_volume: i, real_volume: 0, spread: 1
  }));

  await syncCandles(bridgeReturning(candles, 0), { symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 10 });

  const rows = await getCandles({ symbolId, timeframe: 'H1', limit: 3 });
  assert.equal(rows.length, 3, 'limit applied');
  // The limit takes the most recent bars, then returns them oldest-first.
  assert.equal(rows[0].close, 3);
  assert.equal(rows[2].close, 5);
});

test('syncCandles handles an empty response without error', async (t) => {
  const symbolId = await migratedWithSymbol(t);
  const { syncCandles } = require('../src/market/candles');

  const result = await syncCandles(bridgeReturning([]), {
    symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 10
  });
  assert.deepEqual(result, { received: 0, stored: 0 });
});

test('syncCandles rejects an unsupported timeframe', async (t) => {
  const symbolId = await migratedWithSymbol(t);
  const { syncCandles } = require('../src/market/candles');

  await assert.rejects(
    () => syncCandles(bridgeReturning([]), { symbolId, brokerSymbol: 'EURUSD', timeframe: 'H7', count: 10 }),
    /unsupported timeframe/
  );
});

test('a large backfill is chunked and every bar is stored', async (t) => {
  const symbolId = await migratedWithSymbol(t);
  const { syncCandles, getCandles } = require('../src/market/candles');

  const base = Date.UTC(2020, 0, 1, 0, 0, 0) / 1000;
  const candles = Array.from({ length: 1200 }, (_, i) => ({
    time: base + i * 3600, open: 1, high: 1.5, low: 0.5, close: 1.2,
    tick_volume: 1, real_volume: 0, spread: 2
  }));

  const result = await syncCandles(bridgeReturning(candles, 0), {
    symbolId, brokerSymbol: 'EURUSD', timeframe: 'H1', count: 1200
  });

  assert.equal(result.received, 1200);
  assert.equal(result.stored, 1200);
  assert.equal((await getCandles({ symbolId, timeframe: 'H1', limit: 5000 })).length, 1200);
});
