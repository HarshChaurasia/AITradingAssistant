require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_lifecycle_test';

/**
 * research -> backtest -> enabled, and back to research when live results
 * turn bad. Every transition here decides whether real money follows a
 * number, so the refusals matter more than the acceptances.
 */
async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  await runMigrations({ silent: true });

  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await registerStrategies();

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, synced_at)
     VALUES ('XAUUSD', 2, 0.01, 100, 0.01, 1, 0.01, 0.01, 100, 1, UTC_TIMESTAMP())`
  );
  const [symbol] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['XAUUSD']);
  const [strategy] = await query('SELECT id, name FROM strategies WHERE name = ?', ['macd-trend']);

  return { query, symbol, strategy };
}

async function promoted(t, { timeframe = 'H1' } = {}) {
  const ctx = await seeded(t);
  const { recordStudy, promoteFromStudy } = require('../src/strategies/promotions');

  const { studyId } = await recordStudy({
    strategyName: ctx.strategy.name,
    symbolId: ctx.symbol.id,
    timeframe,
    trials: 83,
    iterations: [],
    winner: {
      fullParams: { atrStopMultiple: 2, atrTargetMultiple: 5.25 },
      optimise: { profitFactor: 2.02, trades: 60 },
      validate: { profitFactor: 1.54, trades: 29 },
      holdout: { profitFactor: 1.59, trades: 29 }
    },
    validatePassed: true,
    holdoutPassed: true,
    promotable: true
  });
  await promoteFromStudy(studyId);

  const [promotion] = await ctx.query('SELECT * FROM strategy_promotions WHERE study_id = ?', [studyId]);
  return { ...ctx, studyId, promotion };
}

/**
 * The lab searched hundreds of candidates, so its holdout was reached after a
 * great deal of selection. Landing straight in service would skip the only
 * run that has no selection in it at all.
 */
test('a promoted combination lands at backtest, not in service', async (t) => {
  const { promotion } = await promoted(t);

  assert.equal(promotion.stage, 'backtest');
  assert.equal(promotion.confirmation_run_id, null);
});

test('a combination awaiting confirmation may not trade', async (t) => {
  await promoted(t);
  const { loadPromotedKeys, isPromoted } = require('../src/strategies/promotions');

  const keys = await loadPromotedKeys();
  assert.equal(keys.size, 0, 'only the enabled stage may trade');
  assert.equal(isPromoted(keys, { strategyId: 1, symbolId: 1, timeframe: 'H1' }), false);
});

test('the strategy flag is derived, and stays off until something is enabled', async (t) => {
  const { query, strategy } = await promoted(t);
  const { syncEnabledFlags } = require('../src/strategies/lifecycle');

  await query('UPDATE strategies SET enabled = 1 WHERE id = ?', [strategy.id]);
  await syncEnabledFlags();

  const [row] = await query('SELECT enabled FROM strategies WHERE id = ?', [strategy.id]);
  assert.equal(row.enabled, 0, 'a hand-set flag is overwritten by the evidence');
});

test('the flag turns on once a combination reaches enabled, and off when it leaves', async (t) => {
  const { query, strategy, promotion } = await promoted(t);
  const { syncEnabledFlags } = require('../src/strategies/lifecycle');

  await query("UPDATE strategy_promotions SET stage = 'enabled' WHERE id = ?", [promotion.id]);
  await syncEnabledFlags();
  let [row] = await query('SELECT enabled FROM strategies WHERE id = ?', [strategy.id]);
  assert.equal(row.enabled, 1);

  await query("UPDATE strategy_promotions SET stage = 'demoted' WHERE id = ?", [promotion.id]);
  await syncEnabledFlags();
  [row] = await query('SELECT enabled FROM strategies WHERE id = ?', [strategy.id]);
  assert.equal(row.enabled, 0);
});

/**
 * Demotion. The threshold is generous and the sample requirement is not: a
 * genuine 55%-win strategy produces losing ten-trade runs regularly, and
 * demoting on those would mean nothing ever survived long enough to judge.
 */
async function withClosedTrades(ctx, { count, pnl }) {
  const { query, symbol, strategy, promotion } = ctx;
  await query("UPDATE strategy_promotions SET stage = 'enabled' WHERE id = ?", [promotion.id]);

  for (let i = 0; i < count; i += 1) {
    const result = await query(
      `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
         side, entry, sl, tp, status)
       VALUES (?, ?, 'H1', 'demo', UTC_TIMESTAMP(), DATE_ADD('2026-01-01', INTERVAL ? HOUR),
               'BUY', 100, 99, 105, 'executed')`,
      [strategy.id, symbol.id, i]
    );
    await query(
      `INSERT INTO trades (signal_id, symbol_id, mode, side, lot, entry_price, sl,
         opened_at, closed_at, status, pnl)
       VALUES (?, ?, 'demo', 'BUY', 0.1, 100, 99, UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'CLOSED', ?)`,
      [result.insertId, symbol.id, pnl(i)]
    );
  }
}

test('a losing combination is demoted once the sample is large enough', async (t) => {
  const ctx = await promoted(t);
  const { reviewLivePerformance } = require('../src/strategies/lifecycle');

  // 20 trades: 5 winners of 100, 15 losers of 100. Profit factor 0.33.
  await withClosedTrades(ctx, { count: 20, pnl: (i) => (i < 5 ? 100 : -100) });

  const result = await reviewLivePerformance({ mode: 'demo', logger: { error() {} } });

  assert.equal(result.demoted.length, 1);
  const [row] = await ctx.query('SELECT * FROM strategy_promotions WHERE id = ?', [ctx.promotion.id]);
  assert.equal(row.stage, 'demoted');
  assert.match(row.demote_reason, /live profit factor 0\.33 over 20 closed trades/);

  // ...and it stops trading immediately.
  const { loadPromotedKeys } = require('../src/strategies/promotions');
  assert.equal((await loadPromotedKeys()).size, 0);
});

test('a losing streak too short to mean anything is left alone', async (t) => {
  const ctx = await promoted(t);
  const { reviewLivePerformance } = require('../src/strategies/lifecycle');

  // Every trade a loser, but only 19 of them - one short of the minimum. A
  // 55%-win strategy produces runs like this, and demoting here would throw
  // away working combinations constantly.
  await withClosedTrades(ctx, { count: 19, pnl: () => -100 });

  const result = await reviewLivePerformance({ mode: 'demo', logger: { error() {} } });

  assert.equal(result.demoted.length, 0);
  const [row] = await ctx.query('SELECT * FROM strategy_promotions WHERE id = ?', [ctx.promotion.id]);
  assert.equal(row.stage, 'enabled');
  // The measurement is still recorded, so the screen can show it approaching.
  assert.equal(Number(row.live_trades), 19);
});

test('a profitable combination is measured, not demoted', async (t) => {
  const ctx = await promoted(t);
  const { reviewLivePerformance } = require('../src/strategies/lifecycle');

  // 30 trades, 15 winners of 200 against 15 losers of 100: profit factor 2.
  await withClosedTrades(ctx, { count: 30, pnl: (i) => (i % 2 === 0 ? 200 : -100) });

  await reviewLivePerformance({ mode: 'demo', logger: { error() {} } });

  const [row] = await ctx.query('SELECT * FROM strategy_promotions WHERE id = ?', [ctx.promotion.id]);
  assert.equal(row.stage, 'enabled');
  assert.equal(Number(row.live_pf), 2);
});

test('a combination with no losses yet is not treated as infinitely good', async (t) => {
  const ctx = await promoted(t);
  const { reviewLivePerformance } = require('../src/strategies/lifecycle');

  await withClosedTrades(ctx, { count: 25, pnl: () => 100 });
  await reviewLivePerformance({ mode: 'demo', logger: { error() {} } });

  const [row] = await ctx.query('SELECT live_pf, stage FROM strategy_promotions WHERE id = ?', [ctx.promotion.id]);
  assert.equal(row.live_pf, null, 'no losses is an unfinished sample, not a profit factor of Infinity');
  assert.equal(row.stage, 'enabled');
});

test('every transition is recorded, so "why is this trading" has an answer later', async (t) => {
  const ctx = await promoted(t);
  const { reviewLivePerformance, listLifecycle } = require('../src/strategies/lifecycle');

  await withClosedTrades(ctx, { count: 20, pnl: () => -100 });
  await reviewLivePerformance({ mode: 'demo', logger: { error() {} } });

  const { events, counts } = await listLifecycle();
  assert.equal(counts.demoted, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].from_stage, 'enabled');
  assert.equal(events[0].to_stage, 'demoted');
  assert.match(events[0].reason, /below 1/);
});

/**
 * The confirmation must not re-measure the window the lab already scored.
 *
 * The first implementation took executeRun's own verdict, which comes from
 * its validate window - the same slice the lab had chosen the winner on. The
 * step existed, ran, and proved nothing. It was caught only because the
 * numbers came back identical: profit factor 1.54 on 29 trades, to the
 * decimal, exactly the lab's validate figure.
 *
 * With parameters fixed there is no selection to protect against, so the
 * whole period is legitimately usable - and it is roughly four times the
 * sample. Re-run honestly, the same two combinations read 1.74 over 120
 * trades and 1.82 over 140.
 */
test('confirmation judges the whole period, not the window the lab scored', async (t) => {
  const ctx = await promoted(t);
  const { confirmCombination } = require('../src/strategies/lifecycle');

  let seenOptions = null;
  // Stubbed so the assertion is about WHICH numbers decide, not about whether
  // a fixture happens to be profitable.
  const executeRunFn = async (args) => {
    seenOptions = args.options;
    return {
      runId: 999,
      thresholds: { minProfitFactor: 1.3, maxDrawdownPct: 15, minTrades: 50 },
      // Full period is healthy; the validate sub-window is not. Judging on
      // the sub-window would reject a combination that works.
      metrics: { profitFactor: 1.74, trades: 120, maxDrawdownPct: 6, expectancy: 210 },
      walkForward: {
        outOfSample: { profitFactor: 0.4, trades: 29, maxDrawdownPct: 20, expectancy: -50 }
      },
      passed: false,
      failures: ['profit factor 0.40 is below 1.3']
    };
  };

  const result = await confirmCombination(ctx.promotion.id, { executeRunFn });

  assert.equal(result.confirmed, true, 'the full-period result is what decides');
  assert.equal(result.metrics.trades, 120);
  // And it really did ask for the whole year rather than a slice.
  assert.ok(seenOptions.from, 'the confirmation run is bounded by a date range');
  assert.equal(seenOptions.commissionPerLot, 0, 'a cost the account does not pay must not fail it');

  const [row] = await ctx.query('SELECT stage, confirmation_run_id FROM strategy_promotions WHERE id = ?', [ctx.promotion.id]);
  assert.equal(row.stage, 'enabled');
  assert.equal(Number(row.confirmation_run_id), 999);
});

test('a combination that fails confirmation goes back, not forward', async (t) => {
  const ctx = await promoted(t);
  const { confirmCombination } = require('../src/strategies/lifecycle');
  const { loadPromotedKeys } = require('../src/strategies/promotions');

  const executeRunFn = async () => ({
    runId: 1000,
    thresholds: { minProfitFactor: 1.3, maxDrawdownPct: 15, minTrades: 50 },
    metrics: { profitFactor: 0.8, trades: 130, maxDrawdownPct: 9, expectancy: -40 },
    walkForward: { outOfSample: { profitFactor: 1.9, trades: 30 } },
    passed: true,
    failures: []
  });

  const result = await confirmCombination(ctx.promotion.id, { executeRunFn });

  assert.equal(result.confirmed, false);
  assert.match(result.failures.join(' '), /profit factor/);

  const [row] = await ctx.query('SELECT stage, demote_reason FROM strategy_promotions WHERE id = ?', [ctx.promotion.id]);
  assert.equal(row.stage, 'demoted');
  assert.match(row.demote_reason, /confirmation failed/);
  assert.equal((await loadPromotedKeys()).size, 0, 'it must not trade');
});
