/**
 * Pure indicator maths. Every function returns an array the same length as its
 * input, left-padded with null where there is not yet enough history, so the
 * backtest engine can index indicators by bar number without any offset.
 *
 * No function may read a bar later than the one it is producing a value for.
 */

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  out[period - 1] = seed / period;

  for (let i = period; i < values.length; i += 1) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder's smoothing.
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function trueRange(candle, previousClose) {
  if (previousClose === undefined) return candle.high - candle.low;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose)
  );
}

function atr(candles, period) {
  const out = new Array(candles.length).fill(null);
  // True range needs a previous close, so bar 0 has none.
  const ranges = candles.map((c, i) => (i === 0 ? null : trueRange(c, candles[i - 1].close)));

  let sum = 0;
  for (let i = 1; i < candles.length; i += 1) {
    sum += ranges[i];
    if (i > period) sum -= ranges[i - period];
    if (i >= period) out[i] = sum / period;
  }
  return out;
}

function rolling(values, period, pick) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    out[i] = pick(values.slice(i - period + 1, i + 1));
  }
  return out;
}

function highest(values, period) {
  return rolling(values, period, (window) => Math.max(...window));
}

function lowest(values, period) {
  return rolling(values, period, (window) => Math.min(...window));
}

function donchian(candles, period) {
  const upper = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);

  // The channel deliberately excludes the current bar: a breakout must be
  // measured against prior bars, never against the bar doing the breaking.
  for (let i = period; i < candles.length; i += 1) {
    const window = candles.slice(i - period, i);
    upper[i] = Math.max(...window.map((c) => c.high));
    lower[i] = Math.min(...window.map((c) => c.low));
  }
  return { upper, lower };
}

module.exports = { sma, ema, rsi, atr, highest, lowest, donchian, trueRange };
