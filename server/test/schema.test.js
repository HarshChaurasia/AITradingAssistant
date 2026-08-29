const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_schema_test';

const EXPECTED = [
  'symbols', 'candles', 'strategies', 'signals', 'trades',
  'backtest_runs', 'backtest_trades', 'risk_state', 'news_events',
  'equity_snapshots', 'audit_log', 'users', 'settings', 'migrations'
];

test('full schema creates every expected table', async (t) => {
  await freshDatabase(t, SCRATCH_DB);

  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  const rows = await query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?',
    [SCRATCH_DB]
  );
  const found = rows.map((r) => r.t);
  for (const table of EXPECTED) {
    assert.ok(found.includes(table), `missing table: ${table}`);
  }
});

test('trades.mode only accepts backtest, demo or live', async (t) => {
  await freshDatabase(t, SCRATCH_DB);

  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  // Insert a real symbol first, so the rejection below is caused by the mode
  // enum and not incidentally by the foreign key.
  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, synced_at)
     VALUES ('TESTPAIR', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['TESTPAIR']);

  const insert = (mode) => query(
    `INSERT INTO trades (mode, symbol_id, side, lot, entry_price, sl, opened_at, status)
     VALUES (?, ?, 'BUY', 0.01, 1.0, 0.9, UTC_TIMESTAMP(), 'OPEN')`,
    [mode, sym.id]
  );

  await assert.rejects(() => insert('production'), /Data truncated|Incorrect/i);
  await insert('demo'); // a valid mode is accepted
});

test('default risk settings are seeded', async (t) => {
  await freshDatabase(t, SCRATCH_DB);

  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  const rows = await query('SELECT setting_key, setting_value FROM settings');
  const byKey = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));

  assert.ok(byKey.risk, 'risk settings seeded');
  assert.equal(byKey.risk.riskPctPerTrade, 1.0);
  assert.equal(byKey.risk.dailyLossCapPct, 5.0);
  assert.equal(byKey.risk.maxConcurrentPositions, 2);
  assert.equal(byKey.risk.consecutiveLossLimit, 3);

  assert.ok(byKey.backtestThresholds, 'backtest thresholds seeded');
  assert.equal(byKey.backtestThresholds.minProfitFactor, 1.3);
});
