const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_symbols_test';

const FAKE_SYMBOLS = {
  symbols: [
    { name: 'EURUSD', description: 'Euro vs US Dollar', digits: 5, point: 0.00001,
      contract_size: 100000, tick_size: 0.00001, tick_value: 1.0, min_lot: 0.01,
      lot_step: 0.01, max_lot: 100, spread: 8, currency_profit: 'USD', currency_margin: 'EUR' },
    { name: 'XAUUSD', description: 'Gold vs US Dollar', digits: 2, point: 0.01,
      contract_size: 100, tick_size: 0.01, tick_value: 1.0, min_lot: 0.01,
      lot_step: 0.01, max_lot: 50, spread: 25, currency_profit: 'USD', currency_margin: 'USD' }
  ]
};

async function migrated(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  await runMigrations({ silent: true });
}

test('syncSymbols inserts symbols and re-running updates rather than duplicates', async (t) => {
  await migrated(t);
  const { syncSymbols, listSymbols } = require('../src/market/symbols');
  const { query } = require('../src/db/pool');

  const bridge = { symbols: async () => FAKE_SYMBOLS };

  const first = await syncSymbols(bridge);
  assert.equal(first.total, 2);
  assert.equal(first.inserted, 2);

  const rows = await listSymbols({});
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.broker_symbol === 'XAUUSD').contract_size, 100);

  // Symbols default to disabled; the operator opts in.
  assert.equal(rows.every((r) => r.enabled === 0), true);

  // Broker widens the gold spread; a re-sync must update in place.
  const widened = JSON.parse(JSON.stringify(FAKE_SYMBOLS));
  widened.symbols[1].spread = 40;
  const second = await syncSymbols({ symbols: async () => widened });

  assert.equal(second.inserted, 0);
  assert.equal(second.total, 2);

  const after = await query('SELECT COUNT(*) AS n FROM symbols');
  assert.equal(after[0].n, 2, 'no duplicate rows');

  const gold = (await listSymbols({})).find((r) => r.broker_symbol === 'XAUUSD');
  assert.equal(gold.spread_points, 40);
});

test('syncSymbols preserves the enabled flag across a re-sync', async (t) => {
  await migrated(t);
  const { syncSymbols, listSymbols } = require('../src/market/symbols');
  const { query } = require('../src/db/pool');

  const bridge = { symbols: async () => FAKE_SYMBOLS };
  await syncSymbols(bridge);
  await query('UPDATE symbols SET enabled = 1 WHERE broker_symbol = ?', ['EURUSD']);

  await syncSymbols(bridge);

  const enabled = await listSymbols({ enabledOnly: true });
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].broker_symbol, 'EURUSD');
});

test('setSymbolEnabled toggles a single symbol', async (t) => {
  await migrated(t);
  const { syncSymbols, listSymbols, setSymbolEnabled } = require('../src/market/symbols');

  await syncSymbols({ symbols: async () => FAKE_SYMBOLS });
  const [first] = await listSymbols({});

  await setSymbolEnabled(first.id, true);
  assert.equal((await listSymbols({ enabledOnly: true })).length, 1);

  await setSymbolEnabled(first.id, false);
  assert.equal((await listSymbols({ enabledOnly: true })).length, 0);
});
