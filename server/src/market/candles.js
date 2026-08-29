const { query, withConnection } = require('../db/pool');
const { mapRatesToRows } = require('./rates');

const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

// Chunked so a large backfill never builds a single oversized statement.
const CHUNK_SIZE = 500;

const UPSERT_PREFIX = `
  INSERT INTO candles
    (symbol_id, timeframe, open_time, open, high, low, close, tick_volume, real_volume, spread)
  VALUES `;

const UPSERT_SUFFIX = `
  ON DUPLICATE KEY UPDATE
    open        = VALUES(open),
    high        = VALUES(high),
    low         = VALUES(low),
    close       = VALUES(close),
    tick_volume = VALUES(tick_volume),
    real_volume = VALUES(real_volume),
    spread      = VALUES(spread)
`;

async function syncCandles(bridge, { symbolId, brokerSymbol, timeframe, count = 500 }) {
  if (!TIMEFRAMES.includes(timeframe)) {
    throw new Error(`unsupported timeframe: ${timeframe}`);
  }

  const payload = await bridge.candles({ symbol: brokerSymbol, timeframe, count });
  const received = payload.candles || [];
  if (received.length === 0) return { received: 0, stored: 0 };

  // Refuse to store bars the bridge cannot timestamp with confidence. A candle
  // filed under the wrong hour is worse than a missing candle: it corrupts
  // every backtest and news filter downstream, silently and permanently.
  if (payload.offset_trustworthy === false) {
    throw new Error(
      'the broker UTC offset is unknown (the market is closed, so no fresh tick is available). ' +
      'Set MT5_SERVER_UTC_OFFSET_SECONDS in server/.env, or sync during market hours.'
    );
  }

  const rows = mapRatesToRows(received, payload.server_utc_offset_seconds || 0, symbolId, timeframe);

  let stored = 0;
  await withConnection(async (conn) => {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',');
      await conn.query(UPSERT_PREFIX + placeholders + UPSERT_SUFFIX, chunk.flat());
      stored += chunk.length;
    }
  });

  return { received: received.length, stored };
}

async function getCandles({ symbolId, timeframe, limit = 500 }) {
  // LIMIT is interpolated, not bound: MySQL's prepared-statement protocol
  // rejects a placeholder there. The value is coerced to a bounded integer
  // first, so nothing user-supplied reaches the SQL string.
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 20000);

  // Take the most recent bars, then hand them back oldest-first so the chart
  // and the strategy engine both read forward in time.
  const rows = await query(
    `SELECT open_time, open, high, low, close, tick_volume, spread
       FROM candles
      WHERE symbol_id = ? AND timeframe = ?
      ORDER BY open_time DESC
      LIMIT ${safeLimit}`,
    [symbolId, timeframe]
  );

  return rows
    .reverse()
    .map((r) => ({ ...r, open_time: new Date(r.open_time).toISOString() }));
}

module.exports = { syncCandles, getCandles, TIMEFRAMES };
