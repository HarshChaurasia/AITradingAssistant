require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_exec_test';

async function seeded(t) {
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

  return { symbolId: sym.id, strategyId: st.id };
}

async function insertSignal({ strategyId, symbolId, status = 'approved', sl = 99 }) {
  const { query } = require('../src/db/pool');
  const result = await query(
    `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
       side, entry, sl, tp, lot, status)
     VALUES (?, ?, 'H1', 'demo', UTC_TIMESTAMP(), ?, 'BUY', 100, ?, 102, 0.5, ?)`,
    [strategyId, symbolId, `2026-02-01 0${Math.floor(Math.random() * 9)}:00:00`, sl, status]
  );
  return result.insertId;
}

function stubBridge({ ok = true, ticket = 555, price = 100.05, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    order: async (payload) => {
      calls.push(payload);
      if (fail) throw Object.assign(new Error(fail), { status: 400 });
      return {
        ok, ticket, price, volume: payload.lot,
        retcode: ok ? 10009 : 10016, comment: ok ? 'Done' : 'Invalid stops'
      };
    },
    positions: async () => ({ positions: [] }),
    deals: async () => ({ deals: [] }),
    closePosition: async () => ({ ok: true, retcode: 10009 })
  };
}

test('an approved signal is sent and recorded as OPEN', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  const signalId = await insertSignal({ strategyId, symbolId });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');
  const bridge = stubBridge();

  const result = await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(result.attempted, 1);
  assert.equal(result.filled, 1, 'the order must be accepted');

  const trades = await query('SELECT * FROM trades');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'OPEN');
  assert.equal(Number(trades[0].broker_ticket), 555);
  assert.equal(Number(trades[0].entry_price), 100.05);
  assert.equal(Number(trades[0].signal_id), signalId);

  const [signal] = await query('SELECT status FROM signals WHERE id = ?', [signalId]);
  assert.equal(signal.status, 'executed');
});

test('every order carries the stop loss from the signal', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId, sl: 98.5 });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const bridge = stubBridge();

  await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(bridge.calls.length, 1);
  assert.equal(Number(bridge.calls[0].sl), 98.5);
  assert.ok(bridge.calls[0].lot > 0);
});

test('the risk engine runs again at send time, not just at approval', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId });

  // The signal was approved earlier; the switch trips before it is sent.
  const { tripKillSwitch } = require('../src/risk/state');
  await tripKillSwitch({ mode: 'demo', reason: 'tripped after approval' });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');
  const bridge = stubBridge();

  const result = await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(result.skipped, 1);
  assert.equal(result.filled, 0);
  assert.equal(bridge.calls.length, 0, 'no order may be sent once the switch is on');
  assert.equal((await query('SELECT COUNT(*) AS n FROM trades'))[0].n, 0);
});

test('a signal with no usable stop loss is never sent', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  // Stop equal to entry: a zero-width stop, which sizing must refuse.
  await insertSignal({ strategyId, symbolId, sl: 100 });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const bridge = stubBridge();

  const outcome = await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });
  assert.equal(outcome.skipped, 1);
  assert.equal(bridge.calls.length, 0, 'a zero-width stop must not reach the broker');
});

test('a rejected order leaves a CANCELLED trade with the reason', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');
  const bridge = stubBridge({ fail: 'bridge /order returned 400: Invalid stops' });

  const result = await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(result.failed, 1);
  const trades = await query('SELECT * FROM trades');
  assert.equal(trades.length, 1, 'the pre-send row survives so nothing is invisible');
  assert.equal(trades[0].status, 'CANCELLED');
  assert.match(trades[0].broker_comment, /Invalid stops/);
});

test('only approved signals are executed', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId, status: 'new' });
  await insertSignal({ strategyId, symbolId, status: 'rejected' });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const bridge = stubBridge();

  const result = await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });
  assert.equal(result.attempted, 0);
  assert.equal(bridge.calls.length, 0);
});

test('a signal is never executed twice', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');
  const bridge = stubBridge();

  await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });
  await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(bridge.calls.length, 1, 'the second pass finds nothing approved');
  assert.equal((await query('SELECT COUNT(*) AS n FROM trades'))[0].n, 1);
});

test('the trade row is written before the order is sent', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId });

  const { query } = require('../src/db/pool');
  let rowsAtSendTime = null;

  const bridge = {
    order: async (payload) => {
      // Observe the database from inside the send.
      rowsAtSendTime = await query('SELECT status FROM trades');
      return { ok: true, ticket: 777, price: 100.05, volume: payload.lot, retcode: 10009, comment: 'Done' };
    },
    positions: async () => ({ positions: [] }),
    deals: async () => ({ deals: [] }),
    closePosition: async () => ({ ok: true })
  };

  const { executeApprovedSignals } = require('../src/execution/manager');
  await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  assert.equal(rowsAtSendTime.length, 1, 'a row exists before the broker is called');
  assert.equal(rowsAtSendTime[0].status, 'PENDING');
});

test('a broker that reports a zero fill price does not store a zero entry', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  await insertSignal({ strategyId, symbolId });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');

  // Measured against a real broker: order_send returns price 0 rather than the
  // fill price. Stored naively, that zero poisons every P&L figure derived
  // from the journal.
  const bridge = {
    order: async (p) => ({ ok: true, ticket: 888, price: 0, volume: 0, retcode: 10009, comment: 'Request executed' }),
    positions: async () => ({ positions: [] }),
    deals: async () => ({ deals: [] }),
    closePosition: async () => ({ ok: true })
  };

  await executeApprovedSignals({ bridge, mode: 'demo', balance: 10000 });

  const [trade] = await query('SELECT entry_price, lot FROM trades');
  assert.ok(Number(trade.entry_price) > 0, 'entry price must never be stored as zero');
  assert.ok(Number(trade.lot) > 0, 'lot must never be stored as zero');
});
