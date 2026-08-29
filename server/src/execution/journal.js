const { query } = require('../db/pool');

const SELECT = `
  SELECT t.*, sym.broker_symbol, sig.reason AS signal_reason
    FROM trades t
    JOIN symbols sym ON sym.id = t.symbol_id
    LEFT JOIN signals sig ON sig.id = t.signal_id
`;

async function listTrades({ mode, status, limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 1000);
  const where = [];
  const params = [];
  if (mode) { where.push('t.mode = ?'); params.push(mode); }
  if (status) { where.push('t.status = ?'); params.push(status); }

  return query(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY t.id DESC LIMIT ${safeLimit}`,
    params
  );
}

async function tradeStats({ mode = 'demo' } = {}) {
  const rows = await query(
    `SELECT
       SUM(status = 'OPEN')                        AS openCount,
       SUM(status = 'CLOSED')                      AS closedCount,
       COALESCE(SUM(CASE WHEN status = 'CLOSED' THEN pnl ELSE 0 END), 0) AS netPnl,
       SUM(status = 'CLOSED' AND pnl > 0)          AS wins,
       SUM(status = 'CLOSED' AND pnl <= 0)         AS losses
     FROM trades WHERE mode = ?`,
    [mode]
  );
  const r = rows[0];
  const closed = Number(r.closedCount || 0);
  const wins = Number(r.wins || 0);

  return {
    open: Number(r.openCount || 0),
    closed,
    netPnl: Number(r.netPnl || 0),
    wins,
    losses: Number(r.losses || 0),
    winRatePct: closed > 0 ? (wins / closed) * 100 : 0
  };
}

async function equityHistory({ mode = 'demo', limit = 500 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 5000);
  const rows = await query(
    `SELECT captured_at, balance, equity, margin_free
       FROM equity_snapshots WHERE mode = ?
      ORDER BY id DESC LIMIT ${safeLimit}`,
    [mode]
  );
  return rows.reverse();
}

module.exports = { listTrades, tradeStats, equityHistory };
