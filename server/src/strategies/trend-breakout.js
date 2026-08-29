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

/**
 * Why a signal did or did not fire, for the scanner.
 *
 * evaluate() is deliberately untouched by this - the backtest depends on it
 * exactly as it is. The agreement between the two is pinned by a test that
 * walks every bar of a fixture and asserts explain().firing matches whether
 * evaluate() returned a signal.
 */
function explain(candles, index, params, context) {
  const fast = context.fast[index];
  const slow = context.slow[index];
  const atrValue = context.atr[index];
  const upper = context.channel.upper[index];
  const lower = context.channel.lower[index];

  if (fast === null || slow === null || atrValue === null || upper === null || lower === null) {
    return {
      firing: false,
      side: null,
      reason: `warming up: needs ${Math.max(params.slowEma, params.channelPeriod, params.atrPeriod)} bars of history`,
      checks: [],
      features: {}
    };
  }

  const entry = candles[index].close;
  const features = { fast, slow, atr: atrValue, upper, lower, close: entry };
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

  const uptrend = fast > slow;
  const brokeUp = entry > upper;
  const brokeDown = entry < lower;

  if (uptrend && brokeUp) {
    return {
      firing: true,
      side: 'BUY',
      reason: `long setup: close ${f(entry)} broke the ${params.channelPeriod}-bar high ${f(upper)} in an uptrend`,
      checks: [
        { name: 'trend_filter', passed: true, detail: `EMA${params.fastEma} ${f(fast)} above EMA${params.slowEma} ${f(slow)}` },
        { name: 'channel_breakout', passed: true, detail: `close ${f(entry)} above the ${params.channelPeriod}-bar high ${f(upper)}` },
        { name: 'volatility', passed: true, detail: `ATR ${f(atrValue)} gives a ${f(atrValue * params.atrStopMultiple)} stop` }
      ],
      features
    };
  }

  if (!uptrend && brokeDown) {
    return {
      firing: true,
      side: 'SELL',
      reason: `short setup: close ${f(entry)} broke the ${params.channelPeriod}-bar low ${f(lower)} in a downtrend`,
      checks: [
        { name: 'trend_filter', passed: true, detail: `EMA${params.fastEma} ${f(fast)} below EMA${params.slowEma} ${f(slow)}` },
        { name: 'channel_breakout', passed: true, detail: `close ${f(entry)} below the ${params.channelPeriod}-bar low ${f(lower)}` },
        { name: 'volatility', passed: true, detail: `ATR ${f(atrValue)} gives a ${f(atrValue * params.atrStopMultiple)} stop` }
      ],
      features
    };
  }

  // Not firing: say which half of the setup is missing, and by how much.
  const wanted = uptrend ? 'long' : 'short';
  const barrier = uptrend ? upper : lower;
  const distance = Math.abs(barrier - entry);

  return {
    firing: false,
    side: null,
    reason: uptrend
      ? `no setup: uptrend favours longs, but close ${f(entry)} is ${f(distance)} below the ${params.channelPeriod}-bar high ${f(upper)}`
      : `no setup: downtrend favours shorts, but close ${f(entry)} is ${f(distance)} above the ${params.channelPeriod}-bar low ${f(lower)}`,
    checks: [
      {
        name: 'trend_filter',
        passed: true,
        detail: `EMA${params.fastEma} ${f(fast)} ${uptrend ? 'above' : 'below'} EMA${params.slowEma} ${f(slow)}, so ${wanted}s only`
      },
      {
        name: 'channel_breakout',
        passed: false,
        detail: uptrend
          ? `close ${f(entry)} has not cleared the ${params.channelPeriod}-bar high ${f(upper)} (${f(distance)} away)`
          : `close ${f(entry)} has not broken the ${params.channelPeriod}-bar low ${f(lower)} (${f(distance)} away)`
      },
      { name: 'volatility', passed: true, detail: `ATR ${f(atrValue)}` }
    ],
    features
  };
}

module.exports = {
  name: 'trend-breakout',
  version: '1.0.0',
  defaultParams,
  prepare,
  evaluate,
  explain
};
