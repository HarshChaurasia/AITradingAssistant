/**
 * MT5 reports bar times in the broker's server timezone encoded as a Unix
 * timestamp. Everything this system stores is true UTC, so the offset the
 * bridge measures is removed here, once, at the boundary.
 */

function toUtcDate(brokerEpochSeconds, offsetSeconds) {
  return new Date((brokerEpochSeconds - offsetSeconds) * 1000);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatUtcDateTime(date) {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function mapRatesToRows(candles, offsetSeconds, symbolId, timeframe) {
  return candles.map((c) => [
    symbolId,
    timeframe,
    formatUtcDateTime(toUtcDate(c.time, offsetSeconds)),
    c.open,
    c.high,
    c.low,
    c.close,
    c.tick_volume ?? 0,
    c.real_volume ?? 0,
    c.spread ?? 0
  ]);
}

module.exports = { toUtcDate, formatUtcDateTime, mapRatesToRows };
