const test = require('node:test');
const assert = require('node:assert/strict');

const { scopeAllows, scopeOnlyTimeframes } = require('../src/strategies/scopes');

/**
 * The rule that makes this table safe to add: no scope rows means no
 * restriction. An empty result from a mistyped query can therefore never
 * silently switch a strategy off.
 */
test('a strategy with no scope rows runs everywhere', () => {
  const scopes = new Map();
  assert.equal(scopeAllows(scopes, { strategyId: 7, symbolId: 1, timeframe: 'M5' }), true);
});

test('a scope row narrows a strategy to what it names', () => {
  const scopes = new Map([[7, [{ symbolId: 13171, timeframe: 'M30' }]]]);

  assert.equal(scopeAllows(scopes, { strategyId: 7, symbolId: 13171, timeframe: 'M30' }), true);
  assert.equal(scopeAllows(scopes, { strategyId: 7, symbolId: 13171, timeframe: 'M15' }), false);
  assert.equal(scopeAllows(scopes, { strategyId: 7, symbolId: 57, timeframe: 'M30' }), false);
  // A different strategy is untouched by someone else's scope.
  assert.equal(scopeAllows(scopes, { strategyId: 8, symbolId: 57, timeframe: 'M30' }), true);
});

/**
 * Scoping a scalp to M5 while M5 was not a traded timeframe used to do
 * nothing whatsoever - the loop only ever walked the traded list - and the
 * only symptom was a strategy that never produced a single signal.
 */
test('a scope on an untraded timeframe adds that timeframe', () => {
  const strategies = [{ id: 7 }, { id: 8 }];
  const scopes = new Map([
    [7, [{ symbolId: 13171, timeframe: 'M5' }, { symbolId: 13171, timeframe: 'M30' }]]
  ]);

  const extras = scopeOnlyTimeframes({ strategies, scopes, active: ['H4', 'M30'] });

  assert.deepEqual([...extras.keys()], ['M5'], 'M30 is already traded, so it is not an extra');
  assert.deepEqual(extras.get('M5').map((s) => s.id), [7]);
});

/**
 * The important half. An unscoped strategy runs everywhere by definition, so
 * adding M5 to the traded list because ONE strategy asked for it would start
 * trading every other strategy on M5 as well - the exact opposite of what
 * narrowing a strategy is for.
 */
test('an extra timeframe carries only the strategies scoped to it', () => {
  const strategies = [{ id: 7 }, { id: 8 }, { id: 9 }];
  const scopes = new Map([[7, [{ symbolId: null, timeframe: 'M5' }]]]);

  const extras = scopeOnlyTimeframes({ strategies, scopes, active: ['H4'] });

  assert.deepEqual(extras.get('M5').map((s) => s.id), [7]);
  assert.equal(extras.get('M5').length, 1, 'the unscoped strategies must not be dragged onto M5');
});

test('a scope row with no timeframe never invents one', () => {
  const strategies = [{ id: 7 }];
  const scopes = new Map([[7, [{ symbolId: 13171, timeframe: null }]]]);

  assert.equal(scopeOnlyTimeframes({ strategies, scopes, active: ['H4'] }).size, 0);
});
