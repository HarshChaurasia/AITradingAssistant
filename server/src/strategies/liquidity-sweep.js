const { swings, atr, ema } = require('../indicators');

/**
 * Liquidity sweep: the stop hunt, taken from the other side.
 *
 * A cluster of stop orders sits just beyond every obvious swing low. When
 * price wicks through that level and then closes back above it, the move
 * through was not a breakdown - it was those stops being filled, and the
 * sellers who triggered them are now trapped.
 *
 * Deliberately the mirror image of trend-breakout. That strategy buys the
 * close through a level; this one buys the failure of exactly that break. The
 * two disagree by construction, which is the point: the existing book is six
 * strategies that all fire long together, and correlated agreement is what
 * turned one adverse move into seven simultaneous losers.
 *
 * The distinction that makes it work is wick versus close. A bar that closes
 * beyond the level is a break and this stays out; a bar that pierces it and
 * closes back inside is the sweep.
 */

const defaultParams = {
  swingLookback: 3,
  // The wick must clear the level by at least this fraction of ATR, or every
  // bar that grazes a swing low counts as a sweep.
  minPiercAtr: 0.1,
  // ...and not by more than this, past which it is a genuine breakdown rather
  // than a sweep.
  maxPierceAtr: 1.5,
  // Reject a sweep older than this many bars: the reclaim has to be prompt.
  maxSweepAge: 3,
  trendEma: 200,
  // Unlike the trend strategies this one is allowed to trade against the EMA,
  // because a sweep is a reversal signal. Set true to require alignment.
  requireTrendAlignment: false,
  atrPeriod: 14,
  atrStopMultiple: 1.0,
  atrTargetMultiple: 2.5
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    swings: swings(candles, params.swingLookback),
    atr: atr(candles, params.atrPeriod),
    trend: ema(closes, params.trendEma)
  };
}

/**
 * Look back for a bar that pierced the level and closed back inside it.
 *
 * Only bars at or before `index` are read, and the swing level itself was
 * confirmed before any of them.
 */
function findSweep({ candles, index, level, direction, atrValue, params }) {
  if (!level) return null;
  const from = Math.max(level.index + 1, index - params.maxSweepAge + 1);

  for (let i = index; i >= from; i -= 1) {
    const bar = candles[i];
    if (direction === 'low') {
      const pierce = level.price - bar.low;
      const reclaimed = bar.close > level.price;
      if (reclaimed && pierce >= atrValue * params.minPiercAtr
          && pierce <= atrValue * params.maxPierceAtr) {
        return { index: i, pierce, level: level.price, low: bar.low };
      }
    } else {
      const pierce = bar.high - level.price;
      const reclaimed = bar.close < level.price;
      if (reclaimed && pierce >= atrValue * params.minPiercAtr
          && pierce <= atrValue * params.maxPierceAtr) {
        return { index: i, pierce, level: level.price, high: bar.high };
      }
    }
  }
  return null;
}

function readBar(candles, index, params, context) {
  const atrValue = context.atr[index];
  const trend = context.trend[index];
  const swingHigh = context.swings.highs[index];
  const swingLow = context.swings.lows[index];

  if (atrValue === null || atrValue <= 0 || trend === null || !swingHigh || !swingLow) {
    return { ready: false };
  }

  const candle = candles[index];
  return {
    ready: true,
    candle,
    atrValue,
    trend,
    close: candle.close,
    aboveTrend: candle.close > trend,
    swingHigh,
    swingLow,
    lowSweep: findSweep({ candles, index, level: swingLow, direction: 'low', atrValue, params }),
    highSweep: findSweep({ candles, index, level: swingHigh, direction: 'high', atrValue, params })
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready) return null;

  const target = bar.atrValue * params.atrTargetMultiple;
  const buffer = bar.atrValue * params.atrStopMultiple;
  const features = {
    atr: bar.atrValue,
    trend: bar.trend,
    swingHigh: bar.swingHigh.price,
    swingLow: bar.swingLow.price,
    close: bar.close
  };

  const longAllowed = !params.requireTrendAlignment || bar.aboveTrend;
  const shortAllowed = !params.requireTrendAlignment || !bar.aboveTrend;

  if (bar.lowSweep && longAllowed) {
    // Below the wick, not below the level: the wick is where the trapped
    // sellers were filled, and price going back through it says the read was
    // simply wrong.
    return {
      side: 'BUY',
      entry: bar.close,
      sl: bar.lowSweep.low - buffer * 0.25,
      tp: bar.close + target,
      reason: `swept the swing low at ${bar.lowSweep.level} and closed back above it`,
      features
    };
  }

  if (bar.highSweep && shortAllowed) {
    return {
      side: 'SELL',
      entry: bar.close,
      sl: bar.highSweep.high + buffer * 0.25,
      tp: bar.close - target,
      reason: `swept the swing high at ${bar.highSweep.level} and closed back below it`,
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
      reason: `warming up: needs ${params.trendEma} bars and a confirmed swing either side`,
      checks: [],
      features: {}
    };
  }

  const f = (n) => Number(n).toFixed(4);
  const features = {
    atr: bar.atrValue,
    trend: bar.trend,
    swingHigh: bar.swingHigh.price,
    swingLow: bar.swingLow.price,
    close: bar.close
  };

  const sweep = bar.lowSweep || bar.highSweep;
  const isLong = Boolean(bar.lowSweep);
  const aligned = !params.requireTrendAlignment
    || (isLong ? bar.aboveTrend : !bar.aboveTrend);

  const checks = [
    {
      name: 'swing_levels',
      passed: true,
      detail: `swing low ${f(bar.swingLow.price)}, swing high ${f(bar.swingHigh.price)} (confirmed, not live)`
    },
    {
      name: 'liquidity_swept',
      passed: Boolean(sweep),
      detail: sweep
        ? `pierced the ${isLong ? 'low' : 'high'} by ${f(sweep.pierce)} (${(sweep.pierce / bar.atrValue).toFixed(2)} ATR) and closed back inside`
        : `no bar in the last ${params.maxSweepAge} pierced a swing and closed back inside`
    },
    {
      name: 'trend_alignment',
      passed: aligned,
      detail: params.requireTrendAlignment
        ? `close ${f(bar.close)} ${bar.aboveTrend ? 'above' : 'below'} the ${params.trendEma}-bar EMA`
        : 'not required: a sweep is a reversal signal, so it may trade against the EMA'
    }
  ];

  const firing = Boolean(sweep) && aligned;
  return {
    firing,
    side: firing ? (isLong ? 'BUY' : 'SELL') : null,
    reason: firing
      ? `${isLong ? 'long' : 'short'} setup: liquidity swept and reclaimed`
      : sweep
        ? 'no setup: a sweep happened but the trend filter refuses this direction'
        : 'no setup: no swing has been swept and reclaimed',
    checks,
    features
  };
}

module.exports = {
  name: 'liquidity-sweep',
  version: '1.0.0',
  defaultParams,
  prepare,
  evaluate,
  explain
};
