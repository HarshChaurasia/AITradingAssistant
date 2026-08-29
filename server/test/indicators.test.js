const test = require('node:test');
const assert = require('node:assert/strict');

const { sma, ema, rsi, atr, highest, lowest, donchian } = require('../src/indicators');

function candle(high, low, close) {
  return { high, low, close, open: close };
}

test('sma pads with null and averages a rolling window', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.equal(out.length, 5, 'same length as input');
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.equal(out[2], 2); // (1+2+3)/3
  assert.equal(out[3], 3);
  assert.equal(out[4], 4);
});

test('ema seeds from the first SMA then applies the smoothing factor', () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.equal(out[2], 2); // seeded with the SMA of the first 3
  // k = 2/(3+1) = 0.5 -> 4*0.5 + 2*0.5 = 3
  assert.equal(out[3], 3);
  assert.equal(out[4], 4);
});

test('rsi is 100 when every change is a gain', () => {
  const out = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14);
  // RSI(14) needs 14 changes, so it needs 15 values: the first reading is at
  // index 14, and index 13 is still null.
  assert.equal(out[13], null);
  assert.equal(out[14], 100);
});

test('rsi is 0 when every change is a loss', () => {
  const falling = Array.from({ length: 16 }, (_, i) => 100 - i);
  const out = rsi(falling, 14);
  assert.equal(out[14], 0);
});

test('rsi sits near 50 for a symmetric zigzag', () => {
  const zigzag = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 101));
  const out = rsi(zigzag, 14);
  assert.ok(out[39] > 40 && out[39] < 60, `expected mid-range RSI, got ${out[39]}`);
});

test('atr uses true range including gaps', () => {
  const candles = [
    candle(10, 9, 9.5),
    // Gaps up: true range is high - previous close = 12 - 9.5 = 2.5, not 12 - 11 = 1.
    candle(12, 11, 11.5),
    candle(12.5, 11, 12)
  ];
  const out = atr(candles, 2);
  assert.equal(out[0], null);
  // Bar 1 TR = 2.5, bar 2 TR = 1.5 -> average 2.0
  assert.equal(out[2], 2);
});

test('highest and lowest scan the trailing window', () => {
  assert.deepEqual(highest([1, 5, 3, 2], 2), [null, 5, 5, 3]);
  assert.deepEqual(lowest([1, 5, 3, 2], 2), [null, 1, 3, 2]);
});

test('donchian excludes the current bar', () => {
  const candles = [candle(10, 5, 7), candle(11, 6, 8), candle(20, 1, 15)];
  const { upper, lower } = donchian(candles, 2);
  // At bar 2 the channel describes bars 0-1 only, so the bar-2 spike is absent.
  assert.equal(upper[2], 11);
  assert.equal(lower[2], 5);
});

test('indicators return all nulls when history is shorter than the period', () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
  assert.deepEqual(ema([1, 2], 5), [null, null]);
  assert.deepEqual(rsi([1, 2], 5), [null, null]);
});

test('no indicator reads future bars', () => {
  // Truncating the series must not change any earlier value.
  const values = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4];
  const full = ema(values, 5);
  const truncated = ema(values.slice(0, 12), 5);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(truncated[i], full[i], `ema value at ${i} changed when later bars were removed`);
  }
});

test('stddev is zero for a flat series and positive for a varying one', () => {
  const { stddev } = require('../src/indicators');
  assert.equal(stddev([5, 5, 5, 5, 5], 3)[4], 0);
  assert.ok(stddev([1, 2, 3, 4, 5], 3)[4] > 0);
});

test('bollinger bands straddle the mean by the multiplier', () => {
  const { bollinger, sma, stddev } = require('../src/indicators');
  const values = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16];
  const b = bollinger(values, 5, 2);
  const i = values.length - 1;

  assert.equal(b.middle[i], sma(values, 5)[i]);
  assert.equal(Number(b.upper[i].toFixed(8)), Number((b.middle[i] + 2 * stddev(values, 5)[i]).toFixed(8)));
  assert.equal(Number(b.lower[i].toFixed(8)), Number((b.middle[i] - 2 * stddev(values, 5)[i]).toFixed(8)));
  assert.ok(b.bandwidth[i] > 0);
});

test('bollinger bandwidth narrows when the series goes quiet', () => {
  const { bollinger } = require('../src/indicators');
  const noisy = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 6 : -6));
  const quiet = [...noisy, ...Array.from({ length: 40 }, () => 100)];
  const b = bollinger(quiet, 20, 2);

  assert.ok(b.bandwidth.at(-1) < b.bandwidth[39], 'a squeeze must register as a narrower band');
});

test('macd line is the difference of two emas, and the signal smooths it', () => {
  const { macd, ema } = require('../src/indicators');
  const values = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 4 + i * 0.1);
  const m = macd(values, 12, 26, 9);

  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const i = values.length - 1;

  assert.equal(Number(m.line[i].toFixed(10)), Number((fast[i] - slow[i]).toFixed(10)));
  assert.equal(Number(m.histogram[i].toFixed(10)), Number((m.line[i] - m.signal[i]).toFixed(10)));
  assert.equal(m.line.length, values.length, 'padding keeps indexes aligned with the candles');
  assert.equal(m.signal[24], null, 'the signal cannot exist before the macd line does');
});

test('macd reads no future bars', () => {
  const { macd } = require('../src/indicators');
  const values = Array.from({ length: 140 }, (_, i) => 100 + Math.sin(i / 7) * 3);
  const full = macd(values, 12, 26, 9);
  const truncated = macd(values.slice(0, 100), 12, 26, 9);

  for (let i = 0; i < 100; i += 1) {
    assert.equal(truncated.line[i], full.line[i], `macd line changed at ${i}`);
    assert.equal(truncated.signal[i], full.signal[i], `macd signal changed at ${i}`);
  }
});

test('supertrend flips direction with the market and trails behind price', () => {
  const { superTrend } = require('../src/indicators');
  const candles = [];
  for (let i = 0; i < 60; i += 1) {
    const base = 100 + i;      // strong uptrend
    candles.push({ high: base + 1, low: base - 1, close: base, open: base });
  }
  for (let i = 0; i < 60; i += 1) {
    const base = 160 - i * 1.5; // sharp reversal down
    candles.push({ high: base + 1, low: base - 1, close: base, open: base });
  }

  const st = superTrend(candles, 10, 3);

  assert.equal(st.trend[55], 1, 'up during the rally');
  assert.equal(st.trend.at(-1), -1, 'down after the reversal');
  assert.ok(st.band[55] < candles[55].close, 'in an uptrend the stop trails below price');
  assert.ok(st.band.at(-1) > candles.at(-1).close, 'in a downtrend it sits above');
});
