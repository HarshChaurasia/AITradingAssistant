const { ema, atr, donchian } = require('../indicators');

/**
 * Trend-following breakout.
 *
 * Long when price closes above the prior N-bar high while the fast EMA is above
 * the slow EMA. Short on the mirror image. Stop and target are ATR multiples,
 * so position size adapts to volatility rather than using a fixed pip distance.
 *
 * evaluate() is pure. prepare() exists only so indicator arrays are computed
 * once per run instead of once per bar.
 */

const defaultParams = {
  channelPeriod: 20,
  fastEma: 20,
  slowEma: 50,
  atrPeriod: 14,
  atrStopMultiple: 2.0,
  atrTargetMultiple: 3.0
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    fast: ema(closes, params.fastEma),
    slow: ema(closes, params.slowEma),
    atr: atr(candles, params.atrPeriod),
    channel: donchian(candles, params.channelPeriod)
  };
}

function evaluate(candles, index, params, context) {
  const fast = context.fast[index];
  const slow = context.slow[index];
  const atrValue = context.atr[index];
  const upper = context.channel.upper[index];
  const lower = context.channel.lower[index];

  if (fast === null || slow === null || atrValue === null || upper === null || lower === null) {
    return null;
  }
  if (atrValue <= 0) return null;

  const candle = candles[index];
  const entry = candle.close;
  const stopDistance = atrValue * params.atrStopMultiple;
  const targetDistance = atrValue * params.atrTargetMultiple;

  const features = { fast, slow, atr: atrValue, upper, lower, close: entry };

  if (fast > slow && entry > upper) {
    return {
      side: 'BUY',
      entry,
      sl: entry - stopDistance,
      tp: entry + targetDistance,
      reason: `close ${entry.toFixed(5)} broke the ${params.channelPeriod}-bar high ${upper.toFixed(5)} with EMA${params.fastEma} above EMA${params.slowEma}`,
      features
    };
  }

  if (fast < slow && entry < lower) {
    return {
      side: 'SELL',
      entry,
      sl: entry + stopDistance,
      tp: entry - targetDistance,
      reason: `close ${entry.toFixed(5)} broke the ${params.channelPeriod}-bar low ${lower.toFixed(5)} with EMA${params.fastEma} below EMA${params.slowEma}`,
      features
    };
  }

  return null;
}

module.exports = {
  name: 'trend-breakout',
  version: '1.0.0',
  defaultParams,
  prepare,
  evaluate
};
