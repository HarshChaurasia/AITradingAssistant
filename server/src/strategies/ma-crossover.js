const { ema, atr } = require('../indicators');

/**
 * The classic fast/slow moving-average crossover - the "golden cross".
 *
 * Included deliberately as a BASELINE, not because it is expected to win. It
 * is the oldest and most widely published trend rule there is, so if a more
 * elaborate strategy cannot beat it out-of-sample, the elaboration is not
 * earning its complexity. A control, in other words.
 */

const defaultParams = {
  fastEma: 50,
  slowEma: 200,
  atrPeriod: 14,
  atrStopMultiple: 2.0,
  atrTargetMultiple: 3.0
};

function prepare(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    fast: ema(closes, params.fastEma),
    slow: ema(closes, params.slowEma),
    atr: atr(candles, params.atrPeriod)
  };
}

function readBar(candles, index, params, context) {
  const fast = context.fast[index];
  const slow = context.slow[index];
  const prevFast = index > 0 ? context.fast[index - 1] : null;
  const prevSlow = index > 0 ? context.slow[index - 1] : null;
  const atrValue = context.atr[index];

  if (fast === null || slow === null || prevFast === null
      || prevSlow === null || atrValue === null || atrValue <= 0) {
    return { ready: false };
  }

  return {
    ready: true,
    fast, slow, atrValue,
    close: candles[index].close,
    goldenCross: prevFast <= prevSlow && fast > slow,
    deathCross: prevFast >= prevSlow && fast < slow
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready) return null;

  const stop = bar.atrValue * params.atrStopMultiple;
  const target = bar.atrValue * params.atrTargetMultiple;
  const features = { fast: bar.fast, slow: bar.slow, atr: bar.atrValue, close: bar.close };

  if (bar.goldenCross) {
    return {
      side: 'BUY',
      entry: bar.close,
      sl: bar.close - stop,
      tp: bar.close + target,
      reason: `EMA${params.fastEma} crossed above EMA${params.slowEma}`,
      features
    };
  }

  if (bar.deathCross) {
    return {
      side: 'SELL',
      entry: bar.close,
      sl: bar.close + stop,
      tp: bar.close - target,
      reason: `EMA${params.fastEma} crossed below EMA${params.slowEma}`,
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
      reason: `warming up: needs ${params.slowEma} bars of history`,
      checks: [],
      features: {}
    };
  }

  const f = (n) => Number(n).toFixed(4);
  const features = { fast: bar.fast, slow: bar.slow, atr: bar.atrValue, close: bar.close };
  const crossed = bar.goldenCross || bar.deathCross;
  const gap = Math.abs(bar.fast - bar.slow);

  const checks = [
    {
      name: 'ma_cross',
      passed: crossed,
      detail: crossed
        ? `EMA${params.fastEma} crossed ${bar.goldenCross ? 'above' : 'below'} EMA${params.slowEma} this bar`
        : `EMA${params.fastEma} ${f(bar.fast)} is ${bar.fast > bar.slow ? 'above' : 'below'} EMA${params.slowEma} ${f(bar.slow)} and did not cross (gap ${f(gap)})`
    },
    { name: 'volatility', passed: true, detail: `ATR ${f(bar.atrValue)}` }
  ];

  if (crossed) {
    return {
      firing: true,
      side: bar.goldenCross ? 'BUY' : 'SELL',
      reason: bar.goldenCross
        ? `long setup: EMA${params.fastEma} crossed above EMA${params.slowEma}`
        : `short setup: EMA${params.fastEma} crossed below EMA${params.slowEma}`,
      checks,
      features
    };
  }

  return {
    firing: false,
    side: null,
    reason: `no setup: no crossover - EMA${params.fastEma} ${f(bar.fast)} is ${f(gap)} ${bar.fast > bar.slow ? 'above' : 'below'} EMA${params.slowEma}`,
    checks,
    features
  };
}

module.exports = {
  name: 'ma-crossover',
  version: '1.0.0',
  defaultParams,
  prepare,
  evaluate,
  explain
};
