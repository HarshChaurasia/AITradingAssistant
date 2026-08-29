const { superTrend, atr, ema } = require('../indicators');

/**
 * SuperTrend flip, filtered by a slow EMA.
 *
 * SuperTrend is an ATR-trailing stop that flips side when price closes through
 * it. Trading the flip is a well-worn retail approach; the EMA filter is added
 * because the raw version flips constantly in a range.
 *
 * The flip is a two-bar comparison, so this reads bar i and i-1 - both past.
 */

const defaultParams = {
  atrPeriod: 10,
  multiplier: 3.0,
  trendEma: 100,
  stopAtrPeriod: 14,
  atrStopMultiple: 2.0,
  atrTargetMultiple: 3.0
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    st: superTrend(candles, params.atrPeriod, params.multiplier),
    trend: ema(closes, params.trendEma),
    atr: atr(candles, params.stopAtrPeriod)
  };
}

function readBar(candles, index, params, context) {
  const dir = context.st.trend[index];
  const prevDir = index > 0 ? context.st.trend[index - 1] : null;
  const band = context.st.band[index];
  const trend = context.trend[index];
  const atrValue = context.atr[index];

  if (dir === null || prevDir === null || band === null
      || trend === null || atrValue === null || atrValue <= 0) {
    return { ready: false };
  }

  const close = candles[index].close;
  return {
    ready: true,
    dir, prevDir, band, trend, atrValue, close,
    flippedUp: prevDir === -1 && dir === 1,
    flippedDown: prevDir === 1 && dir === -1,
    aboveTrend: close > trend
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready) return null;

  const stop = bar.atrValue * params.atrStopMultiple;
  const target = bar.atrValue * params.atrTargetMultiple;
  const features = {
    direction: bar.dir, band: bar.band, trend: bar.trend, atr: bar.atrValue, close: bar.close
  };

  if (bar.flippedUp && bar.aboveTrend) {
    return {
      side: 'BUY',
      entry: bar.close,
      sl: bar.close - stop,
      tp: bar.close + target,
      reason: 'SuperTrend flipped up with price above the trend filter',
      features
    };
  }

  if (bar.flippedDown && !bar.aboveTrend) {
    return {
      side: 'SELL',
      entry: bar.close,
      sl: bar.close + stop,
      tp: bar.close - target,
      reason: 'SuperTrend flipped down with price below the trend filter',
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
      reason: `warming up: needs ${params.trendEma} bars of history`,
      checks: [],
      features: {}
    };
  }

  const f = (n) => Number(n).toFixed(4);
  const features = {
    direction: bar.dir, band: bar.band, trend: bar.trend, atr: bar.atrValue, close: bar.close
  };
  const flipped = bar.flippedUp || bar.flippedDown;
  const wantedFlip = bar.aboveTrend ? bar.flippedUp : bar.flippedDown;

  const checks = [
    {
      name: 'trend_filter',
      passed: true,
      detail: `close ${f(bar.close)} ${bar.aboveTrend ? 'above' : 'below'} the ${params.trendEma}-bar EMA ${f(bar.trend)}, so ${bar.aboveTrend ? 'long' : 'short'}s only`
    },
    {
      name: 'supertrend_flip',
      passed: wantedFlip,
      detail: flipped
        ? `SuperTrend flipped ${bar.flippedUp ? 'up' : 'down'} this bar`
        : `SuperTrend is still ${bar.dir === 1 ? 'up' : 'down'}, trailing at ${f(bar.band)} (${f(Math.abs(bar.close - bar.band))} away)`
    },
    { name: 'volatility', passed: true, detail: `ATR ${f(bar.atrValue)}` }
  ];

  if (wantedFlip) {
    return {
      firing: true,
      side: bar.aboveTrend ? 'BUY' : 'SELL',
      reason: bar.aboveTrend
        ? 'long setup: SuperTrend flipped up in an uptrend'
        : 'short setup: SuperTrend flipped down in a downtrend',
      checks,
      features
    };
  }

  return {
    firing: false,
    side: null,
    reason: flipped
      ? `no setup: SuperTrend flipped ${bar.flippedUp ? 'up' : 'down'}, but the trend filter only allows ${bar.aboveTrend ? 'long' : 'short'}s`
      : `no setup: SuperTrend still ${bar.dir === 1 ? 'up' : 'down'}, price ${f(bar.close)} is ${f(Math.abs(bar.close - bar.band))} from the ${f(bar.band)} trail`,
    checks,
    features
  };
}

module.exports = {
  name: 'supertrend',
  version: '1.0.0',
  defaultParams,
  prepare,
  evaluate,
  explain
};
