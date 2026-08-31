const { atr, ema } = require('../indicators');

/**
 * Scalp: fade a stretch away from the short mean.
 *
 * Price runs several ATR from a short moving average in a handful of bars,
 * then prints a bar that closes back toward it. The trade is the snap back to
 * the mean, held for a few bars only.
 *
 * The deliberate opposite of micro-breakout, and paired with it for that
 * reason. The live book lost money because six strategies all bought strength
 * at the same moment; a scalping pair where one buys the burst and the other
 * fades the exhaustion cannot both fire on the same bar in the same direction.
 *
 * Two guards stop this becoming the classic "catching a falling knife":
 *
 *   1. The stretch must be genuine - measured in ATR, not in bars.
 *   2. The bar must have already turned. Entering while price is still
 *      extending is how a fade becomes an unlimited loss, so this requires a
 *      close back in the direction of the mean before it acts.
 *
 * Restricted to M5 and above for the same cost reason as micro-breakout: on
 * this account EURUSD M1 has a spread two and a half times the median bar
 * range, and no fade can out-trade that.
 */

const defaultParams = {
  meanEma: 20,
  atrPeriod: 14,
  // How far from the mean counts as stretched.
  minStretchAtr: 1.8,
  // ...and beyond this it is a trend, not a stretch, so stay out.
  maxStretchAtr: 5.0,
  atrStopMultiple: 1.2,
  // The target is the mean itself, capped so a very extended move does not
  // imply an unrealistic reward.
  atrTargetMultiple: 1.5,
  // Half an hour on M5.
  maxHoldBars: 6
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    mean: ema(closes, params.meanEma),
    atr: atr(candles, params.atrPeriod)
  };
}

function readBar(candles, index, params, context) {
  const atrValue = context.atr[index];
  const mean = context.mean[index];

  if (atrValue === null || atrValue <= 0 || mean === null || index < 1) {
    return { ready: false };
  }

  const candle = candles[index];
  const previous = candles[index - 1];
  const distance = candle.close - mean;
  const stretch = Math.abs(distance) / atrValue;

  // "Turned" means this bar closed back toward the mean relative to the last.
  // Without it the strategy would be entering while price is still extending.
  const turnedDown = candle.close < previous.close;
  const turnedUp = candle.close > previous.close;

  return {
    ready: true,
    candle,
    atrValue,
    mean,
    close: candle.close,
    distance,
    stretch,
    above: distance > 0,
    inBand: stretch >= params.minStretchAtr && stretch <= params.maxStretchAtr,
    turnedDown,
    turnedUp
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready) return null;

  const stop = bar.atrValue * params.atrStopMultiple;
  const cap = bar.atrValue * params.atrTargetMultiple;
  const features = {
    atr: bar.atrValue, mean: bar.mean, stretch: bar.stretch, close: bar.close
  };

  // Stretched ABOVE the mean and turning down: sell the snap back.
  if (bar.above && bar.inBand && bar.turnedDown) {
    const toMean = bar.close - bar.mean;
    return {
      side: 'SELL',
      entry: bar.close,
      sl: bar.close + stop,
      tp: bar.close - Math.min(toMean, cap),
      reason: `stretched ${bar.stretch.toFixed(2)} ATR above the ${params.meanEma}-bar mean and turning down`,
      features
    };
  }

  if (!bar.above && bar.inBand && bar.turnedUp) {
    const toMean = bar.mean - bar.close;
    return {
      side: 'BUY',
      entry: bar.close,
      sl: bar.close - stop,
      tp: bar.close + Math.min(toMean, cap),
      reason: `stretched ${bar.stretch.toFixed(2)} ATR below the ${params.meanEma}-bar mean and turning up`,
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
      reason: `warming up: needs ${params.meanEma} bars`,
      checks: [],
      features: {}
    };
  }

  const f = (n) => Number(n).toFixed(4);
  const features = {
    atr: bar.atrValue, mean: bar.mean, stretch: bar.stretch, close: bar.close
  };

  const turned = bar.above ? bar.turnedDown : bar.turnedUp;

  const checks = [
    {
      name: 'stretched_from_mean',
      passed: bar.inBand,
      detail: `${bar.stretch.toFixed(2)} ATR ${bar.above ? 'above' : 'below'} the mean ${f(bar.mean)}, wanted ${params.minStretchAtr}-${params.maxStretchAtr}`
    },
    {
      name: 'bar_has_turned',
      passed: turned,
      detail: turned
        ? `closed back ${bar.above ? 'down' : 'up'} toward the mean`
        : `still extending ${bar.above ? 'up' : 'down'} - entering now is catching a falling knife`
    },
    {
      name: 'time_stop',
      passed: true,
      detail: `closed after ${params.maxHoldBars} bars whatever price is doing`
    }
  ];

  const firing = bar.inBand && turned;
  return {
    firing,
    side: firing ? (bar.above ? 'SELL' : 'BUY') : null,
    reason: firing
      ? `${bar.above ? 'short' : 'long'} scalp: fading a ${bar.stretch.toFixed(2)} ATR stretch back to the mean`
      : `no setup: ${checks.filter((c) => !c.passed).map((c) => c.name.replace(/_/g, ' ')).join(', ') || 'conditions unmet'}`,
    checks,
    features
  };
}

module.exports = {
  name: 'stretch-fade',
  version: '1.0.0',
  kind: 'scalp',
  timeframes: ['M5', 'M15'],
  defaultParams,
  prepare,
  evaluate,
  explain
};
