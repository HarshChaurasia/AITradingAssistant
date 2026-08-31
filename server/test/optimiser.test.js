require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');
const { expand, neighbourhood, searchSpaceFor } = require('../src/backtest/search-space');

const SCRATCH_DB = 'trading_agent_optimiser_test';

/**
 * The search space. Its size IS the multiple-testing exposure, so anything
 * that changes the count silently is a correctness problem, not a tuning one.
 */
test('a space expands to every combination and nothing more', () => {
  const combos = expand({ a: [1, 2], b: ['x', 'y', 'z'] });

  assert.equal(combos.length, 6);
  assert.deepEqual(
    combos.map((c) => `${c.a}${c.b}`).sort(),
    ['1x', '1y', '1z', '2x', '2y', '2z']
  );
});

test('an empty space is one candidate - the defaults - not zero', () => {
  assert.deepEqual(expand({}), [{}]);
});

test('a space only offers parameters the strategy actually has', () => {
  const space = searchSpaceFor('trend-breakout');

  assert.ok(space.atrStopMultiple, 'trend-breakout takes a stop multiple');
  // A search that sets a parameter the strategy ignores reports fifty
  // candidates while exploring ten, and the trial count is the number that
  // says whether a pass was luck.
  for (const key of Object.keys(space)) {
    assert.ok(
      key in require('../src/strategies/trend-breakout').defaultParams,
      `${key} is not a trend-breakout parameter`
    );
  }
});

test('an unknown strategy has no space rather than an empty one', () => {
  assert.equal(searchSpaceFor('no-such-strategy'), null);
});

/**
 * Refinement is what makes iterating cheap: the first pass is broad, the ones
 * after it are local, so the trial count grows slowly instead of multiplying.
 */
test('refinement narrows to the winner and its immediate neighbours', () => {
  const space = { atrStopMultiple: [1.0, 1.5, 2.0, 2.5, 3.0] };
  const refined = neighbourhood(space, { atrStopMultiple: 2.0 });

  assert.deepEqual(refined.atrStopMultiple, [1.5, 1.75, 2, 2.25, 2.5]);
});

test('refinement at an edge does not invent values beyond the space', () => {
  const space = { atrStopMultiple: [1.0, 1.5, 2.0] };
  const refined = neighbourhood(space, { atrStopMultiple: 1.0 });

  assert.deepEqual(refined.atrStopMultiple, [1, 1.25, 1.5]);
  assert.ok(!refined.atrStopMultiple.some((v) => v < 1.0), 'nothing below the declared floor');
});

test('a boolean gets no midpoint invented between its values', () => {
  const refined = neighbourhood(
    { requireGapTouch: [true, false] },
    { requireGapTouch: true }
  );

  assert.deepEqual(refined.requireGapTouch, [true, false]);
});

test('a value outside the space pins rather than throws', () => {
  // A winner carried in from a previous run whose space has since changed.
  const refined = neighbourhood({ atrStopMultiple: [1, 2, 3] }, { atrStopMultiple: 7 });

  assert.deepEqual(refined.atrStopMultiple, [7]);
});

/**
 * The ranking guard. Three winners and no losers is a profit factor of
 * Infinity, and it sorted to the top of the sweep table above a strategy with
 * three hundred trades and a real edge.
 */
test('a candidate with too few trades cannot be ranked at all', () => {
  const { rankKey, optimiseMinTrades } = require('../src/backtest/optimiser');
  const thresholds = { minTrades: 50 };

  const floor = optimiseMinTrades('M15', thresholds);
  assert.ok(floor >= 5, 'never rank on a handful of trades whatever the timeframe');

  assert.equal(rankKey({ profitFactor: Infinity, trades: 2 }, 'M15', thresholds), -Infinity);
  assert.equal(rankKey({ profitFactor: 99, trades: floor - 1 }, 'M15', thresholds), -Infinity);
  assert.ok(rankKey({ profitFactor: 1.2, trades: floor }, 'M15', thresholds) > 0);
});

test('expectancy breaks ties without overturning profit factor', () => {
  const { rankKey } = require('../src/backtest/optimiser');
  const thresholds = { minTrades: 50 };

  const modest = rankKey({ profitFactor: 1.5, trades: 100, expectancy: 1 }, 'M15', thresholds);
  const richer = rankKey({ profitFactor: 1.5, trades: 100, expectancy: 5000 }, 'M15', thresholds);
  const better = rankKey({ profitFactor: 1.6, trades: 100, expectancy: 0 }, 'M15', thresholds);

  assert.ok(richer > modest, 'more per trade wins a tie');
  assert.ok(better > richer, 'but a better profit factor still wins outright');
});

/**
 * Promotion. This is the gate that decides whether real money follows a
 * number, so its refusal matters more than its acceptance.
 */
test('a study that failed the holdout cannot be promoted', async (t) => {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  await runMigrations({ silent: true });

  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await registerStrategies();

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, synced_at)
     VALUES ('BTCUSD', 2, 0.01, 1, 0.01, 1, 0.01, 0.01, 100, 1, UTC_TIMESTAMP())`
  );
  const [symbol] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['BTCUSD']);
  const [strategy] = await query('SELECT id FROM strategies LIMIT 1');

  const { recordStudy, promoteFromStudy } = require('../src/strategies/promotions');

  // The exact shape the optimiser found live: passes validate, dies on the
  // holdout. Under a two-window scheme this would have been promoted.
  const { studyId } = await recordStudy({
    strategyName: (await query('SELECT name FROM strategies WHERE id = ?', [strategy.id]))[0].name,
    symbolId: symbol.id,
    timeframe: 'M15',
    trials: 83,
    iterations: [{ iteration: 1 }],
    winner: {
      fullParams: { atrStopMultiple: 3 },
      optimise: { profitFactor: 1.17, trades: 180 },
      validate: { profitFactor: 1.33, trades: 87 },
      holdout: { profitFactor: 0.76, trades: 90 }
    },
    validatePassed: true,
    holdoutPassed: false,
    promotable: false,
    robustness: { median: 1.16 }
  });

  await assert.rejects(
    () => promoteFromStudy(studyId),
    /not promotable.*holdout/i,
    'the window nothing was chosen on is the one that decides'
  );
});

test('a study that cleared both windows promotes, and the promotion pins its parameters', async (t) => {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  await runMigrations({ silent: true });

  const { query } = require('../src/db/pool');
  const { registerStrategies } = require('../src/strategies/registry');
  await registerStrategies();

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, synced_at)
     VALUES ('BTCUSD', 2, 0.01, 1, 0.01, 1, 0.01, 0.01, 100, 1, UTC_TIMESTAMP())`
  );
  const [symbol] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['BTCUSD']);
  const [strategy] = await query('SELECT id, name FROM strategies LIMIT 1');

  const {
    recordStudy, promoteFromStudy, loadPromotedKeys, isPromoted
  } = require('../src/strategies/promotions');

  const { studyId } = await recordStudy({
    strategyName: strategy.name,
    symbolId: symbol.id,
    timeframe: 'H1',
    trials: 216,
    iterations: [{ iteration: 1 }],
    winner: {
      fullParams: { atrStopMultiple: 2.75, atrTargetMultiple: 4 },
      optimise: { profitFactor: 1.37, trades: 111 },
      validate: { profitFactor: 1.41, trades: 62 },
      holdout: { profitFactor: 1.35, trades: 58 }
    },
    validatePassed: true,
    holdoutPassed: true,
    promotable: true,
    robustness: { median: 1.37 }
  });

  const promotions = await promoteFromStudy(studyId, { promotedBy: 'test' });
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].timeframe, 'H1');
  // Promotion lands at the BACKTEST stage. The lab searched, so its holdout
  // was reached after heavy selection; a confirmation run with no search in
  // it at all is what actually puts a combination into service.
  assert.equal(promotions[0].stage, 'backtest');
  assert.deepEqual(promotions[0].params, { atrStopMultiple: 2.75, atrTargetMultiple: 4 },
    'the numbers are promoted, not just the name - the same code with a different stop is a different bet');
  assert.equal(Number(promotions[0].trials), 216, 'the trial count travels with the claim');

  // Nothing trades until the stage advances - the whole point of the extra
  // step, and the reason this asserts false before it asserts true.
  assert.equal((await loadPromotedKeys()).size, 0, 'awaiting confirmation is not permission to trade');
  await query("UPDATE strategy_promotions SET stage = 'enabled' WHERE id = ?", [promotions[0].id]);

  const promoted = await loadPromotedKeys();
  assert.equal(
    isPromoted(promoted, { strategyId: strategy.id, symbolId: symbol.id, timeframe: 'H1' }),
    true
  );
  // Promotion is per combination. The same strategy on another timeframe has
  // earned nothing.
  assert.equal(
    isPromoted(promoted, { strategyId: strategy.id, symbolId: symbol.id, timeframe: 'M5' }),
    false
  );
});

test('an empty promotion table promotes nothing, rather than everything', () => {
  const { isPromoted } = require('../src/strategies/promotions');

  assert.equal(isPromoted(new Set(), { strategyId: 1, symbolId: 1, timeframe: 'H1' }), false);
  assert.equal(isPromoted(null, { strategyId: 1, symbolId: 1, timeframe: 'H1' }), false);
});

/**
 * A promotion that is not applied is worse than no promotion: it attaches a
 * backtest's confidence to a bet the backtest never covered. Measured here,
 * macd-trend clears its holdout on XAUUSD H1 with a 5.25 ATR target and fails
 * at the 3.0 the strategies table ships.
 */
test('the generator trades the parameters a promotion was earned with', async (t) => {
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

  const { recordStudy, promoteFromStudy, loadPromotedParams } = require('../src/strategies/promotions');
  const { studyId } = await recordStudy({
    strategyName: strategy.name,
    symbolId: symbol.id,
    timeframe: 'H1',
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
  const [promotion] = await promoteFromStudy(studyId);
  await query("UPDATE strategy_promotions SET stage = 'enabled' WHERE id = ?", [promotion.id]);

  const promoted = await loadPromotedParams();
  const params = promoted.get(`${strategy.id}|${symbol.id}|H1`);

  assert.deepEqual(params, { atrStopMultiple: 2, atrTargetMultiple: 5.25 });
  // The shipped default is 3.0, and trading that while citing the promoted
  // result is the failure this guards against.
  assert.notEqual(params.atrTargetMultiple, 3);

  // Another timeframe inherits nothing.
  assert.equal(promoted.get(`${strategy.id}|${symbol.id}|M5`), undefined);
});
