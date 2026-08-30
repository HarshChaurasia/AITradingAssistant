require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_execdedupe_test';

const OPEN_MARKET = "UTC_TIMESTAMP(), 4, 1, 'open (test fixture)', UTC_TIMESTAMP()";

async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await runMigrations({ silent: true });
  await registerStrategies();

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, watched, currency_profit, currency_margin,
       synced_at, trade_mode, market_open, market_reason, market_checked_at)
     VALUES ('XAUUSD', 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, 1, 1, 'USD', 'USD', ${OPEN_MARKET})`
  );
  const [symbol] = await query('SELECT * FROM symbols WHERE broker_symbol = ?', ['XAUUSD']);
  const [strategy] = await query("SELECT id FROM strategies WHERE name = 'trend-breakout'");
  return { symbol, strategyId: strategy.id };
}

let barCounter = 0;

async function approvedSignal({ strategyId, symbol }) {
  const { query } = require('../src/db/pool');
  barCounter += 1;
  const barTime = `2026-03-01 ${String(barCounter).padStart(2, '0')}:00:00`;

  const inserted = await query(
    `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
       side, entry, sl, tp, status)
     VALUES (?, ?, 'H1', 'demo', UTC_TIMESTAMP(), ?, 'BUY', 100, 99, 102, 'approved')`,
    [strategyId, symbol.id, barTime]
  );
  const rows = await query(
    `SELECT sig.*, st.status AS strategy_status FROM signals sig
       JOIN strategies st ON st.id = sig.strategy_id WHERE sig.id = ?`,
    [inserted.insertId]
  );
  return rows[0];
}

function fillingBroker(tickets = [900001, 900002, 900003]) {
  const sent = [];
  let i = 0;
  return {
    sent,
    order: async (request) => {
      sent.push(request);
      return { ok: true, ticket: tickets[Math.min(i++, tickets.length - 1)], price: 100, volume: request.lot, retcode: 10009 };
    },
    positions: async () => ({ positions: [] })
  };
}

test('a signal can only be claimed once', async (t) => {
  const { symbol, strategyId } = await seeded(t);
  const signal = await approvedSignal({ strategyId, symbol });
  const { claimSignal } = require('../src/execution/manager');

  // The claim is the whole guard against a second execution. Two scheduler
  // ticks, a manual run and a Trade-now click can all reach one signal at
  // once; exactly one of them may send an order.
  assert.equal(await claimSignal(signal.id), true);
  assert.equal(await claimSignal(signal.id), false, 'the second caller must lose');
  assert.equal(await claimSignal(signal.id), false);
});

test('the send attempt is counted on the row, so it survives a restart', async (t) => {
  const { symbol, strategyId } = await seeded(t);
  const signal = await approvedSignal({ strategyId, symbol });
  const { claimSignal, releaseSignal } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');

  await claimSignal(signal.id);
  await releaseSignal(signal.id, { status: 'approved', reason: 'broker said no' });
  await claimSignal(signal.id);

  const [row] = await query('SELECT send_attempts, status FROM signals WHERE id = ?', [signal.id]);
  assert.equal(row.send_attempts, 2);
});

test('running the executor twice sends exactly one order', async (t) => {
  const { symbol, strategyId } = await seeded(t);
  await approvedSignal({ strategyId, symbol });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const bridge = fillingBroker();

  await executeApprovedSignals({ bridge, mode: 'demo', balance: 100000 });
  await executeApprovedSignals({ bridge, mode: 'demo', balance: 100000 });

  assert.equal(bridge.sent.length, 1, 'the second run must not re-send a filled signal');
});

test('two executors racing the same signal send one order between them', async (t) => {
  const { symbol, strategyId } = await seeded(t);
  await approvedSignal({ strategyId, symbol });

  const { executeApprovedSignals } = require('../src/execution/manager');
  const bridge = fillingBroker();

  // The real shape of the bug: a scheduler tick and a manual run overlapping.
  await Promise.all([
    executeApprovedSignals({ bridge, mode: 'demo', balance: 100000 }),
    executeApprovedSignals({ bridge, mode: 'demo', balance: 100000 })
  ]);

  assert.equal(bridge.sent.length, 1);
});

test('a signal that already has a live trade is never sent again', async (t) => {
  const { symbol, strategyId } = await seeded(t);
  const signal = await approvedSignal({ strategyId, symbol });
  const { query } = require('../src/db/pool');

  await query(
    `INSERT INTO trades (signal_id, symbol_id, mode, side, lot, entry_price, sl, opened_at,
       status, broker_ticket)
     VALUES (?, ?, 'demo', 'BUY', 0.1, 100, 99, UTC_TIMESTAMP(), 'OPEN', 555001)`,
    [signal.id, symbol.id]
  );

  const { executeSignal } = require('../src/execution/manager');
  const bridge = fillingBroker();
  const outcome = await executeSignal({ bridge, signal, mode: 'demo', balance: 100000 });

  assert.equal(outcome.status, 'skipped');
  assert.match(outcome.reason, /already been executed/);
  assert.equal(bridge.sent.length, 0);
});

test('a cancelled attempt does not block a later one', async (t) => {
  const { symbol, strategyId } = await seeded(t);
  const signal = await approvedSignal({ strategyId, symbol });
  const { query } = require('../src/db/pool');

  // A rejected order leaves a CANCELLED row. That is a record of an attempt,
  // not of a position, so it must not be mistaken for one.
  await query(
    `INSERT INTO trades (signal_id, symbol_id, mode, side, lot, entry_price, sl, opened_at, status)
     VALUES (?, ?, 'demo', 'BUY', 0.1, 100, 99, UTC_TIMESTAMP(), 'CANCELLED')`,
    [signal.id, symbol.id]
  );

  const { executeSignal } = require('../src/execution/manager');
  const bridge = fillingBroker();
  const outcome = await executeSignal({ bridge, signal, mode: 'demo', balance: 100000 });

  assert.equal(outcome.status, 'filled');
});

test('a broker that keeps rejecting gives up instead of retrying for ever', async (t) => {
  const { symbol, strategyId } = await seeded(t);
  await approvedSignal({ strategyId, symbol });

  const { executeApprovedSignals, MAX_SEND_ATTEMPTS } = require('../src/execution/manager');
  const { query } = require('../src/db/pool');

  let attempts = 0;
  const refusing = {
    order: async () => { attempts += 1; return { ok: false, retcode: 10016, comment: 'Invalid stops' }; },
    positions: async () => ({ positions: [] })
  };

  // One signal was retried 278 times across four and a half hours, writing a
  // CANCELLED row every minute, because a failed send left it 'approved'.
  for (let i = 0; i < 10; i += 1) {
    await executeApprovedSignals({ bridge: refusing, mode: 'demo', balance: 100000 });
  }

  assert.equal(attempts, MAX_SEND_ATTEMPTS, `it must stop after ${MAX_SEND_ATTEMPTS} attempts`);

  const [row] = await query('SELECT status FROM signals');
  assert.equal(row.status, 'rejected', 'and be taken out of the queue, not left approved');
});

test('a claimed signal is never left stuck in executing', async (t) => {
  const { symbol, strategyId } = await seeded(t);
  const signal = await approvedSignal({ strategyId, symbol });
  const { query } = require('../src/db/pool');

  // Make the risk engine refuse it at send time.
  await query("UPDATE risk_state SET kill_switch = 1 WHERE mode = 'demo'").catch(() => {});
  const { tripKillSwitch } = require('../src/risk/state');
  await tripKillSwitch({ mode: 'demo', reason: 'test halt' });

  const { executeApprovedSignals } = require('../src/execution/manager');
  await executeApprovedSignals({ bridge: fillingBroker(), mode: 'demo', balance: 100000 });

  const [row] = await query('SELECT status FROM signals WHERE id = ?', [signal.id]);
  assert.notEqual(row.status, 'executing',
    'a signal stuck in executing would be skipped for ever and look like it simply stopped');
});
