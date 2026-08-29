require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_recon_test';

async function seeded(t) {
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
  return sym.id;
}

async function openTrade(symbolId, ticket, lot = 0.1) {
  const { query } = require('../src/db/pool');
  const r = await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, tp, opened_at,
       status, broker_ticket)
     VALUES (?, 'demo', 'BUY', ?, 100, 99, 102, UTC_TIMESTAMP(), 'OPEN', ?)`,
    [symbolId, lot, ticket]
  );
  return r.insertId;
}

function stubBridge({ positions = [], deals = [], account = null } = {}) {
  return {
    positions: async () => ({ positions }),
    deals: async () => ({ deals }),
    account: async () => account || { balance: 10000, equity: 10000, margin_free: 9000 },
    order: async () => { throw new Error('the reconciler must never place an order'); },
    closePosition: async () => { throw new Error('the reconciler must never close a position'); }
  };
}

test('a trade still open at the broker stays open', async (t) => {
  const symbolId = await seeded(t);
  await openTrade(symbolId, 111);

  const { reconcile } = require('../src/execution/reconciler');
  const { query } = require('../src/db/pool');

  const result = await reconcile({
    bridge: stubBridge({ positions: [{ ticket: 111, symbol: 'XAUUSD', side: 'BUY', volume: 0.1, profit: 3 }] }),
    mode: 'demo'
  });

  assert.equal(result.openAtBroker, 1);
  assert.equal(result.closed, 0);
  assert.equal((await query('SELECT status FROM trades WHERE broker_ticket = 111'))[0].status, 'OPEN');
});

test('a trade the broker no longer reports is closed with its realised result', async (t) => {
  const symbolId = await seeded(t);
  await openTrade(symbolId, 222);

  const { reconcile } = require('../src/execution/reconciler');
  const { query } = require('../src/db/pool');

  const result = await reconcile({
    bridge: stubBridge({
      positions: [],
      deals: [
        { ticket: 1, position_id: 222, entry: 0, profit: 0, commission: -0.7, swap: 0, price: 100 },
        { ticket: 2, position_id: 222, entry: 1, profit: 12.5, commission: -0.7, swap: -0.1, price: 101.25 }
      ]
    }),
    mode: 'demo'
  });

  assert.equal(result.closed, 1);

  const [trade] = await query('SELECT * FROM trades WHERE broker_ticket = 222');
  assert.equal(trade.status, 'CLOSED');
  assert.equal(Number(trade.close_price), 101.25);
  // Profit plus both commissions plus swap.
  assert.equal(Number(trade.pnl), 11);
  assert.ok(trade.closed_at);
});

test('a closed trade feeds the daily risk state', async (t) => {
  const symbolId = await seeded(t);
  await openTrade(symbolId, 333);

  const { reconcile } = require('../src/execution/reconciler');
  const { getState } = require('../src/risk/state');

  await reconcile({
    bridge: stubBridge({
      positions: [],
      deals: [{ ticket: 9, position_id: 333, entry: 1, profit: -20, commission: 0, swap: 0, price: 98 }]
    }),
    mode: 'demo'
  });

  const state = await getState('demo');
  assert.equal(Number(state.realized_pnl), -20);
  assert.equal(state.trades_count, 1);
  assert.equal(state.consecutive_losses, 1, 'the kill switch must see real results');
});

test('three losing closes trip the kill switch through reconciliation', async (t) => {
  const symbolId = await seeded(t);
  const { reconcile } = require('../src/execution/reconciler');
  const { getState } = require('../src/risk/state');

  for (const ticket of [401, 402, 403]) {
    await openTrade(symbolId, ticket);
    await reconcile({
      bridge: stubBridge({
        positions: [],
        deals: [{ ticket, position_id: ticket, entry: 1, profit: -5, commission: 0, swap: 0, price: 99 }]
      }),
      mode: 'demo'
    });
  }

  const state = await getState('demo');
  assert.equal(state.kill_switch, 1, 'real losses trip the switch, not simulated ones');
});

test('a broker position with no trade row is reported as an orphan, never closed', async (t) => {
  await seeded(t);

  const { reconcile } = require('../src/execution/reconciler');
  const result = await reconcile({
    bridge: stubBridge({ positions: [{ ticket: 999, symbol: 'XAUUSD', side: 'BUY', volume: 0.5, profit: 1 }] }),
    mode: 'demo'
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].ticket, 999);
  // stubBridge throws if closePosition is called, so reaching here proves it
  // was not. Closing a position the system does not understand is worse than
  // reporting it.
});

test('a close with no deal history still closes the trade', async (t) => {
  const symbolId = await seeded(t);
  await openTrade(symbolId, 555);

  const { reconcile } = require('../src/execution/reconciler');
  const { query } = require('../src/db/pool');

  const result = await reconcile({ bridge: stubBridge({ positions: [], deals: [] }), mode: 'demo' });

  assert.equal(result.closed, 1);
  const [trade] = await query('SELECT * FROM trades WHERE broker_ticket = 555');
  assert.equal(trade.status, 'CLOSED');
  assert.equal(Number(trade.pnl), 0, 'unknown result is recorded as zero, not guessed');
  assert.equal(trade.exit_reason, 'BROKER_NO_HISTORY');
});

test('reconcile records an equity snapshot', async (t) => {
  await seeded(t);
  const { reconcile } = require('../src/execution/reconciler');
  const { query } = require('../src/db/pool');

  await reconcile({
    bridge: stubBridge({ account: { balance: 100000, equity: 100120, margin_free: 99000 } }),
    mode: 'demo'
  });

  const snaps = await query('SELECT * FROM equity_snapshots');
  assert.equal(snaps.length, 1);
  assert.equal(Number(snaps[0].equity), 100120);
  assert.equal(snaps[0].mode, 'demo');
});

test('PENDING trades are left alone, not treated as closed', async (t) => {
  const symbolId = await seeded(t);
  const { query } = require('../src/db/pool');
  await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, opened_at, status)
     VALUES (?, 'demo', 'BUY', 0.1, 100, 99, UTC_TIMESTAMP(), 'PENDING')`,
    [symbolId]
  );

  const { reconcile } = require('../src/execution/reconciler');
  const result = await reconcile({ bridge: stubBridge({ positions: [] }), mode: 'demo' });

  assert.equal(result.closed, 0);
  assert.equal((await query('SELECT status FROM trades'))[0].status, 'PENDING');
});

test('reconciliation corrects a bad entry price from the broker position', async (t) => {
  const symbolId = await seeded(t);
  const { query } = require('../src/db/pool');

  // A trade written with a zero entry, as a broker reporting price 0 produces.
  await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, opened_at, status, broker_ticket)
     VALUES (?, 'demo', 'BUY', 0.7, 0, 76152, UTC_TIMESTAMP(), 'OPEN', 777)`,
    [symbolId]
  );

  const { reconcile } = require('../src/execution/reconciler');
  const result = await reconcile({
    bridge: stubBridge({
      positions: [{ ticket: 777, symbol: 'XAUUSD', side: 'BUY', volume: 0.7, price_open: 78098.84, profit: -10 }]
    }),
    mode: 'demo'
  });

  assert.equal(result.updated, 1);
  const [trade] = await query('SELECT entry_price, lot FROM trades WHERE broker_ticket = 777');
  assert.equal(Number(trade.entry_price), 78098.84, 'the broker is the source of truth for the fill');
  assert.equal(Number(trade.lot), 0.7);
});

test('reconciliation does not overwrite a good entry price with a missing one', async (t) => {
  const symbolId = await seeded(t);
  const { query } = require('../src/db/pool');

  await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, opened_at, status, broker_ticket)
     VALUES (?, 'demo', 'BUY', 0.5, 12345.67, 12000, UTC_TIMESTAMP(), 'OPEN', 778)`,
    [symbolId]
  );

  const { reconcile } = require('../src/execution/reconciler');
  await reconcile({
    bridge: stubBridge({ positions: [{ ticket: 778, symbol: 'XAUUSD', side: 'BUY', volume: 0.5 }] }),
    mode: 'demo'
  });

  const [trade] = await query('SELECT entry_price FROM trades WHERE broker_ticket = 778');
  assert.equal(Number(trade.entry_price), 12345.67, 'a position with no price_open must not zero the stored one');
});
