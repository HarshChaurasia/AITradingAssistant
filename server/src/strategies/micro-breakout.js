const { atr, ema, highest, lowest } = require('../indicators');

/**
 * Scalp: a momentum burst out of a short range.
 *
 * The premise is narrow and short-lived. Price has been coiling in a small
 * range; one bar breaks out of it with a range meaningfully larger than the
 * recent average, which says the move has participation rather than being
 * drift. The trade rides that burst for a few bars and then leaves, whether or
 * not it reached its target.
 *
 * That time stop is what makes this a scalp rather than a small swing trade.
 * A breakout that has not worked within six bars is not a slow winner - the
 * burst is over, and holding turns a scalp into an accidental position.
 *
 * WHY THIS IS RESTRICTED TO M5 AND ABOVE
 *
 * Measured on this account, median M1 bar range against the broker's spread:
 *
 *   BTCUSD  M1  1.9x    M5  10.8x
 *   ETHUSD  M1  0.8x    M5   4.2x
 *   XAUUSD  M1  1.9x    M5   4.5x
 *   EURUSD  M1  0.4x    M5   1.0x
 *
 * On EURUSD M1 the spread is two and a half times the entire median bar. A
 * strategy cannot out-trade that; there is no parameter set that makes it
 * work, and the honest answer is not to offer M1 at all. Even on M5 only
 * BTCUSD has real room, which is why the shipped scope is narrow.
 */

const defaultParams = {
  // The range being broken. Short: this is a burst out of a coil, not a trend.
  rangePeriod: 12,
  // The breakout bar's own range must be this multiple of the recent average,
  // or a one-tick poke through a quiet range counts as momentum.
  burstMultiple: 1.6,
  rangeAvgPeriod: 20,
  // A short trend filter, so a burst against the immediate direction is left
  // alone. Deliberately short - a 200-bar EMA is a different question.
  trendEma: 50,
  atrPeriod: 14,
  atrStopMultiple: 1.0,
  atrTargetMultiple: 1.5,
  // Six M5 bars is half an hour. The whole premise expires by then.
  maxHoldBars: 6
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  const ranges = candles.map((c) => c.high - c.low);

  // A trailing average of bar range, one value per bar, null-padded so index
  // alignment with the candles never shifts.
  const avgRange = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    sum += ranges[i];
    if (i >= params.rangeAvgPeriod) sum -= ranges[i - params.rangeAvgPeriod];
    if (i >= params.rangeAvgPeriod - 1) avgRange[i] = sum / params.rangeAvgPeriod;
  }

  return {
    atr: atr(candles, params.atrPeriod),
    trend: ema(closes, params.trendEma),
    // The range EXCLUDING the current bar, so a breakout is measured against
    // where price had been rather than against itself.
    rangeHigh: highest(candles.map((c) => c.high), params.rangePeriod),
    rangeLow: lowest(candles.map((c) => c.low), params.rangePeriod),
    avgRange
  };
}

function readBar(candles, index, params, context) {
  const atrValue = context.atr[index];
  const trend = context.trend[index];
  const avg = context.avgRange[index];

  // The prior bar's channel: including this bar would make every new high its
  // own breakout level, and nothing would ever fire.
  const priorHigh = index > 0 ? context.rangeHigh[index - 1] : null;
  const priorLow = index > 0 ? context.rangeLow[index - 1] : null;

  if (atrValue === null || atrValue <= 0 || trend === null || avg === null
      || avg <= 0 || priorHigh === null || priorLow === null) {
    return { ready: false };
  }

  const candle = candles[index];
  const barRange = candle.high - candle.low;

  return {
    ready: true,
    candle,
    atrValue,
    trend,
    avg,
    barRange,
    burst: barRange / avg,
    close: candle.close,
    priorHigh,
    priorLow,
    aboveTrend: candle.close > trend,
    brokeUp: candle.close > priorHigh,
    brokeDown: candle.close < priorLow,
    hasBurst: barRange >= avg * params.burstMultiple
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready) return null;

  const stop = bar.atrValue * params.atrStopMultiple;
  const target = bar.atrValue * params.atrTargetMultiple;
  const features = {
    atr: bar.atrValue, burst: bar.burst, avgRange: bar.avg,
    rangeHigh: bar.priorHigh, rangeLow: bar.priorLow, close: bar.close
  };

  if (bar.brokeUp && bar.hasBurst && bar.aboveTrend) {
    return {
      side: 'BUY',
      entry: bar.close,
      sl: bar.close - stop,
      tp: bar.close + target,
      reason: `momentum burst above the ${params.rangePeriod}-bar high, bar range ${bar.burst.toFixed(2)}x the recent average`,
      features
    };
  }

  if (bar.brokeDown && bar.hasBurst && !bar.aboveTrend) {
    return {
      side: 'SELL',
      entry: bar.close,
      sl: bar.close + stop,
      tp: bar.close - target,
      reason: `momentum burst below the ${params.rangePeriod}-bar low, bar range ${bar.burst.toFixed(2)}x the recent average`,
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
      reason: `warming up: needs ${Math.max(params.trendEma, params.rangeAvgPeriod)} bars`,
      checks: [],
      features: {}
    };
  }

  const f = (n) => Number(n).toFixed(4);
  const features = {
    atr: bar.atrValue, burst: bar.burst, avgRange: bar.avg,
    rangeHigh: bar.priorHigh, rangeLow: bar.priorLow, close: bar.close
  };

  const wantLong = bar.aboveTrend;
  const broke = wantLong ? bar.brokeUp : bar.brokeDown;

  const checks = [
    {
      name: 'trend_filter',
      passed: true,
      detail: `close ${f(bar.close)} ${wantLong ? 'above' : 'below'} the ${params.trendEma}-bar EMA ${f(bar.trend)}, so ${wantLong ? 'long' : 'short'}s only`
    },
    {
      name: 'range_break',
      passed: broke,
      detail: broke
        ? `closed through the ${params.rangePeriod}-bar ${wantLong ? 'high' : 'low'} at ${f(wantLong ? bar.priorHigh : bar.priorLow)}`
        : `${f(bar.close)} is inside the ${f(bar.priorLow)}-${f(bar.priorHigh)} range`
    },
    {
      name: 'momentum_burst',
      passed: bar.hasBurst,
      detail: `bar range ${f(bar.barRange)} is ${bar.burst.toFixed(2)}x the ${params.rangeAvgPeriod}-bar average ${f(bar.avg)}, needs ${params.burstMultiple}x`
    },
    {
      name: 'time_stop',
      passed: true,
      detail: `closed after ${params.maxHoldBars} bars whatever price is doing`
    }
  ];

  const firing = broke && bar.hasBurst;
  return {
    firing,
    side: firing ? (wantLong ? 'BUY' : 'SELL') : null,
    reason: firing
      ? `${wantLong ? 'long' : 'short'} scalp: momentum burst out of the range`
      : `no setup: ${checks.filter((c) => !c.passed).map((c) => c.name.replace(/_/g, ' ')).join(', ') || 'conditions unmet'}`,
    checks,
    features
  };
}

module.exports = {
  name: 'micro-breakout',
  version: '1.0.0',
  // Scalps are presented and judged separately: they hold for minutes, take
  // many more trades, and live or die on spread rather than on direction.
  kind: 'scalp',
  // M1 is excluded on purpose - see the measurements at the top of this file.
  timeframes: ['M5', 'M15'],
  defaultParams,
  prepare,
  evaluate,
  explain
};
