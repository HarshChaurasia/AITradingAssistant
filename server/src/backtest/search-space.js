const { getStrategy } = require('../strategies/registry');

/**
 * What a parameter search is allowed to vary, and between what bounds.
 *
 * Kept out of the strategy files on purpose. A strategy's defaultParams are a
 * claim about how it should be traded; a search space is a claim about what is
 * worth trying, and the second changes far more often than the first. Mixing
 * them would mean editing a strategy every time we wanted to look somewhere
 * new.
 *
 * Two rules govern every entry here:
 *
 * 1. Only parameters with a MECHANISM behind them. Widening a stop changes
 *    how often price reaches it, which is a reason. Sweeping an RSI period
 *    from 13 to 15 because 14 failed is not a reason, it is a lottery ticket,
 *    and the more tickets we buy the likelier one wins by accident.
 * 2. Bounds a human would defend. A 0.2x ATR stop is inside the spread on
 *    every instrument here, so including it only adds a candidate that cannot
 *    work but can still get lucky.
 */

// Stop and target multiples appear in almost every strategy and are the two
// that matter most: the live book's average winner is 1.50R against a 22% hit
// rate, which needs 3.55R to break even. Whether a wider target fixes that is
// exactly the question a search should answer.
const EXITS = {
  atrStopMultiple: [1.0, 1.5, 2.0, 2.5, 3.0],
  atrTargetMultiple: [1.5, 2.5, 3.5, 4.5, 6.0]
};

const SPACES = {
  'trend-breakout': {
    ...EXITS,
    channelPeriod: [10, 20, 40],
    slowEma: [100, 200]
  },
  supertrend: {
    ...EXITS,
    multiplier: [2, 3, 4],
    atrPeriod: [7, 10, 14]
  },
  'macd-trend': {
    ...EXITS,
    trendEma: [100, 200]
  },
  'ma-crossover': {
    ...EXITS,
    fastEma: [20, 50],
    slowEma: [100, 200]
  },
  'bollinger-squeeze': {
    ...EXITS,
    squeezePercentile: [0.15, 0.25, 0.4],
    multiplier: [2, 2.5]
  },
  'mean-reversion': {
    ...EXITS,
    oversold: [20, 25, 30],
    overbought: [70, 75, 80]
  },
  'rsi-divergence': {
    ...EXITS,
    swingLookback: [3, 5],
    oversold: [30, 40],
    overbought: [60, 70]
  },
  'smart-money': {
    ...EXITS,
    bosMaxAge: [10, 20, 40],
    requireGapTouch: [true, false]
  },
  'liquidity-sweep': {
    ...EXITS,
    maxPierceAtr: [1.0, 1.5, 2.5],
    swingLookback: [3, 5],
    requireTrendAlignment: [true, false]
  },
  'volume-thrust': {
    ...EXITS,
    // The two numbers that define what counts as participation. Both have a
    // mechanism: a lower multiple fires more often on ordinary bars, a higher
    // body fraction demands a more decisive close.
    volumeMultiple: [1.5, 2.0, 3.0],
    minBodyFraction: [0.4, 0.6, 0.75]
  },
  'session-breakout': {
    ...EXITS,
    // How much range to build before a break counts, and how long the setup
    // stays live afterwards. The session hour is deliberately NOT searched:
    // sweeping it would find whichever hour happened to work on this data,
    // which is the definition of fitting the sample.
    openingBars: [2, 4, 8],
    windowBars: [8, 16, 32],
    breakBuffer: [0, 0.1, 0.25]
  },
  // The scalps hold on a clock as well as on price, so the clock is part of
  // the search: a strategy exiting mostly on time is not reaching its target,
  // and the fix is either more time or a nearer target.
  'micro-breakout': {
    atrStopMultiple: [0.8, 1.0, 1.5],
    atrTargetMultiple: [1.0, 1.5, 2.5, 3.5],
    maxHoldBars: [6, 12, 24],
    burstMultiple: [1.3, 1.6, 2.0]
  },
  'stretch-fade': {
    atrStopMultiple: [1.0, 1.2, 1.8],
    atrTargetMultiple: [1.0, 1.5, 2.5, 3.5],
    maxHoldBars: [6, 12, 24],
    minStretchAtr: [1.5, 1.8, 2.5]
  }
};

/**
 * The space for a strategy, restricted to keys it actually has.
 *
 * A search that sets a parameter the strategy ignores looks like it explored
 * fifty candidates when it explored ten, each evaluated five times - and the
 * trial count is the number that tells us whether a pass was luck.
 */
function searchSpaceFor(strategyName) {
  const space = SPACES[strategyName];
  if (!space) return null;

  const strategy = getStrategy(strategyName);
  const defaults = strategy.defaultParams || {};

  const filtered = {};
  for (const [key, values] of Object.entries(space)) {
    if (key in defaults) filtered[key] = values;
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

/**
 * Every combination in a space.
 *
 * Returned in full rather than sampled: the count IS the multiple-testing
 * exposure, and a caller that cannot afford it should narrow the space rather
 * than quietly test a random subset and report the smaller number.
 */
function expand(space) {
  const keys = Object.keys(space);
  let combos = [{}];

  for (const key of keys) {
    const next = [];
    for (const combo of combos) {
      for (const value of space[key]) next.push({ ...combo, [key]: value });
    }
    combos = next;
  }
  return combos;
}

/**
 * A tighter space around one result, for a later iteration.
 *
 * Numeric parameters get their immediate neighbours in the original list;
 * everything else is pinned to what won. This is what makes iterating cheap:
 * the first pass is broad and the ones after it are local, so the trial count
 * grows slowly instead of multiplying.
 */
function neighbourhood(space, winner) {
  const refined = {};

  for (const [key, values] of Object.entries(space)) {
    const index = values.indexOf(winner[key]);
    if (index === -1) {
      refined[key] = [winner[key]];
      continue;
    }

    const neighbours = [values[index - 1], values[index], values[index + 1]]
      .filter((v) => v !== undefined);

    // Between two numeric neighbours there is a midpoint worth trying; between
    // two booleans there is nothing, and inventing one would be nonsense.
    const numeric = neighbours.every((v) => typeof v === 'number');
    if (numeric && neighbours.length > 1) {
      const midpoints = [];
      for (let i = 0; i < neighbours.length - 1; i += 1) {
        const mid = Number(((neighbours[i] + neighbours[i + 1]) / 2).toFixed(4));
        if (!neighbours.includes(mid)) midpoints.push(mid);
      }
      refined[key] = [...neighbours, ...midpoints].sort((a, b) => a - b);
    } else {
      refined[key] = neighbours;
    }
  }

  return refined;
}

module.exports = { SPACES, searchSpaceFor, expand, neighbourhood };
