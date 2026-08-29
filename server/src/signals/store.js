const { query } = require('../db/pool');

const SELECT = `
  SELECT sig.*, st.name AS strategy_name, st.status AS strategy_status, sym.broker_symbol
    FROM signals sig
    JOIN strategies st ON st.id = sig.strategy_id
    JOIN symbols   sym ON sym.id = sig.symbol_id
`;

async function listSignals({ mode, status, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 500);
  const where = [];
  const params = [];
  if (mode) { where.push('sig.mode = ?'); params.push(mode); }
  if (status) { where.push('sig.status = ?'); params.push(status); }

  return query(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY sig.generated_at DESC, sig.id DESC LIMIT ${safeLimit}`,
    params
  );
}

async function getSignal(id) {
  const rows = await query(`${SELECT} WHERE sig.id = ?`, [id]);
  return rows[0] || null;
}

async function approveSignal(id) {
  await query(
    `UPDATE signals SET status = 'approved', decided_at = UTC_TIMESTAMP(), decided_by = 'user'
      WHERE id = ? AND status = 'new'`,
    [id]
  );
  return getSignal(id);
}

async function rejectSignal(id, reason) {
  await query(
    `UPDATE signals
        SET status = 'rejected', decided_at = UTC_TIMESTAMP(), decided_by = 'user',
            decision = JSON_SET(COALESCE(decision, JSON_OBJECT()), '$.userReason', ?)
      WHERE id = ?`,
    [String(reason || 'rejected by the operator'), id]
  );
  return getSignal(id);
}

/**
 * A signal describes a setup on one bar. Once that bar is well in the past the
 * setup no longer exists, so acting on it would be trading a stale idea.
 */
async function expireStaleSignals({ olderThanMinutes = 60, mode } = {}) {
  const minutes = Math.max(Number.parseInt(olderThanMinutes, 10) || 60, 1);
  const params = [];
  let modeClause = '';
  if (mode) { modeClause = 'AND mode = ?'; params.push(mode); }

  const result = await query(
    `UPDATE signals
        SET status = 'expired', decided_at = UTC_TIMESTAMP(), decided_by = 'system'
      WHERE status = 'new'
        AND generated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${minutes} MINUTE)
        ${modeClause}`,
    params
  );
  return result.affectedRows || 0;
}

module.exports = { listSignals, getSignal, approveSignal, rejectSignal, expireStaleSignals };
