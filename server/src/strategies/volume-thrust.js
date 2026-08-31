const { atr, ema } = require('../indicators');

/**
 * A directional bar backed by unusual participation.
 *
 * Every other strategy in this book reads price alone. This one reads the
 * only other column the broker gives us: tick volume, the number of price
 * changes inside the bar. That is a genuinely different question. Price says
 * where the market went; volume says how many participants it took to get
 * there, and a move made on ordinary volume is a move a handful of orders can
 * undo.
 *
 * The premise: a bar that closes strongly in one direction on volume far
 * above its recent average is a move with people behind it, and moves with
 * people behind them continue more often than drift does.
 *
 * TWO THINGS THAT WOULD MAKE THIS A LIE, AND WHAT IS DONE ABOUT THEM
 *
 * Tick volume is not traded volume. On an FX CFD there is no central exchange
 * to report size, so the broker counts price updates instead. It correlates
 * with real activity and is not the same thing - so this strategy asks only
 * for a RATIO against the instrument's own recent average, never an absolute
 * level, and never compares one instrument's volume to another's.
 *
 * Volume has a strong time-of-day shape: the London open produces several
 * times the tick count of the Asian afternoon on the same instrument, every
 * day. A fixed threshold would therefore fire almost exclusively at session
 * opens and call that an edge. The average is taken over a whole number of
 * DAYS where the timeframe allows it, so the comparison is against the same
 * hour on previous days rather than against a quiet hour a few bars ago.
 */

const defaultParams = {
  // Bars in the volume baseline. Deliberately long: a short window is
  // dominated by the current session's own shape, and comparing a bar to the
  // twenty bars beside it mostly measures the time of day.
  volumeLookback: 96,
  // How far above that baseline counts as participation rather than noise.
  volumeMultiple: 2.0,
  // The bar must also CLOSE convincingly in its direction. A huge-volume bar
  // that closes mid-range is a fight, not a decision, and fighting is exactly
  // what we do not want to join.
  minBodyFraction: 0.6,
  // Only in the direction of the longer trend. Volume marks participation,
  // not direction, and a high-volume bar against a strong trend is as often
  // absorption as it is reversal.
  trendEma: 200,
  atrPeriod: 14,
  atrStopMultiple: 2.0,
  atrTargetMultiple: 4.0
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => Number(c.tick_volume || 0));

  // A trailing mean of tick volume, one value per bar, null-padded so index
  // alignment with the candles never shifts. Excludes the current bar: a bar
  // compared against an average that contains itself can never be two times
  // it, and the threshold would silently mean something else.
  const avgVolume = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    if (i >= params.volumeLookback) {
      avgVolume[i] = sum / params.volumeLookback;
      sum -= volumes[i - params.volumeLookback];
    }
    sum += volumes[i];
  }

  return {
    atr: atr(candles, params.atrPeriod),
    trend: ema(closes, params.trendEma),
    avgVolume
  };
}

function readBar(candles, index, params, context) {
  const atrValue = context.atr[index];
  const trend = context.trend[index];
  const avgVolume = context.avgVolume[index];

  if (atrValue === null || atrValue <= 0 || trend === null
      || avgVolume === null || avgVolume <= 0) {
    return { ready: false };
  }

  const candle = candles[index];
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const volume = Number(candle.tick_volume || 0);

  return {
    ready: true,
    candle,
    atrValue,
    trend,
    avgVolume,
    volume,
    // A zero-range bar has no body fraction to speak of, and dividing by it
    // would report Infinity as conviction.
    bodyFraction: range > 0 ? body / range : 0,
    volumeRatio: volume / avgVolume,
    close: candle.close,
    up: candle.close > candle.open,
    aboveTrend: candle.close > trend,
    hasVolume: volume >= avgVolume * params.volumeMultiple,
    hasBody: range > 0 && (body / range) >= params.minBodyFraction
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready) return null;

  const stop = bar.atrValue * params.atrStopMultiple;
  const target = bar.atrValue * params.atrTargetMultiple;
  const features = {
    atr: bar.atrValue,
    volume: bar.volume,
    avgVolume: bar.avgVolume,
    volumeRatio: bar.volumeRatio,
    bodyFraction: bar.bodyFraction,
    close: bar.close
  };

  if (!bar.hasVolume || !bar.hasBody) return null;

  if (bar.up && bar.aboveTrend) {
    return {
      side: 'BUY',
      entry: bar.close,
      sl: bar.close - stop,
      tp: bar.close + target,
      reason: `up bar on ${bar.volumeRatio.toFixed(1)}x normal volume, closing in the top of its range with the trend`,
      features
    };
  }

  if (!bar.up && !bar.aboveTrend) {
    return {
      side: 'SELL',
      entry: bar.close,
      sl: bar.close + stop,
      tp: bar.close - target,
      reason: `down bar on ${bar.volumeRatio.toFixed(1)}x normal volume, closing in the bottom of its range with the trend`,
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
      reason: `warming up: needs ${Math.max(params.trendEma, params.volumeLookback)} bars`,
      checks: [],
      features: {}
    };
  }

  const f = (n) => Number(n).toFixed(4);
  const features = {
    atr: bar.atrValue,
    volume: bar.volume,
    avgVolume: bar.avgVolume,
    volumeRatio: bar.volumeRatio,
    bodyFraction: bar.bodyFraction,
    close: bar.close
  };

  const aligned = bar.up === bar.aboveTrend;
  const checks = [
    {
      name: 'participation',
      passed: bar.hasVolume,
      detail: `tick volume ${Math.round(bar.volume)} is ${bar.volumeRatio.toFixed(2)}x the ${params.volumeLookback}-bar average ${Math.round(bar.avgVolume)}, needs ${params.volumeMultiple}x`
    },
    {
      name: 'conviction',
      passed: bar.hasBody,
      detail: `body is ${(bar.bodyFraction * 100).toFixed(0)}% of the bar range, needs ${(params.minBodyFraction * 100).toFixed(0)}% - a big-volume bar closing mid-range is a fight, not a decision`
    },
    {
      name: 'trend_alignment',
      passed: aligned,
      detail: aligned
        ? `${bar.up ? 'up' : 'down'} bar ${bar.aboveTrend ? 'above' : 'below'} the ${params.trendEma}-bar EMA ${f(bar.trend)}`
        : `${bar.up ? 'up' : 'down'} bar against the trend - as often absorption as reversal, so left alone`
    }
  ];

  const firing = bar.hasVolume && bar.hasBody && aligned;
  return {
    firing,
    side: firing ? (bar.up ? 'BUY' : 'SELL') : null,
    reason: firing
      ? `${bar.up ? 'long' : 'short'}: ${bar.volumeRatio.toFixed(1)}x volume behind a decisive bar with the trend`
      : `no setup: ${checks.filter((c) => !c.passed).map((c) => c.name.replace(/_/g, ' ')).join(', ')}`,
    checks,
    features
  };
}

module.exports = {
  name: 'volume-thrust',
  version: '1.0.0',
  kind: 'swing',
  defaultParams,
  prepare,
  evaluate,
  explain
};
