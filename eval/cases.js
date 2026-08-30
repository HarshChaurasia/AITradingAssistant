const { randomWalk, plantedMomentum, costTrap, overfitTrap } = require('./lib/generators');

/**
 * The evaluation set: sixteen strategy-validation questions whose correct
 * answer is fixed by construction.
 *
 * A case is a price series plus a strategy plus a cost model. The question put
 * to the agent and to the baseline is always the one the README asks: does
 * this strategy have an edge on this instrument after costs?
 *
 * `truth` is never exposed through any tool the agent can call. It exists only
 * in the scorer.
 */

const BARS = 3000;
const SPLIT = BARS / 2;

/** A generic 5-digit FX-style instrument. Nothing here depends on a broker. */
const SYMBOL = {
  broker_symbol: 'SYNTH',
  digits: 5,
  point: 0.00001,
  contract_size: 100000,
  min_lot: 0.01,
  lot_step: 0.01,
  max_lot: 100
};

/** Commission is charged per side; the engine doubles it for the round turn. */
const COSTS = {
  realistic: { spreadPrice: 0.00008, slippagePrice: 0.00002, commissionPerLot: 3.5 },
  wide: { spreadPrice: 0.00016, slippagePrice: 0.00003, commissionPerLot: 3.5 },
  zero: { spreadPrice: 0, slippagePrice: 0, commissionPerLot: 0 }
};

/**
 * Seeds are not arbitrary. Each was found by find-seeds.js, which searches for
 * series that MEASURABLY exhibit the property the label claims - a random walk
 * that really does hand the strategy nothing out-of-sample, a cost trap that
 * really is profitable before costs and not after.
 *
 * This matters for honesty, not convenience. A random walk that got lucky and
 * paid +9% out-of-sample would still be labelled NO_EDGE, and an agent that
 * read the evidence correctly would be marked wrong. Verifying the label
 * instead of assuming it is the difference between a graded eval and noise.
 */
const ARCHETYPES = {
  'random-walk': {
    truth: 'NO_EDGE',
    strategy: 'trend-breakout',
    costs: 'realistic',
    seeds: [],
    rationale:
      'Increments are independent. No rule reading only past prices can have '
      + 'positive expectancy, and costs make it strictly negative.',
    generate: (seed) => randomWalk({ bars: BARS, seed })
  },
  'planted-momentum': {
    truth: 'EDGE',
    strategy: 'trend-breakout',
    costs: 'realistic',
    seeds: [],
    rationale:
      'Drift persists in regimes far longer than the holding period, and the '
      + 'move is much larger than the round-turn cost.',
    generate: (seed) => plantedMomentum({ bars: BARS, seed })
  },
  'cost-trap': {
    truth: 'NO_EDGE',
    strategy: 'trend-breakout',
    costs: 'wide',
    seeds: [],
    rationale:
      'The direction is genuinely predictable, but the move is smaller than '
      + 'the spread, slippage and commission charged to capture it.',
    generate: (seed) => costTrap({ bars: BARS, seed })
  },
  'overfit-trap': {
    truth: 'NO_EDGE',
    strategy: 'trend-breakout',
    costs: 'realistic',
    seeds: [],
    rationale:
      'Structure exists only in the first half. Parameters tuned in-sample are '
      + 'fitting noise out-of-sample.',
    generate: (seed) => overfitTrap({ bars: BARS, seed })
  }
};

// Filled by find-seeds.js. Kept as data, separate from the archetype
// definitions above, so regenerating the set is a one-line diff.
const SEEDS = require('./case-seeds.json');
for (const [name, seeds] of Object.entries(SEEDS)) {
  if (ARCHETYPES[name]) ARCHETYPES[name].seeds = seeds;
}

const CASES = [];
for (const [archetype, spec] of Object.entries(ARCHETYPES)) {
  spec.seeds.forEach((seed, i) => {
    CASES.push({
      id: `${archetype}-${i + 1}`,
      archetype,
      seed,
      truth: spec.truth,
      strategy: spec.strategy,
      costs: spec.costs,
      rationale: spec.rationale
    });
  });
}

const cache = new Map();

function seriesFor(archetype, seed) {
  const key = `${archetype}:${seed}`;
  if (!cache.has(key)) cache.set(key, ARCHETYPES[archetype].generate(seed));
  return cache.get(key);
}

/** Candles for a case. Cached, because generation is the slow part. */
function candlesFor(caseId) {
  const testCase = getCase(caseId);
  return seriesFor(testCase.archetype, testCase.seed);
}

function getCase(caseId) {
  const found = CASES.find((c) => c.id === caseId);
  if (!found) throw new Error(`unknown case: ${caseId}`);
  return found;
}

/** Everything the agent is allowed to know about a case. No truth label. */
function publicCase(caseId) {
  const { id, strategy, costs } = getCase(caseId);
  const candles = candlesFor(id);
  return {
    caseId: id,
    strategy,
    symbol: SYMBOL.broker_symbol,
    timeframe: 'H1',
    bars: candles.length,
    inSampleBars: `0..${SPLIT - 1}`,
    outOfSampleBars: `${SPLIT}..${candles.length - 1}`,
    costModel: COSTS[costs],
    firstClose: Number(candles[0].close.toFixed(5)),
    lastClose: Number(candles[candles.length - 1].close.toFixed(5))
  };
}

function windowFor(name) {
  if (name === 'in_sample') return { tradeFrom: 0, tradeTo: SPLIT };
  if (name === 'out_of_sample') return { tradeFrom: SPLIT, tradeTo: BARS };
  if (name === 'full') return { tradeFrom: 0, tradeTo: BARS };
  throw new Error(`unknown window: ${name} (in_sample, out_of_sample, full)`);
}

module.exports = {
  CASES, COSTS, SYMBOL, BARS, SPLIT, ARCHETYPES,
  getCase, publicCase, candlesFor, seriesFor, windowFor
};
