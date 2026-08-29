const { ema, macd, atr } = require('../indicators');

/**
 * MACD crossover, filtered by a long-term trend.
 *
 * Long when the MACD line crosses up through its signal line while price is
 * above the trend EMA; short on the mirror image. The trend filter is what
 * separates this from the textbook version, which whipsaws badly in ranges
 * because it takes every crossover regardless of context.
 *
 * A crossover is a two-bar event, so this reads bar i and i-1. That is not
 * lookahead - both are in the past.
 */

const defaultParams = {
  fastPeriod: 12,
  slowPeriod: 26,
  signalPeriod: 9,
  trendEma: 200,
  atrPeriod: 14,
  atrStopMultiple: 2.0,
  atrTargetMultiple: 3.0
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    macd: macd(closes, params.fastPeriod, params.slowPeriod, params.signalPeriod),
    trend: ema(closes, params.trendEma),
    atr: atr(candles, params.atrPeriod)
  };
}

function readBar(candles, index, params, context) {
  const line = context.macd.line[index];
  const signal = context.macd.signal[index];
  const prevLine = index > 0 ? context.macd.line[index - 1] : null;
  const prevSignal = index > 0 ? context.macd.signal[index - 1] : null;
  const trend = context.trend[index];
  const atrValue = context.atr[index];

  const ready = line !== null && signal !== null && prevLine !== null
    && prevSignal !== null && trend !== null && atrValue !== null && atrValue > 0;

  if (!ready) return { ready: false };

  const close = candles[index].close;
  return {
    ready: true,
    line, signal, prevLine, prevSignal, trend, atrValue, close,
    crossedUp: prevLine <= prevSignal && line > signal,
    crossedDown: prevLine >= prevSignal && line < signal,
    aboveTrend: close > trend
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready) return null;

  const stop = bar.atrValue * params.atrStopMultiple;
  const target = bar.atrValue * params.atrTargetMultiple;
  const features = {
    macd: bar.line, signal: bar.signal, trend: bar.trend, atr: bar.atrValue, close: bar.close
  };

  if (bar.crossedUp && bar.aboveTrend) {
    return {
      side: 'BUY',
      entry: bar.close,
      sl: bar.close - stop,
      tp: bar.close + target,
      reason: `MACD crossed above its signal with price over the ${params.trendEma}-bar trend`,
      features
    };
  }

  if (bar.crossedDown && !bar.aboveTrend) {
    return {
      side: 'SELL',
      entry: bar.close,
      sl: bar.close + stop,
      tp: bar.close - target,
      reason: `MACD crossed below its signal with price under the ${params.trendEma}-bar trend`,
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
    macd: bar.line, signal: bar.signal, trend: bar.trend, atr: bar.atrValue, close: bar.close
  };
  const crossed = bar.crossedUp || bar.crossedDown;
  const direction = bar.aboveTrend ? 'long' : 'short';
  const wantedCross = bar.aboveTrend ? bar.crossedUp : bar.crossedDown;

  const checks = [
    {
      name: 'trend_filter',
      passed: true,
      detail: `close ${f(bar.close)} ${bar.aboveTrend ? 'above' : 'below'} the ${params.trendEma}-bar EMA ${f(bar.trend)}, so ${direction}s only`
    },
    {
      name: 'macd_cross',
      passed: wantedCross,
      detail: crossed
        ? `MACD crossed ${bar.crossedUp ? 'up' : 'down'} through its signal (${f(bar.line)} vs ${f(bar.signal)})`
        : `no cross this bar: MACD ${f(bar.line)} is ${bar.line > bar.signal ? 'above' : 'below'} its signal ${f(bar.signal)} and stayed there`
    },
    { name: 'volatility', passed: true, detail: `ATR ${f(bar.atrValue)}` }
  ];

  if (wantedCross) {
    return {
      firing: true,
      side: bar.aboveTrend ? 'BUY' : 'SELL',
      reason: bar.aboveTrend
        ? 'long setup: MACD crossed above its signal in an uptrend'
        : 'short setup: MACD crossed below its signal in a downtrend',
      checks,
      features
    };
  }

  return {
    firing: false,
    side: null,
    reason: crossed
      ? `no setup: MACD crossed ${bar.crossedUp ? 'up' : 'down'}, but the trend filter only allows ${direction}s`
      : `no setup: waiting for a MACD cross ${bar.aboveTrend ? 'up' : 'down'} through the signal line (gap ${f(Math.abs(bar.line - bar.signal))})`,
    checks,
    features
  };
}

module.exports = {
  name: 'macd-trend',
  version: '1.0.0',
  defaultParams,
  prepare,
  evaluate,
  explain
};
