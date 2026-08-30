require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_perf_test';

async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await runMigrations({ silent: true });
  await registerStrategies();

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, watched, synced_at)
     VALUES ('BTCUSD', 2, 0.01, 1, 0.01, 1, 0.1, 0.1, 1000, 1, 1, UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['BTCUSD']);
  const [st] = await query("SELECT id FROM strategies WHERE name = 'trend-breakout'");
  return { symbolId: sym.id, strategyId: st.id };
}

async function closedTrade({ symbolId, daysAgo, pnl }) {
  const { query } = require('../src/db/pool');
  await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, opened_at, closed_at,
       status, pnl, broker_ticket)
     VALUES (?, 'demo', 'BUY', 0.5, 100, 99,
             DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY),
             DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY),
             'CLOSED', ?, FLOOR(RAND()*1000000))`,
    [symbolId, daysAgo, daysAgo, pnl]
  );
}

test('daily rows carry trades, wins, pnl and a running total', async (t) => {
  const { symbolId } = await seeded(t);
  await closedTrade({ symbolId, daysAgo: 3, pnl: 100 });
  await closedTrade({ symbolId, daysAgo: 3, pnl: -40 });
  await closedTrade({ symbolId, daysAgo: 1, pnl: 25 });

  const { dailyPerformance } = require('../src/execution/performance');
  const rows = await dailyPerformance({ mode: 'demo', days: 30 });

  assert.equal(rows.length, 2, 'one row per day that had activity');

  const [older, newer] = rows;
  assert.equal(older.trades, 2);
  assert.equal(older.wins, 1);
  assert.equal(older.losses, 1);
  assert.equal(older.pnl, 60);
  assert.equal(older.winRatePct, 50);
  assert.equal(older.cumulativePnl, 60);

  assert.equal(newer.trades, 1);
  assert.equal(newer.cumulativePnl, 85, 'the running total accumulates across days');
});

test('a day with no trades reports zero rather than vanishing', async (t) => {
  const { symbolId } = await seeded(t);
  const { query } = require('../src/db/pool');

  // Equity is snapshotted every minute even when nothing trades. On a
  // strategy that fires once every four days, most days look like this, and
  // a missing row would read as a broken system rather than a quiet one.
  await query(
    `INSERT INTO equity_snapshots (mode, captured_at, balance, equity)
     VALUES ('demo', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), 100000, 100500)`
  );
  await closedTrade({ symbolId, daysAgo: 1, pnl: 10 });

  const { dailyPerformance } = require('../src/execution/performance');
  const rows = await dailyPerformance({ mode: 'demo', days: 30 });

  const quiet = rows[0];
  assert.equal(quiet.trades, 0);
  assert.equal(quiet.pnl, 0);
  assert.equal(quiet.equityClose, 100500, 'the equity is still recorded');
  assert.equal(quiet.winRatePct, null, 'no win rate is claimed from zero trades');
});

test('signal counts are reported alongside trades', async (t) => {
  const { symbolId, strategyId } = await seeded(t);
  const { query } = require('../src/db/pool');

  for (const [status, bar] of [['executed', '01'], ['rejected', '02'], ['rejected', '03']]) {
    await query(
      `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
         side, entry, sl, status)
       VALUES (?, ?, 'H4', 'demo', UTC_TIMESTAMP(), ?, 'BUY', 100, 99, ?)`,
      [strategyId, symbolId, `2026-02-${bar} 00:00:00`, status]
    );
  }

  const { dailyPerformance } = require('../src/execution/performance');
  const today = (await dailyPerformance({ mode: 'demo', days: 30 })).at(-1);

  assert.equal(today.signalsCreated, 3);
  assert.equal(today.signalsRejected, 2);
  assert.equal(today.signalsExecuted, 1);
});

test('breakdown reports every strategy and symbol, including ones with no trades', async (t) => {
  const { symbolId } = await seeded(t);
  await closedTrade({ symbolId, daysAgo: 1, pnl: 50 });

  const { breakdown } = require('../src/execution/performance');
  const { strategies } = require('../src/strategies/registry');
  const b = await breakdown({ mode: 'demo' });

  assert.equal(b.byStrategy.length, strategies.length,
    'a strategy with no trades still needs a row, or it looks unconfigured');
  assert.ok(b.bySymbol.some((s) => s.symbol === 'BTCUSD'));
  assert.ok(Array.isArray(b.backtests));
});

test('another mode is not mixed in', async (t) => {
  const { symbolId } = await seeded(t);
  const { query } = require('../src/db/pool');

  await closedTrade({ symbolId, daysAgo: 1, pnl: 100 });
  await query(
    `INSERT INTO trades (symbol_id, mode, side, lot, entry_price, sl, opened_at, closed_at,
       status, pnl, broker_ticket)
     VALUES (?, 'live', 'BUY', 1, 100, 99, UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'CLOSED', -999, 424242)`,
    [symbolId]
  );

  const { dailyPerformance } = require('../src/execution/performance');
  const rows = await dailyPerformance({ mode: 'demo', days: 30 });
  const total = rows.reduce((sum, r) => sum + r.pnl, 0);

  assert.equal(total, 100, 'live results must never leak into demo figures');
});
