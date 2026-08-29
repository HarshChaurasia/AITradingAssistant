const test = require('node:test');
const assert = require('node:assert/strict');

const { toUtcDate, formatUtcDateTime, mapRatesToRows } = require('../src/market/rates');

test('toUtcDate subtracts the broker offset', () => {
  // Broker clock says 12:00 while true UTC is 09:00 -> offset is +3h.
  const brokerEpoch = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
  const utc = toUtcDate(brokerEpoch, 3 * 3600);
  assert.equal(utc.toISOString(), '2026-01-15T09:00:00.000Z');
});

test('toUtcDate is a no-op when the broker runs on UTC', () => {
  const brokerEpoch = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
  assert.equal(toUtcDate(brokerEpoch, 0).toISOString(), '2026-01-15T12:00:00.000Z');
});

test('formatUtcDateTime renders a MySQL DATETIME in UTC', () => {
  const d = new Date('2026-01-15T09:05:07.000Z');
  assert.equal(formatUtcDateTime(d), '2026-01-15 09:05:07');
});

test('mapRatesToRows shifts times and preserves OHLCV ordering', () => {
  const candles = [
    { time: Date.UTC(2026, 0, 15, 12, 0, 0) / 1000, open: 1.1, high: 1.2, low: 1.0, close: 1.15,
      tick_volume: 42, real_volume: 7, spread: 3 }
  ];
  const rows = mapRatesToRows(candles, 2 * 3600, 9, 'H1');
  assert.deepEqual(rows, [[9, 'H1', '2026-01-15 10:00:00', 1.1, 1.2, 1.0, 1.15, 42, 7, 3]]);
});

test('mapRatesToRows tolerates missing volume fields', () => {
  const candles = [
    { time: Date.UTC(2026, 0, 15, 0, 0, 0) / 1000, open: 1, high: 1, low: 1, close: 1 }
  ];
  const rows = mapRatesToRows(candles, 0, 1, 'M5');
  assert.deepEqual(rows, [[1, 'M5', '2026-01-15 00:00:00', 1, 1, 1, 1, 0, 0, 0]]);
});
