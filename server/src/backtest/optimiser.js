const { getCandles } = require('../market/candles');
const { query } = require('../db/pool');
const { getStrategy, mergeParams } = require('../strategies/registry');
const { runBacktest } = require('./engine');
const { computeMetrics } = require('./metrics');
const { searchSpaceFor, expand, neighbourhood } = require('./search-space');
const {
  DEFAULT_SPLIT, minTradesFor, evaluateThresholds, tradeWindowFor
} = require('./runner');

/**
 * Searching for parameters without lying to ourselves about the result.
 *
 * The request this implements was "change the parameters and run it again
 * until it becomes profitable". Done directly that is a machine for
 * manufacturing false confidence: try two hundred parameter sets against the
 * same out-of-sample window, keep whichever passes, and roughly ten will pass
 * by chance alone - then fail identically on real money, because chance does
 * not repeat.
 *
 * Three rules make the same exercise honest, and they are the whole design:
 *
 * 1. THE SEARCH ONLY SEES THE OPTIMISE WINDOW. Candidates are ranked on the
 *    first half of the history and nothing else. The moment a ranking touches
 *    the validate window, that window stops being out-of-sample and its
 *    number becomes the maximum of N draws rather than an estimate.
 *
 * 2. THE WINNER IS SCORED ONCE ON VALIDATE, AND ONCE ON HOLDOUT. Not
 *    "scored, adjusted, scored again" - that is the same leak wearing a hat.
 *
 * 3. THE TRIAL COUNT IS PART OF THE RESULT. A pass after 4 candidates and a
 *    pass after 400 are different claims, and only one of them is described
 *    by the profit factor.
 *
 * There is a fourth thing reported here that matters more than any of them:
 * whether the winner's NEIGHBOURS also work. A parameter set that is good
 * while everything around it is bad is a spike in noise. One sitting in a
 * plateau of decent results is an edge that happens to peak there. The profit
 * factor cannot tell those apart; `robustness` can.
 */

// Candidates carried from one iteration into the next as refinement seeds.
const KEEP_PER_ITERATION = 3;

/**
 * The trade count a candidate needs before its rank means anything.
 *
 * Half the verdict threshold: the optimise window is the larger slice, but
 * demanding the full count here would discard slow strategies before they
 * ever reached the window that judges them. A candidate below it is not a
 * conservative strategy, it is an unmeasured one, and ranking on three trades
 * is how a search ends up chasing an outlier.
 */
function optimiseMinTrades(timeframe, thresholds) {
  return Math.max(5, Math.floor(minTradesFor(timeframe, thresholds) / 2));
}

/**
 * Score one parameter set on one window.
 *
 * Deliberately does NOT touch the database. A 150-candidate search writing a
 * run row and its trades each time would spend most of its life in MySQL and
 * leave a thousand rows nobody will ever read; only the conclusion is worth
 * persisting.
 */
function score({ candles, strategy, params, symbol, options, window }) {
  const result = runBacktest({
    candles,
    strategy,
    params,
    symbol,
    options: { ...options, tradeFrom: window.tradeFrom, tradeTo: window.tradeTo }
  });
  return {
    metrics: computeMetrics(result.trades, { startingBalance: options.startingBalance }),
    skipped: result.skipped.length
  };
}

/**
 * Rank on the optimise window, and never on anything else.
 *
 * Profit factor alone rewards a strategy that took four trades and won three.
 * Expectancy alone rewards one enormous winner. Requiring a real trade count
 * before either counts is what stops the search settling on an accident.
 */
function rankKey(metrics, timeframe, thresholds) {
  if (Number(metrics.trades || 0) < optimiseMinTrades(timeframe, thresholds)) return -Infinity;
  const pf = Number(metrics.profitFactor);
  if (!Number.isFinite(pf)) return -Infinity;
  // Expectancy breaks ties, because between two strategies that win the same
  // proportion of what they lose, the one that makes more per trade is the
  // one worth trading.
  return pf + Math.min(Number(metrics.expectancy || 0) / 100000, 0.01);
}

async function optimiseStrategy({
  strategyName,
  symbolId,
  timeframe,
  iterations = 5,
  options = {},
  thresholds = { minProfitFactor: 1.3, maxDrawdownPct: 15, minTrades: 50 },
  onProgress = null
}) {
  const strategy = getStrategy(strategyName);
  const space = searchSpaceFor(strategyName);
  if (!space) {
    throw new Error(`${strategyName} has no search space declared - nothing to vary`);
  }

  const [symbol] = await query('SELECT * FROM symbols WHERE id = ?', [symbolId]);
  if (!symbol) throw new Error(`unknown symbolId ${symbolId}`);

  const candles = await getCandles({ symbolId, timeframe, limit: 200000 });
  if (candles.length < 100) {
    throw new Error(
      `only ${candles.length} ${timeframe} bars stored for ${symbol.broker_symbol} - backfill first`
    );
  }

  // The same per-symbol broker spread the runner uses. A search is exactly
  // where a wrong cost does the most damage: it does not merely shift every
  // result, it changes which candidate wins.
  const brokerSpread = Number(symbol.spread_points) * Number(symbol.point);
  const spreadPrice = Number.isFinite(Number(options.spreadPrice)) && options.spreadPrice !== null
    ? Number(options.spreadPrice)
    : (brokerSpread > 0 ? brokerSpread : 0);

  const runOptions = {
    startingBalance: options.startingBalance ?? 10000,
    riskPctPerTrade: options.riskPctPerTrade ?? 1,
    commissionPerLot: options.commissionPerLot ?? 0,
    ...options,
    spreadPrice
  };

  const range = tradeWindowFor(candles, { from: options.from, to: options.to })
    || { tradeFrom: 0, tradeTo: candles.length };
  const span = range.tradeTo - range.tradeFrom;
  if (span < 100) {
    throw new Error(`only ${span} bars inside the requested date range - widen it or backfill`);
  }

  const split = { ...DEFAULT_SPLIT, ...(options.split || {}) };
  const optimiseEnd = range.tradeFrom + Math.floor(span * split.optimise);
  const validateEnd = range.tradeFrom + Math.floor(span * (split.optimise + split.validate));

  const windows = {
    optimise: { tradeFrom: range.tradeFrom, tradeTo: optimiseEnd },
    validate: { tradeFrom: optimiseEnd, tradeTo: validateEnd },
    holdout: { tradeFrom: validateEnd, tradeTo: range.tradeTo }
  };

  let currentSpace = space;
  let seeds = [];
  let trials = 0;
  const seen = new Set();
  const iterationLog = [];

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const candidates = expand(currentSpace);
    const scored = [];

    for (const candidate of candidates) {
      // Refinement neighbourhoods overlap between iterations. Re-scoring a
      // candidate would cost time and, worse, inflate the trial count with
      // trials that were never independent.
      const fingerprint = JSON.stringify(candidate);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      const params = mergeParams(strategy, candidate);
      const { metrics } = score({
        candles, strategy, params, symbol, options: runOptions, window: windows.optimise
      });
      trials += 1;
      scored.push({
        candidate, params, optimise: metrics, key: rankKey(metrics, timeframe, thresholds)
      });

      if (onProgress && trials % 25 === 0) {
        onProgress({ iteration, trials, strategyName, timeframe, symbol: symbol.broker_symbol });
      }
    }

    scored.sort((a, b) => b.key - a.key);
    const usable = scored.filter((s) => s.key > -Infinity);

    iterationLog.push({
      iteration,
      candidates: scored.length,
      usable: usable.length,
      best: usable[0]
        ? {
          params: usable[0].candidate,
          profitFactor: usable[0].optimise.profitFactor,
          trades: usable[0].optimise.trades
        }
        : null
    });

    if (usable.length === 0) {
      // Every candidate traded too little to rank. Refining around nothing
      // repeats that, so stop and say so rather than burning four more
      // iterations to arrive at the same silence.
      break;
    }

    // Keep the best seen ANYWHERE, not merely in this iteration: a refinement
    // can be worse than what it refined, and silently accepting that would
    // let the search walk downhill.
    seeds = [...seeds, ...usable].sort((a, b) => b.key - a.key).slice(0, KEEP_PER_ITERATION);
    if (iteration < iterations) currentSpace = neighbourhood(space, seeds[0].candidate);
  }

  if (seeds.length === 0) {
    return {
      strategyName,
      symbolId,
      symbol: symbol.broker_symbol,
      timeframe,
      trials,
      iterations: iterationLog,
      winner: null,
      promotable: false,
      reason: 'no candidate traded enough on the optimise window to be ranked'
    };
  }

  const winner = seeds[0];

  // ONCE. Everything above this line has been selected against; everything
  // below it is the first honest look.
  const validate = score({
    candles, strategy, params: winner.params, symbol, options: runOptions, window: windows.validate
  }).metrics;
  const validateVerdict = evaluateThresholds(validate, thresholds, timeframe);

  const holdout = score({
    candles, strategy, params: winner.params, symbol, options: runOptions, window: windows.holdout
  }).metrics;
  const holdoutVerdict = evaluateThresholds(holdout, thresholds, timeframe);

  /**
   * Do the winner's neighbours work too?
   *
   * The question the profit factor cannot answer, and the one that separates
   * an edge from an accident. A parameter set that is excellent while
   * everything adjacent to it is bad is a spike in noise, and the market will
   * not hand us that exact spike again. One sitting in a plateau of decent
   * results is a real effect that happens to peak there.
   *
   * Measured on the optimise window, where every candidate was already
   * scored: reaching into validate for it would leak the window the verdict
   * depends on.
   */
  const top = seeds.map((s) => Number(s.optimise.profitFactor)).filter(Number.isFinite);
  const sorted = [...top].sort((a, b) => a - b);
  const robustness = {
    neighbours: top.length,
    profitFactors: top.map((v) => Number(v.toFixed(2))),
    median: sorted.length ? Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)) : null,
    // A winner far above its own neighbourhood is the shape of an outlier.
    spike: top.length > 1 && top[0] > sorted[0] * 1.5
  };

  return {
    strategyName,
    symbolId,
    symbol: symbol.broker_symbol,
    timeframe,
    trials,
    iterations: iterationLog,
    winner: {
      params: winner.candidate,
      fullParams: winner.params,
      optimise: winner.optimise,
      validate,
      holdout
    },
    validatePassed: validateVerdict.passed,
    validateFailures: validateVerdict.failures,
    holdoutPassed: holdoutVerdict.passed,
    holdoutFailures: holdoutVerdict.failures,
    // Promotion needs BOTH. Validate earned the winner a look; only the
    // holdout has never been selected against.
    promotable: validateVerdict.passed && holdoutVerdict.passed,
    robustness,
    costs: { spreadPrice, commissionPerLot: runOptions.commissionPerLot },
    windows,
    thresholds
  };
}

module.exports = { optimiseStrategy, rankKey, optimiseMinTrades, KEEP_PER_ITERATION };
