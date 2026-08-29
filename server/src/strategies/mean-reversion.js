const { ema, rsi, atr } = require('../indicators');

/**
 * Counter-trend entry, with-trend bias.
 *
 * Buys an oversold RSI reading only while price is above a slow trend EMA, and
 * sells an overbought reading only while below it. Fading a move without a
 * trend filter is how mean reversion turns into catching a falling knife.
 *
 * The slow EMA stands in for a higher-timeframe trend filter: it keeps the
 * strategy dependent on a single candle series, which keeps evaluate() pure
 * and the backtest exactly reproducible.
 */

const defaultParams = {
  rsiPeriod: 14,
  oversold: 30,
  overbought: 70,
  trendEma: 100,
  atrPeriod: 14,
  atrStopMultiple: 1.5,
  atrTargetMultiple: 2.0
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    rsi: rsi(closes, params.rsiPeriod),
    trend: ema(closes, params.trendEma),
    atr: atr(candles, params.atrPeriod)
  };
}

function evaluate(candles, index, params, context) {
  const rsiValue = context.rsi[index];
  const trend = context.trend[index];
  const atrValue = context.atr[index];

  if (rsiValue === null || trend === null || atrValue === null) return null;
  if (atrValue <= 0) return null;

  const entry = candles[index].close;
  const stopDistance = atrValue * params.atrStopMultiple;
  const targetDistance = atrValue * params.atrTargetMultiple;
  const features = { rsi: rsiValue, trend, atr: atrValue, close: entry };

  if (entry > trend && rsiValue <= params.oversold) {
    return {
      side: 'BUY',
      entry,
      sl: entry - stopDistance,
      tp: entry + targetDistance,
      reason: `RSI ${rsiValue.toFixed(1)} oversold while price holds above the ${params.trendEma}-bar trend`,
      features
    };
  }

  if (entry < trend && rsiValue >= params.overbought) {
    return {
      side: 'SELL',
      entry,
      sl: entry + stopDistance,
      tp: entry - targetDistance,
      reason: `RSI ${rsiValue.toFixed(1)} overbought while price stays below the ${params.trendEma}-bar trend`,
      features
    };
  }

  return null;
}

/**
 * Why a signal did or did not fire, for the scanner.
 *
 * evaluate() is untouched. A test walks every bar of a fixture asserting the
 * two agree, so this can never quietly drift from what the system actually
 * does.
 */
function explain(candles, index, params, context) {
  const rsiValue = context.rsi[index];
  const trend = context.trend[index];
  const atrValue = context.atr[index];

  if (rsiValue === null || trend === null || atrValue === null) {
    return {
      firing: false,
      side: null,
      reason: `warming up: needs ${Math.max(params.trendEma, params.rsiPeriod, params.atrPeriod)} bars of history`,
      checks: [],
      features: {}
    };
  }

  const entry = candles[index].close;
  const features = { rsi: rsiValue, trend, atr: atrValue, close: entry };
  const f = (n) => Number(n).toFixed(2);

  if (atrValue <= 0) {
    return {
      firing: false,
      side: null,
      reason: 'no volatility: ATR is zero, so no stop distance can be derived',
      checks: [{ name: 'volatility', passed: false, detail: 'ATR is zero' }],
      features
    };
  }

  const aboveTrend = entry > trend;
  const oversold = rsiValue <= params.oversold;
  const overbought = rsiValue >= params.overbought;

  if (aboveTrend && oversold) {
    return {
      firing: true,
      side: 'BUY',
      reason: `long setup: RSI ${f(rsiValue)} oversold while price holds above the ${params.trendEma}-bar trend`,
      checks: [
        { name: 'trend_filter', passed: true, detail: `close ${f(entry)} above the ${params.trendEma}-bar EMA ${f(trend)}` },
        { name: 'rsi_extreme', passed: true, detail: `RSI ${f(rsiValue)} at or below the oversold level ${params.oversold}` },
        { name: 'volatility', passed: true, detail: `ATR ${f(atrValue)}` }
      ],
      features
    };
  }

  if (!aboveTrend && overbought) {
    return {
      firing: true,
      side: 'SELL',
      reason: `short setup: RSI ${f(rsiValue)} overbought while price stays below the ${params.trendEma}-bar trend`,
      checks: [
        { name: 'trend_filter', passed: true, detail: `close ${f(entry)} below the ${params.trendEma}-bar EMA ${f(trend)}` },
        { name: 'rsi_extreme', passed: true, detail: `RSI ${f(rsiValue)} at or above the overbought level ${params.overbought}` },
        { name: 'volatility', passed: true, detail: `ATR ${f(atrValue)}` }
      ],
      features
    };
  }

  // Not firing. The trend filter decides which extreme is even eligible, so
  // say which one is being waited for and how far away it is.
  const wantedLevel = aboveTrend ? params.oversold : params.overbought;
  const gap = Math.abs(rsiValue - wantedLevel);

  return {
    firing: false,
    side: null,
    reason: aboveTrend
      ? `no setup: price is above trend so only oversold longs qualify, and RSI ${f(rsiValue)} is ${f(gap)} above the ${params.oversold} threshold`
      : `no setup: price is below trend so only overbought shorts qualify, and RSI ${f(rsiValue)} is ${f(gap)} below the ${params.overbought} threshold`,
    checks: [
      {
        name: 'trend_filter',
        passed: true,
        detail: `close ${f(entry)} ${aboveTrend ? 'above' : 'below'} the ${params.trendEma}-bar EMA ${f(trend)}, so ${aboveTrend ? 'long' : 'short'}s only`
      },
      {
        name: 'rsi_extreme',
        passed: false,
        detail: aboveTrend
          ? `RSI ${f(rsiValue)} has not reached the oversold level ${params.oversold}`
          : `RSI ${f(rsiValue)} has not reached the overbought level ${params.overbought}`
      },
      { name: 'volatility', passed: true, detail: `ATR ${f(atrValue)}` }
    ],
    features
  };
}

module.exports = {
  name: 'mean-reversion',
  version: '1.0.0',
  defaultParams,
  prepare,
  evaluate,
  explain
};
