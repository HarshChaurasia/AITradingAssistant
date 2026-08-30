const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_migrate_test';

test('runMigrations applies every file once and is idempotent', async (t) => {
  await freshDatabase(t, SCRATCH_DB);

  // Loaded after DB_NAME is set so the pool targets the scratch database.
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');

  const firstRun = await runMigrations({ silent: true });
  assert.ok(firstRun.includes('001_core_market_data.sql'), 'first run applies 001');

  const tables = await query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?',
    [SCRATCH_DB]
  );
  const names = tables.map((r) => r.t);
  assert.ok(names.includes('symbols'), 'symbols table exists');
  assert.ok(names.includes('candles'), 'candles table exists');
  assert.ok(names.includes('migrations'), 'migrations ledger exists');

  const secondRun = await runMigrations({ silent: true });
  assert.deepEqual(secondRun, [], 'second run applies nothing');
});

test('candles rejects a duplicate (symbol, timeframe, open_time)', async (t) => {
  await freshDatabase(t, SCRATCH_DB);

  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, synced_at, trade_mode, market_open, market_reason, market_checked_at)
     VALUES ('TESTPAIR', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, UTC_TIMESTAMP(), 4, 1, 'open (test fixture)', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['TESTPAIR']);

  const insert = `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close)
                  VALUES (?, 'M1', '2026-01-01 00:00:00', 1, 2, 0.5, 1.5)`;
  await query(insert, [sym.id]);

  await assert.rejects(() => query(insert, [sym.id]), /Duplicate entry/);
});
