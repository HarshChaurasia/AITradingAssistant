const { mulberry32, gaussianFrom } = require('./rng');

/**
 * Synthetic price series whose answer is known before any backtest runs.
 *
 * This is the whole reason the eval set is synthetic rather than real market
 * data. On real candles, "does this strategy have an edge?" has no ground
 * truth - that is precisely the open question, and grading an agent against an
 * answer nobody has is impossible. Here the generator DECIDES the answer and
 * then draws prices consistent with it, so every verdict can be scored exactly.
 *
 * Each generator returns hourly OHLC candles. Intrabar highs and lows come
 * from an eight-step sub-path, so a bar's range is a real excursion rather
 * than a decorative wick - the backtest resolves stops against those highs and
 * lows, and fake ranges would make stop-outs meaningless.
 */

const HOUR_MS = 3600 * 1000;
const START_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
const STEPS_PER_BAR = 8;

function formatTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function buildCandles({ bars, seed, startPrice, stepFn }) {
  const rnd = mulberry32(seed);
  const gauss = () => gaussianFrom(rnd);
  const state = {};

  let price = startPrice;
  const candles = [];

  for (let i = 0; i < bars; i += 1) {
    const open = price;
    let high = open;
    let low = open;

    for (let s = 0; s < STEPS_PER_BAR; s += 1) {
      price = stepFn({ price, gauss, rnd, bar: i, state });
      if (price > high) high = price;
      if (price < low) low = price;
    }

    candles.push({
      open_time: formatTime(START_MS + i * HOUR_MS),
      open,
      high,
      low,
      close: price,
      volume: 0
    });
  }

  return candles;
}

/**
 * A driftless random walk. Increments are independent, so no rule that reads
 * only past prices can have positive expectancy - and once costs are charged,
 * expectancy is strictly negative. Ground truth: NO edge.
 */
function randomWalk({ bars, seed, startPrice = 1.1, sigma = 0.00035 }) {
  return buildCandles({
    bars,
    seed,
    startPrice,
    stepFn: ({ price, gauss }) => price * (1 + sigma * gauss())
  });
}

/**
 * Regime-switching drift: long stretches of persistent direction, so a
 * breakout that enters with the trend keeps being carried by it. The drift is
 * set well above the per-bar noise, and the resulting move well above the
 * spread, so the edge survives realistic costs. Ground truth: EDGE.
 */
function plantedMomentum({
  bars, seed, startPrice = 1.1, sigma = 0.0002, drift = 0.00008,
  minRegime = 160, maxRegime = 360
}) {
  return buildCandles({
    bars,
    seed,
    startPrice,
    stepFn: ({ price, gauss, rnd, bar, state }) => {
      if (state.until === undefined || bar >= state.until) {
        state.until = bar + Math.floor(minRegime + rnd() * (maxRegime - minRegime));
        state.direction = rnd() < 0.5 ? -1 : 1;
      }
      const mu = (state.direction * drift) / STEPS_PER_BAR;
      return price * (1 + mu + sigma * gauss());
    }
  });
}

/**
 * A real edge that is too small to survive a real broker.
 *
 * Same regime-switching drift as plantedMomentum, but weak: the strategy
 * genuinely predicts direction, and at zero cost it makes money. The move it
 * captures is simply smaller than the spread, slippage and commission charged
 * to capture it. Ground truth: NO edge.
 *
 * This is the case that separates an agent which actually charges costs from
 * one that reads a rising equity curve and calls it an edge. It is also the
 * most common way a real strategy dies: the signal is correct and the account
 * still shrinks.
 */
function costTrap({ bars, seed, startPrice = 1.1, sigma = 0.0002, drift = 0.00005 }) {
  return plantedMomentum({ bars, seed, startPrice, sigma, drift });
}

/**
 * Structure in the first half, none in the second. A parameter search on the
 * in-sample half finds settings that look excellent; out-of-sample they are
 * fitting noise. Ground truth: NO edge.
 *
 * The join is continuous - the walk starts from wherever the trending half
 * ended - so there is no discontinuity marking the split for the agent.
 */
function overfitTrap({ bars, seed, startPrice = 1.1, sigma = 0.0003, drift = 0.0003 }) {
  const half = Math.floor(bars / 2);
  const inSample = plantedMomentum({
    bars: half, seed, startPrice, sigma, drift, minRegime: 60, maxRegime: 140
  });
  const outOfSample = randomWalk({
    bars: bars - half,
    seed: seed + 7919,
    startPrice: inSample[inSample.length - 1].close,
    sigma
  });

  return inSample.concat(outOfSample.map((candle, i) => ({
    ...candle,
    open_time: formatTime(START_MS + (half + i) * HOUR_MS)
  })));
}

module.exports = { randomWalk, plantedMomentum, costTrap, overfitTrap, buildCandles };
