const { swings, fairValueGaps, atr, ema } = require('../indicators');

/**
 * Smart Money Concepts: break of structure, then a retrace into the imbalance.
 *
 * The idea, stripped of the folklore: a decisive close through the last
 * confirmed swing high says buyers took control (a Break of Structure). The
 * fast move that did it usually leaves a Fair Value Gap - three bars where
 * price travelled so quickly that the first and third never traded through the
 * same range. The entry is the pullback into that gap, on the premise that
 * skipped prices tend to be revisited before the move continues.
 *
 * Two things keep this honest and separate it from the retail version:
 *
 *   1. Swings are confirmed, not live. A pivot needs bars on both sides, so it
 *      is only knowable `swingLookback` bars later. Reading a swing at the bar
 *      it formed is lookahead, and it is the single commonest way an SMC
 *      backtest produces results nobody can reproduce.
 *
 *   2. The break must CLOSE through the level. A wick through it is the
 *      liquidity sweep this strategy is explicitly not trading - the
 *      liquidity-sweep strategy takes the other side of exactly that bar.
 */

const defaultParams = {
  swingLookback: 2,
  // How recently the break of structure must have happened. Older than this
  // and the "structure" is history rather than the current move.
  bosMaxAge: 20,
  // Entry requires price to have come back into the gap.
  requireGapTouch: true,
  trendEma: 200,
  atrPeriod: 14,
  atrStopMultiple: 1.5,
  atrTargetMultiple: 3.0
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    swings: swings(candles, params.swingLookback),
    gaps: fairValueGaps(candles),
    atr: atr(candles, params.atrPeriod),
    trend: ema(closes, params.trendEma)
  };
}

/**
 * Find the most recent bar that closed through the swing level.
 *
 * Walks backwards from `index`, so it only ever reads bars at or before the
 * one being evaluated.
 */
function findBreak(candles, index, level, direction, maxAge) {
  if (level === null) return null;
  const from = Math.max(level.index + 1, index - maxAge);
  for (let i = index; i >= from; i -= 1) {
    const brokeUp = direction === 'up' && candles[i].close > level.price;
    const brokeDown = direction === 'down' && candles[i].close < level.price;
    if (brokeUp || brokeDown) return { index: i, level: level.price };
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
  const bullishBreak = findBreak(candles, index, swingHigh, 'up', params.bosMaxAge);
  const bearishBreak = findBreak(candles, index, swingLow, 'down', params.bosMaxAge);

  const bullGap = context.gaps.bullish[index];
  const bearGap = context.gaps.bearish[index];

  // The gap has to belong to the move that broke structure, not to some
  // earlier one that happens to still be on the chart.
  const bullGapFresh = Boolean(bullGap && bullishBreak && bullGap.index >= bullishBreak.index - 2);
  const bearGapFresh = Boolean(bearGap && bearishBreak && bearGap.index >= bearishBreak.index - 2);

  // "Touched" means this bar traded back into the skipped range.
  const bullTouched = Boolean(bullGapFresh && candle.low <= bullGap.to && candle.high >= bullGap.from);
  const bearTouched = Boolean(bearGapFresh && candle.high >= bearGap.from && candle.low <= bearGap.to);

  return {
    ready: true,
    candle,
    atrValue,
    trend,
    close: candle.close,
    aboveTrend: candle.close > trend,
    swingHigh,
    swingLow,
    bullishBreak,
    bearishBreak,
    bullGap: bullGapFresh ? bullGap : null,
    bearGap: bearGapFresh ? bearGap : null,
    bullTouched: params.requireGapTouch ? bullTouched : Boolean(bullGapFresh),
    bearTouched: params.requireGapTouch ? bearTouched : Boolean(bearGapFresh)
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready) return null;

  const stop = bar.atrValue * params.atrStopMultiple;
  const target = bar.atrValue * params.atrTargetMultiple;
  const features = {
    atr: bar.atrValue,
    trend: bar.trend,
    swingHigh: bar.swingHigh.price,
    swingLow: bar.swingLow.price,
    close: bar.close
  };

  if (bar.bullishBreak && bar.bullTouched && bar.aboveTrend) {
    // The stop goes below the gap, not merely an ATR below price: if the
    // imbalance fails to hold, the reason for the trade has gone.
    const sl = Math.min(bar.bullGap.from, bar.close - stop);
    return {
      side: 'BUY',
      entry: bar.close,
      sl,
      tp: bar.close + target,
      reason: `break of structure above ${bar.swingHigh.price} with a retrace into the fair value gap`,
      features
    };
  }

  if (bar.bearishBreak && bar.bearTouched && !bar.aboveTrend) {
    const sl = Math.max(bar.bearGap.to, bar.close + stop);
    return {
      side: 'SELL',
      entry: bar.close,
      sl,
      tp: bar.close - target,
      reason: `break of structure below ${bar.swingLow.price} with a retrace into the fair value gap`,
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

  const wantLong = bar.aboveTrend;
  const structureBroken = wantLong ? Boolean(bar.bullishBreak) : Boolean(bar.bearishBreak);
  const gapPresent = wantLong ? Boolean(bar.bullGap) : Boolean(bar.bearGap);
  const gapTouched = wantLong ? bar.bullTouched : bar.bearTouched;

  const checks = [
    {
      name: 'trend_filter',
      passed: true,
      detail: `close ${f(bar.close)} ${wantLong ? 'above' : 'below'} the ${params.trendEma}-bar EMA ${f(bar.trend)}, so ${wantLong ? 'long' : 'short'}s only`
    },
    {
      name: 'break_of_structure',
      passed: structureBroken,
      detail: structureBroken
        ? `closed through the ${wantLong ? 'swing high' : 'swing low'} at ${f(wantLong ? bar.swingHigh.price : bar.swingLow.price)}`
        : `no close through the ${wantLong ? 'swing high' : 'swing low'} at ${f(wantLong ? bar.swingHigh.price : bar.swingLow.price)} in the last ${params.bosMaxAge} bars`
    },
    {
      name: 'fair_value_gap',
      passed: gapPresent,
      detail: gapPresent
        ? `imbalance ${f((wantLong ? bar.bullGap : bar.bearGap).from)}–${f((wantLong ? bar.bullGap : bar.bearGap).to)} left by the move`
        : 'the move left no fair value gap belonging to this break'
    },
    {
      name: 'retrace_into_gap',
      passed: gapTouched,
      detail: gapTouched
        ? 'price has traded back into the imbalance'
        : 'price has not come back into the imbalance yet'
    }
  ];

  const firing = structureBroken && gapPresent && gapTouched;
  return {
    firing,
    side: firing ? (wantLong ? 'BUY' : 'SELL') : null,
    reason: firing
      ? `${wantLong ? 'long' : 'short'} setup: structure broken and price retraced into the imbalance`
      : `no setup: ${checks.filter((c) => !c.passed).map((c) => c.name.replace(/_/g, ' ')).join(', ') || 'conditions unmet'}`,
    checks,
    features
  };
}

module.exports = {
  name: 'smart-money',
  version: '1.0.0',
  defaultParams,
  prepare,
  evaluate,
  explain
};
