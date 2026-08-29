const { query, withConnection } = require('../db/pool');

// Brokers list thousands of instruments - MetaQuotes-Demo alone has ~12,500.
// One statement per symbol means one disk sync per symbol, which measured at
// roughly 0.3 rows/second. Batching turns that into a couple of dozen writes.
const CHUNK_SIZE = 500;

const UPSERT_PREFIX = `
  INSERT INTO symbols
    (broker_symbol, description, digits, point, contract_size, tick_size, tick_value,
     min_lot, lot_step, max_lot, spread_points, currency_profit, currency_margin, synced_at)
  VALUES `;

const UPSERT_SUFFIX = `
  ON DUPLICATE KEY UPDATE
    description     = VALUES(description),
    digits          = VALUES(digits),
    point           = VALUES(point),
    contract_size   = VALUES(contract_size),
    tick_size       = VALUES(tick_size),
    tick_value      = VALUES(tick_value),
    min_lot         = VALUES(min_lot),
    lot_step        = VALUES(lot_step),
    max_lot         = VALUES(max_lot),
    spread_points   = VALUES(spread_points),
    currency_profit = VALUES(currency_profit),
    currency_margin = VALUES(currency_margin),
    synced_at       = UTC_TIMESTAMP()
`;
// enabled is deliberately absent from the UPDATE clause: a re-sync must never
// silently switch a symbol on or off behind the operator.

async function syncSymbols(bridge) {
  const payload = await bridge.symbols();
  const symbols = payload.symbols || [];

  // Counting rows before and after is exact. Inferring insert-vs-update from
  // affectedRows is not: MySQL reports 1, 2 or 0 depending on whether the row
  // was created, changed, or matched but left identical.
  const [before] = await query('SELECT COUNT(*) AS n FROM symbols');

  const rows = symbols.map((s) => [
    s.name,
    s.description || null,
    s.digits,
    s.point,
    s.contract_size,
    s.tick_size || s.point,
    s.tick_value,
    s.min_lot,
    s.lot_step,
    s.max_lot,
    s.spread ?? null,
    s.currency_profit || null,
    s.currency_margin || null
  ]);

  await withConnection(async (conn) => {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())').join(',');
      await conn.query(UPSERT_PREFIX + placeholders + UPSERT_SUFFIX, chunk.flat());
    }
  });

  const [after] = await query('SELECT COUNT(*) AS n FROM symbols');
  const inserted = after.n - before.n;

  return { inserted, updated: symbols.length - inserted, total: symbols.length };
}

async function listSymbols({ enabledOnly = false } = {}) {
  const sql = enabledOnly
    ? 'SELECT * FROM symbols WHERE enabled = 1 ORDER BY broker_symbol'
    : 'SELECT * FROM symbols ORDER BY broker_symbol';
  return query(sql);
}

async function setSymbolEnabled(id, enabled) {
  await query('UPDATE symbols SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
}

module.exports = { syncSymbols, listSymbols, setSymbolEnabled };
