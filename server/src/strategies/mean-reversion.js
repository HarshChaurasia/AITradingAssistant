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

module.exports = {
  name: 'mean-reversion',
  version: '1.0.0',
  defaultParams,
  prepare,
  evaluate
};
