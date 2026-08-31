const { query } = require('../db/pool');

/**
 * Which symbol/timeframe combinations a strategy may run on.
 *
 * The rule that matters: a strategy with NO scope rows runs everywhere. That
 * is the old behaviour, so adding this table changed nothing until someone
 * deliberately narrowed a strategy - and an empty result from a mis-typed
 * query can never silently switch a strategy off, because "no rows" already
 * means "no restriction".
 *
 * The cost of not having this was measurable: nine strategies over five
 * symbols and five timeframes is 225 combinations reading the same candles,
 * so one real move fired most of them together. Seven near-identical long
 * positions opened inside ten minutes and lost 8,716 between them.
 */

async function loadScopes() {
  const rows = await query(
    `SELECT sc.strategy_id, sc.symbol_id, sc.timeframe, sym.broker_symbol
       FROM strategy_scopes sc
       LEFT JOIN symbols sym ON sym.id = sc.symbol_id`
  );

  const byStrategy = new Map();
  for (const row of rows) {
    if (!byStrategy.has(row.strategy_id)) byStrategy.set(row.strategy_id, []);
    byStrategy.get(row.strategy_id).push({
      symbolId: row.symbol_id,
      timeframe: row.timeframe,
      symbol: row.broker_symbol
    });
  }
  return byStrategy;
}

/**
 * May this strategy run on this symbol and timeframe?
 *
 * A NULL symbol or timeframe in a scope row means "any", so one row can say
 * "this strategy, H4 only, whatever the instrument".
 */
function scopeAllows(scopes, { strategyId, symbolId, timeframe }) {
  const mine = scopes.get(strategyId);
  if (!mine || mine.length === 0) return true;

  return mine.some((scope) => {
    const symbolOk = scope.symbolId === null || Number(scope.symbolId) === Number(symbolId);
    const timeframeOk = scope.timeframe === null || scope.timeframe === timeframe;
    return symbolOk && timeframeOk;
  });
}

/**
 * Replace a strategy's scope with the given list.
 *
 * An empty list clears the scope, which restores "runs everywhere" rather than
 * disabling the strategy. Turning a strategy off is what `enabled` is for, and
 * conflating the two would make an accidental deselection look like a working
 * strategy that has quietly stopped.
 */
async function setScopes(strategyId, entries = []) {
  await query('DELETE FROM strategy_scopes WHERE strategy_id = ?', [Number(strategyId)]);

  for (const entry of entries) {
    const symbolId = entry.symbolId === null || entry.symbolId === undefined
      ? null
      : Number(entry.symbolId);
    const timeframe = entry.timeframe || null;
    await query(
      `INSERT IGNORE INTO strategy_scopes (strategy_id, symbol_id, timeframe, created_at)
       VALUES (?, ?, ?, UTC_TIMESTAMP())`,
      [Number(strategyId), symbolId, timeframe]
    );
  }

  return listScopes(strategyId);
}

/**
 * Extra timeframes that exist only because a strategy is scoped to them.
 *
 * Scoping a scalp to M5 while M5 is not a traded timeframe looked like it
 * enabled M5 and did nothing at all - the loop only walks the traded list, so
 * those rows were dead and the symptom was a strategy that never fired.
 *
 * Each extra timeframe carries ONLY the strategies explicitly scoped to it.
 * Widening the traded list itself would be much worse than the bug: an
 * unscoped strategy runs everywhere by definition, so one M5 scope row would
 * quietly start trading every other strategy on M5 too.
 */
function scopeOnlyTimeframes({ strategies, scopes, active }) {
  const extras = new Map();
  for (const strategy of strategies) {
    for (const scope of scopes.get(strategy.id) || []) {
      if (!scope.timeframe || active.includes(scope.timeframe)) continue;
      if (!extras.has(scope.timeframe)) extras.set(scope.timeframe, []);
      const bucket = extras.get(scope.timeframe);
      if (!bucket.some((s) => s.id === strategy.id)) bucket.push(strategy);
    }
  }
  return extras;
}

/**
 * The same list, resolved from the database, for callers that only need the
 * timeframe names - the scheduler syncs candles and sets signal expiry per
 * timeframe, and a timeframe it does not know about would generate signals
 * against stale candles that then never expire.
 */
async function scopeOnlyTimeframeNames(active) {
  const strategies = await query(
    'SELECT id FROM strategies WHERE enabled = 1 AND superseded_at IS NULL'
  );
  const scopes = await loadScopes();
  return [...scopeOnlyTimeframes({ strategies, scopes, active }).keys()];
}

async function listScopes(strategyId) {
  return query(
    `SELECT sc.id, sc.symbol_id AS symbolId, sc.timeframe, sym.broker_symbol AS symbol
       FROM strategy_scopes sc
       LEFT JOIN symbols sym ON sym.id = sc.symbol_id
      WHERE sc.strategy_id = ?
      ORDER BY sym.broker_symbol, sc.timeframe`,
    [Number(strategyId)]
  );
}

module.exports = {
  loadScopes, scopeAllows, setScopes, listScopes,
  scopeOnlyTimeframes, scopeOnlyTimeframeNames
};
