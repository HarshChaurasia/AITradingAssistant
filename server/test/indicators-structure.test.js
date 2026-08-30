const test = require('node:test');
const assert = require('node:assert/strict');

const { swings, fairValueGaps } = require('../src/indicators');

function bar(high, low) {
  return { open: (high + low) / 2, high, low, close: (high + low) / 2 };
}

// A clear peak at index 4 and a clear trough at index 9.
const SERIES = [
  bar(10, 8), bar(12, 9), bar(14, 11), bar(16, 13), bar(20, 15),
  bar(15, 12), bar(13, 10), bar(11, 8), bar(9, 6), bar(7, 4),
  bar(9, 6), bar(11, 8), bar(13, 10)
];

test('a swing is published only once it could actually be known', () => {
  const { highs } = swings(SERIES, 2);

  // The peak is at index 4, but it needs two bars either side to be confirmed,
  // so nothing may report it before index 6.
  assert.equal(highs[4], null, 'the pivot bar itself cannot know it is a pivot');
  assert.equal(highs[5], null, 'nor can the bar after it');
  assert.deepEqual(highs[6], { index: 4, price: 20 });
});

test('the lookback controls how late a swing becomes visible', () => {
  assert.deepEqual(swings(SERIES, 1).highs[5], { index: 4, price: 20 });
  assert.equal(swings(SERIES, 3).highs[6], null);
  assert.deepEqual(swings(SERIES, 3).highs[7], { index: 4, price: 20 });
});

test('a swing low is found the same way', () => {
  const { lows } = swings(SERIES, 2);
  assert.equal(lows[9], null, 'the trough bar cannot know it is a trough');
  assert.deepEqual(lows[11], { index: 9, price: 4 });
});

test('the reported swing is the most recent confirmed one, not the highest ever', () => {
  const twoPeaks = [
    bar(10, 8), bar(12, 9), bar(30, 20), bar(12, 9), bar(10, 8),
    bar(11, 9), bar(18, 14), bar(11, 9), bar(10, 8), bar(9, 7)
  ];
  const { highs } = swings(twoPeaks, 2);

  assert.equal(highs.at(-1).price, 18, 'the later, lower peak is the current structure');
});

test('an empty or too-short series produces nulls rather than throwing', () => {
  assert.deepEqual(swings([], 2), { highs: [], lows: [] });
  const short = swings([bar(10, 8), bar(11, 9)], 2);
  assert.deepEqual(short.highs, [null, null]);
});

test('a bullish fair value gap is the range the market skipped', () => {
  // Bar 0 tops at 10, bar 2 bottoms at 12: nothing traded between 10 and 12.
  const gapped = [bar(10, 8), bar(14, 9), bar(16, 12)];
  const { bullish } = fairValueGaps(gapped);

  assert.equal(bullish[0], null);
  assert.equal(bullish[1], null, 'a three-bar pattern is not complete on bar two');
  assert.deepEqual(bullish[2], { index: 2, from: 10, to: 12 });
});

test('a bearish gap is the mirror of it', () => {
  const gapped = [bar(16, 12), bar(14, 9), bar(10, 8)];
  const { bearish } = fairValueGaps(gapped);
  assert.deepEqual(bearish[2], { index: 2, from: 10, to: 12 });
});

test('overlapping bars leave no gap at all', () => {
  const overlapping = [bar(12, 8), bar(13, 9), bar(14, 10)];
  const { bullish, bearish } = fairValueGaps(overlapping);
  assert.equal(bullish.at(-1), null);
  assert.equal(bearish.at(-1), null);
});

test('the newest gap replaces the older one', () => {
  const two = [
    bar(10, 8), bar(14, 9), bar(16, 12),
    bar(20, 17), bar(26, 18), bar(30, 27)
  ];
  const { bullish } = fairValueGaps(two);
  assert.deepEqual(bullish[5], { index: 5, from: 20, to: 27 });
});

test('every indicator returns one value per bar, so indices never shift', () => {
  // A strategy reads context[index] against candles[index]. An indicator that
  // returned a shorter array would silently misalign every signal it produced.
  const s = swings(SERIES, 2);
  const g = fairValueGaps(SERIES);
  for (const series of [s.highs, s.lows, g.bullish, g.bearish]) {
    assert.equal(series.length, SERIES.length);
  }
});
