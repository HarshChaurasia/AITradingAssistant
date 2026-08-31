const { atr } = require('../indicators');

/**
 * The break of the range a session opened with.
 *
 * The only strategy here that reads the clock. Everything else treats a bar
 * at 03:00 UTC exactly like a bar at 08:00, and for these instruments that is
 * throwing away real structure: the London open is when European desks price
 * gold and the majors, and the range built in the first hour is a level the
 * rest of the day trades around. Breaking it is a different event from
 * breaking an arbitrary twenty-bar high.
 *
 * Times are UTC throughout. Candle open_time is stored in UTC after the
 * broker-offset correction, so no timezone arithmetic happens here - if that
 * correction were ever wrong this strategy would be measuring the range of
 * the wrong hours, which is a good reason for it to state the assumption
 * rather than bury it.
 *
 * WHY IT REFUSES TO RUN ON SLOW TIMEFRAMES
 *
 * An opening range needs several bars inside the opening window to mean
 * anything. On H4 the first bar IS the window, so the range and the breakout
 * level are the same number and every session would fire on its own open. The
 * strategy returns nothing above M30 rather than producing a signal that
 * looks valid and measures nothing.
 */

const defaultParams = {
  // London. 07:00-08:00 UTC in winter, 06:00-07:00 in summer - the hour is
  // deliberately not adjusted for daylight saving, because the alternative is
  // a rule that changes twice a year for reasons unrelated to the market and
  // silently redefines what was backtested.
  sessionStartHour: 7,
  // Bars of range-building before a break counts. With M15 bars this is an
  // hour; the range is measured over exactly this many bars from the open.
  openingBars: 4,
  // How long after the opening range the setup stays live. Past this the day
  // has found its direction without us and a "breakout" is just the trend.
  windowBars: 16,
  // The break must clear the range by this fraction of it, so a one-tick poke
  // through the high is not a breakout.
  breakBuffer: 0.1,
  atrPeriod: 14,
  atrStopMultiple: 1.5,
  atrTargetMultiple: 3.0
};

// Timeframes with room for an opening range. Above M30 the opening window is
// one or two bars, which is not a range.
const SUPPORTED_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30 };

function barMinutes(candles) {
  if (candles.length < 2) return null;
  const delta = new Date(candles[1].open_time) - new Date(candles[0].open_time);
  const minutes = Math.round(delta / 60000);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

function hourOf(candle) {
  return new Date(candle.open_time).getUTCHours();
}

function dayOf(candle) {
  return String(candle.open_time).slice(0, 10);
}

/**
 * The opening range for each bar's own session.
 *
 * Built forwards in one pass, publishing a level only once the opening window
 * has CLOSED. Reading a range that includes bars after the current one is the
 * lookahead bug this whole codebase is arranged to prevent, and here it would
 * be invisible: the strategy would simply appear to predict the day.
 */
function prepare(candles, params) {
  const minutes = barMinutes(candles);
  const supported = minutes !== null
    && Object.values(SUPPORTED_MINUTES).includes(minutes)
    && minutes <= SUPPORTED_MINUTES.M30;

  const ranges = new Array(candles.length).fill(null);

  if (supported) {
    let session = null;

    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i];
      const day = dayOf(candle);
      const hour = hourOf(candle);

      // A new session begins at the first bar of the configured hour on a day
      // we have not started yet.
      if (hour === params.sessionStartHour && (!session || session.day !== day)) {
        session = { day, startIndex: i, high: -Infinity, low: Infinity, level: null };
      }

      if (!session) continue;

      const age = i - session.startIndex;

      if (age < params.openingBars) {
        // Still building. Nothing is published for these bars, because the
        // range they belong to is not finished.
        session.high = Math.max(session.high, candle.high);
        session.low = Math.min(session.low, candle.low);
        continue;
      }

      if (session.level === null) {
        session.level = {
          high: session.high,
          low: session.low,
          width: session.high - session.low
        };
      }

      if (age - params.openingBars < params.windowBars && session.level.width > 0) {
        ranges[i] = { ...session.level, barsSinceOpen: age };
      }
    }
  }

  return {
    supported,
    barMinutes: minutes,
    atr: atr(candles, params.atrPeriod),
    ranges
  };
}

function readBar(candles, index, params, context) {
  if (!context.supported) {
    return { ready: false, unsupported: true };
  }

  const atrValue = context.atr[index];
  const range = context.ranges[index];
  if (atrValue === null || atrValue <= 0 || !range) return { ready: false };

  const candle = candles[index];
  const buffer = range.width * params.breakBuffer;

  return {
    ready: true,
    candle,
    atrValue,
    range,
    close: candle.close,
    brokeUp: candle.close > range.high + buffer,
    brokeDown: candle.close < range.low - buffer,
    buffer
  };
}

function evaluate(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);
  if (!bar.ready) return null;

  const stop = bar.atrValue * params.atrStopMultiple;
  const target = bar.atrValue * params.atrTargetMultiple;
  const features = {
    atr: bar.atrValue,
    rangeHigh: bar.range.high,
    rangeLow: bar.range.low,
    rangeWidth: bar.range.width,
    barsSinceOpen: bar.range.barsSinceOpen,
    close: bar.close
  };

  if (bar.brokeUp) {
    return {
      side: 'BUY',
      entry: bar.close,
      sl: bar.close - stop,
      tp: bar.close + target,
      reason: `broke above the ${params.sessionStartHour}:00 UTC opening range high ${bar.range.high.toFixed(4)}`,
      features
    };
  }

  if (bar.brokeDown) {
    return {
      side: 'SELL',
      entry: bar.close,
      sl: bar.close + stop,
      tp: bar.close - target,
      reason: `broke below the ${params.sessionStartHour}:00 UTC opening range low ${bar.range.low.toFixed(4)}`,
      features
    };
  }

  return null;
}

function explain(candles, index, params, context) {
  const bar = readBar(candles, index, params, context);

  if (bar.unsupported) {
    return {
      firing: false,
      side: null,
      reason: `an opening range needs several bars inside the opening hour; on ${context.barMinutes}-minute bars the window is too coarse to measure one`,
      checks: [],
      features: {}
    };
  }

  if (!bar.ready) {
    // Two different statements, and conflating them would have the scanner
    // report a permanent condition as a temporary one. No ATR yet is warm-up
    // and resolves itself; being outside the session window is a fact about
    // the time of day that will not change until tomorrow.
    const warming = context.atr[index] === null || context.atr[index] <= 0;
    return {
      firing: false,
      side: null,
      reason: warming
        ? `warming up: needs ${params.atrPeriod} bars of history before a range can be traded`
        : `outside the session window - the ${params.sessionStartHour}:00 UTC opening range is still forming, or the day has moved past it`,
      checks: [],
      features: {}
    };
  }

  const f = (n) => Number(n).toFixed(4);
  const features = {
    atr: bar.atrValue,
    rangeHigh: bar.range.high,
    rangeLow: bar.range.low,
    rangeWidth: bar.range.width,
    barsSinceOpen: bar.range.barsSinceOpen,
    close: bar.close
  };

  const broke = bar.brokeUp || bar.brokeDown;
  const checks = [
    {
      name: 'session_window',
      passed: true,
      detail: `${bar.range.barsSinceOpen} bars since the ${params.sessionStartHour}:00 UTC open, window is ${params.openingBars}-${params.openingBars + params.windowBars}`
    },
    {
      name: 'opening_range',
      passed: true,
      detail: `range ${f(bar.range.low)}-${f(bar.range.high)}, width ${f(bar.range.width)} over the first ${params.openingBars} bars`
    },
    {
      name: 'range_break',
      passed: broke,
      detail: broke
        ? `closed ${bar.brokeUp ? 'above' : 'below'} the range by more than the ${(params.breakBuffer * 100).toFixed(0)}% buffer ${f(bar.buffer)}`
        : `${f(bar.close)} is inside the range, or has not cleared the ${f(bar.buffer)} buffer`
    }
  ];

  return {
    firing: broke,
    side: broke ? (bar.brokeUp ? 'BUY' : 'SELL') : null,
    reason: broke
      ? `${bar.brokeUp ? 'long' : 'short'}: session opening range broken`
      : 'no setup: price is still inside the opening range',
    checks,
    features
  };
}

module.exports = {
  name: 'session-breakout',
  version: '1.0.0',
  kind: 'swing',
  defaultParams,
  prepare,
  evaluate,
  explain
};
