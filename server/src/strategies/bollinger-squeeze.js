const { bollinger, atr, ema } = require('../indicators');

/**
 * Volatility-regime breakout.
 *
 * Bands narrowing means the market has gone quiet, and quiet periods tend to
 * end in a move. This waits for bandwidth to fall into the lowest part of its
 * recent range - the squeeze - and then trades the first close outside the
 * band, in the direction of the trend filter.
 *
 * What makes it different from trend-breakout is the precondition: this one
 * only fires after compression, so it is a bet on a regime change rather than
 * on the continuation of an existing move.
 */

const defaultParams = {
  period: 20,
  multiplier: 2.0,
  // A squeeze is relative: bandwidth in the lowest quartile of the last 100
  // bars. An absolute threshold cannot work across instruments whose
  // volatility differs by orders of magnitude.
  squeezeLookback: 100,
  squeezePercentile: 0.25,
  trendEma: 100,
  atrPeriod: 14,
  atrStopMultiple: 2.0,
  atrTargetMultiple: 3.0
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    bands: bollinger(closes, params.period, params.multiplier),
    trend: ema(closes, params.trendEma),
    atr: atr(candles, params.atrPeriod)
  };
}

function squeezeThreshold(bandwidth, index, params) {
  const from = Math.max(0, index - params.squeezeLookback + 1);
  const window = bandwidth.slice(from, index + 1).filter((v) => v !== null);
  if (window.length < 20) return null;

  const sorted = [...window].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * params.squeezePercentile)];
}

function readBar(candles, index, params, context) {
  const upper = context.bands.upper[index];
  const lower = context.bands.lower[index];
  const bandwidth = context.bands.bandwidth[index];
  const trend = context.trend[index];
  const atrValue = context.atr[index];

  if (upper === null || lower === null || bandwidth === null
      || trend === null || atrValue === null || atrValue <= 0) {
    return { ready: false };
  }

  const threshold = squeezeThreshold(context.bands.bandwidth, index, params);
  if (threshold === null) return { ready: false };

  const close = candles[index].close;
  return {
    ready: true,
    upper, lower, bandwidth, trend, atrValue, close, threshold,
    squeezed: bandwidth <= threshold,
    brokeUp: close > upper,
    brokeDown: close < lower,
    aboveTrend: close > trend
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready || !bar.squeezed) return null;

  const stop = bar.atrValue * params.atrStopMultiple;
  const target = bar.atrValue * params.atrTargetMultiple;
  const features = {
    upper: bar.upper, lower: bar.lower, bandwidth: bar.bandwidth,
    trend: bar.trend, atr: bar.atrValue, close: bar.close
  };

  if (bar.brokeUp && bar.aboveTrend) {
    return {
      side: 'BUY',
      entry: bar.close,
      sl: bar.close - stop,
      tp: bar.close + target,
      reason: 'squeeze broke upward with price above trend',
      features
    };
  }

  if (bar.brokeDown && !bar.aboveTrend) {
    return {
      side: 'SELL',
      entry: bar.close,
      sl: bar.close + stop,
      tp: bar.close - target,
      reason: 'squeeze broke downward with price below trend',
      features
    };
  }

  return null;
}

function explain(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);

  if (!bar.ready) {
    return {
      firing: false,
      side: null,
      reason: `warming up: needs ${Math.max(params.trendEma, params.squeezeLookback)} bars of history`,
      checks: [],
      features: {}
    };
  }

  const f = (n) => Number(n).toFixed(4);
  const p = (n) => `${(Number(n) * 100).toFixed(3)}%`;
  const features = {
    upper: bar.upper, lower: bar.lower, bandwidth: bar.bandwidth,
    trend: bar.trend, atr: bar.atrValue, close: bar.close
  };

  const wantedBreak = bar.aboveTrend ? bar.brokeUp : bar.brokeDown;
  const firing = bar.squeezed && wantedBreak;

  const checks = [
    {
      name: 'squeeze',
      passed: bar.squeezed,
      detail: bar.squeezed
        ? `bandwidth ${p(bar.bandwidth)} is inside the quietest ${params.squeezePercentile * 100}% of the last ${params.squeezeLookback} bars`
        : `bandwidth ${p(bar.bandwidth)} is above the squeeze threshold ${p(bar.threshold)} - the market is not compressed`
    },
    {
      name: 'trend_filter',
      passed: true,
      detail: `close ${f(bar.close)} ${bar.aboveTrend ? 'above' : 'below'} the ${params.trendEma}-bar EMA ${f(bar.trend)}, so ${bar.aboveTrend ? 'long' : 'short'}s only`
    },
    {
      name: 'band_break',
      passed: wantedBreak,
      detail: wantedBreak
        ? `close ${f(bar.close)} broke ${bar.brokeUp ? 'above' : 'below'} the band`
        : `close ${f(bar.close)} is inside the bands ${f(bar.lower)}-${f(bar.upper)}`
    },
    { name: 'volatility', passed: true, detail: `ATR ${f(bar.atrValue)}` }
  ];

  if (firing) {
    return {
      firing: true,
      side: bar.aboveTrend ? 'BUY' : 'SELL',
      reason: bar.aboveTrend
        ? 'long setup: a volatility squeeze broke upward in an uptrend'
        : 'short setup: a volatility squeeze broke downward in a downtrend',
      checks,
      features
    };
  }

  return {
    firing: false,
    side: null,
    reason: !bar.squeezed
      ? `no setup: no squeeze - bandwidth ${p(bar.bandwidth)} against a threshold of ${p(bar.threshold)}`
      : `no setup: squeezed, but close ${f(bar.close)} has not broken ${bar.aboveTrend ? `above ${f(bar.upper)}` : `below ${f(bar.lower)}`}`,
    checks,
    features
  };
}

module.exports = {
  name: 'bollinger-squeeze',
  version: '1.0.0',
  defaultParams,
  prepare,
  evaluate,
  explain
};
