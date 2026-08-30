const { swings, rsi, atr } = require('../indicators');

/**
 * Momentum divergence at a confirmed swing.
 *
 * Price makes a lower low while RSI makes a higher low: the market reached a
 * new extreme with less force behind it than last time. That is the classic
 * bullish divergence, and it is a genuinely different family from everything
 * else in this book - the other strategies buy strength, this one buys
 * exhaustion.
 *
 * Divergence has a deserved reputation for being drawn in hindsight, so two
 * rules keep it mechanical:
 *
 *   1. Both swings must be CONFIRMED pivots, which means they were only
 *      knowable some bars after they formed. An eye picking two lows off a
 *      finished chart is choosing them with the benefit of everything that
 *      came after.
 *
 *   2. The prior swing is whatever the pivot detector last recorded before
 *      this one. It is not searched for, so there is no scope to pick the pair
 *      that happens to make the nicest divergence.
 */

const defaultParams = {
  swingLookback: 3,
  rsiPeriod: 14,
  // The extreme has to be somewhere meaningful. A divergence in the middle of
  // the range is two arbitrary points joined by a line.
  oversold: 40,
  overbought: 60,
  // How far apart the two swings may be. Beyond this they belong to different
  // moves and comparing their momentum says nothing.
  maxSwingGap: 40,
  minSwingGap: 5,
  atrPeriod: 14,
  atrStopMultiple: 1.2,
  atrTargetMultiple: 2.5
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    swings: swings(candles, params.swingLookback),
    rsi: rsi(closes, params.rsiPeriod),
    atr: atr(candles, params.atrPeriod)
  };
}

/**
 * Track the two most recent confirmed pivots at each bar.
 *
 * Built by walking forward and remembering, so at any index it holds only
 * what was knowable by then.
 */
function pivotHistory(series) {
  const pairs = new Array(series.length).fill(null);
  let previous = null;
  let latest = null;

  for (let i = 0; i < series.length; i += 1) {
    const current = series[i];
    if (current && (!latest || current.index !== latest.index)) {
      previous = latest;
      latest = current;
    }
    pairs[i] = previous && latest ? { previous, latest } : null;
  }
  return pairs;
}

function prepareWithPivots(candles, params) {
  const context = prepare(candles, params);
  return {
    ...context,
    lowPairs: pivotHistory(context.swings.lows),
    highPairs: pivotHistory(context.swings.highs)
  };
}

function readBar(candles, index, params, context) {
  const atrValue = context.atr[index];
  const rsiNow = context.rsi[index];
  const lows = context.lowPairs[index];
  const highs = context.highPairs[index];

  if (atrValue === null || atrValue <= 0 || rsiNow === null) return { ready: false };

  const gapOk = (pair) => {
    const gap = pair.latest.index - pair.previous.index;
    return gap >= params.minSwingGap && gap <= params.maxSwingGap;
  };

  let bullish = null;
  if (lows && gapOk(lows)) {
    const rsiPrev = context.rsi[lows.previous.index];
    const rsiLast = context.rsi[lows.latest.index];
    if (rsiPrev !== null && rsiLast !== null) {
      bullish = {
        priceLower: lows.latest.price < lows.previous.price,
        rsiHigher: rsiLast > rsiPrev,
        oversold: rsiPrev <= params.oversold,
        rsiPrev, rsiLast, pair: lows
      };
    }
  }

  let bearish = null;
  if (highs && gapOk(highs)) {
    const rsiPrev = context.rsi[highs.previous.index];
    const rsiLast = context.rsi[highs.latest.index];
    if (rsiPrev !== null && rsiLast !== null) {
      bearish = {
        priceHigher: highs.latest.price > highs.previous.price,
        rsiLower: rsiLast < rsiPrev,
        overbought: rsiPrev >= params.overbought,
        rsiPrev, rsiLast, pair: highs
      };
    }
  }

  return {
    ready: true,
    atrValue,
    rsiNow,
    close: candles[index].close,
    bullish,
    bearish,
    // Only act on the bar the second pivot became visible. Later bars would be
    // trading a divergence the market has already had time to resolve.
    freshLow: Boolean(lows && lows.latest.index + params.swingLookback === index),
    freshHigh: Boolean(highs && highs.latest.index + params.swingLookback === index)
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready) return null;

  const stop = bar.atrValue * params.atrStopMultiple;
  const target = bar.atrValue * params.atrTargetMultiple;
  const features = { atr: bar.atrValue, rsi: bar.rsiNow, close: bar.close };

  const bullishFiring = bar.freshLow && bar.bullish
    && bar.bullish.priceLower && bar.bullish.rsiHigher && bar.bullish.oversold;

  if (bullishFiring) {
    return {
      side: 'BUY',
      entry: bar.close,
      sl: bar.bullish.pair.latest.price - stop * 0.5,
      tp: bar.close + target,
      reason: `bullish divergence: price made a lower low while RSI rose from ${bar.bullish.rsiPrev.toFixed(1)} to ${bar.bullish.rsiLast.toFixed(1)}`,
      features
    };
  }

  const bearishFiring = bar.freshHigh && bar.bearish
    && bar.bearish.priceHigher && bar.bearish.rsiLower && bar.bearish.overbought;

  if (bearishFiring) {
    return {
      side: 'SELL',
      entry: bar.close,
      sl: bar.bearish.pair.latest.price + stop * 0.5,
      tp: bar.close - target,
      reason: `bearish divergence: price made a higher high while RSI fell from ${bar.bearish.rsiPrev.toFixed(1)} to ${bar.bearish.rsiLast.toFixed(1)}`,
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
      reason: `warming up: needs ${params.rsiPeriod} bars of RSI and two confirmed swings`,
      checks: [],
      features: {}
    };
  }

  const features = { atr: bar.atrValue, rsi: bar.rsiNow, close: bar.close };
  const d = bar.bullish;
  const u = bar.bearish;

  const checks = [
    {
      name: 'two_confirmed_swings',
      passed: Boolean(d || u),
      detail: (d || u)
        ? 'two confirmed pivots within the allowed spacing'
        : `no pair of pivots ${params.minSwingGap}-${params.maxSwingGap} bars apart yet`
    },
    {
      name: 'fresh_pivot',
      passed: bar.freshLow || bar.freshHigh,
      detail: (bar.freshLow || bar.freshHigh)
        ? 'the second pivot became visible on this bar'
        : 'the pivot is older than this bar, so the divergence has had time to resolve'
    },
    {
      name: 'price_divergence',
      passed: Boolean((d && d.priceLower) || (u && u.priceHigher)),
      detail: d
        ? `latest swing low ${d.pair.latest.price.toFixed(4)} against ${d.pair.previous.price.toFixed(4)}`
        : 'no swing low pair to compare'
    },
    {
      name: 'momentum_divergence',
      passed: Boolean((d && d.rsiHigher) || (u && u.rsiLower)),
      detail: d
        ? `RSI ${d.rsiPrev.toFixed(1)} → ${d.rsiLast.toFixed(1)}`
        : u ? `RSI ${u.rsiPrev.toFixed(1)} → ${u.rsiLast.toFixed(1)}` : 'no RSI pair'
    },
    {
      name: 'at_an_extreme',
      passed: Boolean((d && d.oversold) || (u && u.overbought)),
      detail: d
        ? `prior swing RSI ${d.rsiPrev.toFixed(1)} against an oversold line of ${params.oversold}`
        : u ? `prior swing RSI ${u.rsiPrev.toFixed(1)} against an overbought line of ${params.overbought}`
          : 'no extreme to measure'
    }
  ];

  const bullishFiring = bar.freshLow && d && d.priceLower && d.rsiHigher && d.oversold;
  const bearishFiring = bar.freshHigh && u && u.priceHigher && u.rsiLower && u.overbought;
  const firing = Boolean(bullishFiring || bearishFiring);

  return {
    firing,
    side: firing ? (bullishFiring ? 'BUY' : 'SELL') : null,
    reason: firing
      ? `${bullishFiring ? 'bullish' : 'bearish'} divergence confirmed on this bar`
      : `no setup: ${checks.filter((c) => !c.passed).map((c) => c.name.replace(/_/g, ' ')).join(', ') || 'conditions unmet'}`,
    checks,
    features
  };
}

module.exports = {
  name: 'rsi-divergence',
  version: '1.0.0',
  defaultParams,
  prepare: prepareWithPivots,
  evaluate,
  explain
};
