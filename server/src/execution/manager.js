const { query } = require('../db/pool');
const { assessSignal } = require('../risk/engine');
const { countOpenPositions } = require('../signals/generator');
const { alertOrderFilled, alertOrderFailed } = require('../alerts/events');

/**
 * Turns approved signals into broker orders.
 *
 * Two properties matter more than anything else here:
 *
 *   1. The risk engine runs AGAIN immediately before sending. Approval
 *      happened at some earlier moment; since then the kill switch may have
 *      tripped, the daily loss cap may have been hit, or another position may
 *      have opened. A stale approval is not a licence to trade.
 *
 *   2. The trade row is written BEFORE the order is sent. If the order
 *      succeeds and this process dies before handling the response, the row
 *      is the evidence that something may be open at the broker. An
 *      untracked position is the worst state this system can reach.
 */

async function loadApprovedSignals(mode) {
  return query(
    `SELECT sig.*, st.status AS strategy_status
       FROM signals sig
       JOIN strategies st ON st.id = sig.strategy_id
      WHERE sig.mode = ? AND sig.status = 'approved'
      ORDER BY sig.id`,
    [mode]
  );
}

async function executeSignal({ bridge, signal, mode, balance }) {
  const symbolRows = await query('SELECT * FROM symbols WHERE id = ?', [signal.symbol_id]);
  if (symbolRows.length === 0) {
    return { status: 'skipped', reason: `unknown symbolId ${signal.symbol_id}` };
  }
  const symbol = symbolRows[0];

  // Re-assess. The world has moved on since approval.
  const decision = await assessSignal({
    signal: {
      side: signal.side,
      entry: Number(signal.entry),
      sl: Number(signal.sl),
      tp: signal.tp === null ? null : Number(signal.tp),
      symbol_id: signal.symbol_id,
      strategy_status: signal.strategy_status
    },
    symbol,
    mode,
    balance,
    openPositions: await countOpenPositions(mode)
  });

  if (!decision.allowed) {
    await query(
      `UPDATE signals
          SET status = 'rejected', decided_at = UTC_TIMESTAMP(), decided_by = 'system',
              decision = JSON_SET(COALESCE(decision, JSON_OBJECT()), '$.atSendTime', CAST(? AS JSON))
        WHERE id = ?`,
      [JSON.stringify(decision), signal.id]
    );
    return { status: 'skipped', reason: decision.denialReasons.join('; ') };
  }

  // Write the row first, so a crash mid-send leaves evidence.
  const inserted = await query(
    `INSERT INTO trades
       (signal_id, symbol_id, mode, side, lot, entry_price, requested_price, sl, tp,
        opened_at, status)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, UTC_TIMESTAMP(), 'PENDING')`,
    [
      signal.id, signal.symbol_id, mode, signal.side, decision.lot,
      Number(signal.entry), Number(signal.sl),
      signal.tp === null ? null : Number(signal.tp)
    ]
  );
  const tradeId = inserted.insertId;

  let result;
  try {
    result = await bridge.order({
      symbol: symbol.broker_symbol,
      side: signal.side,
      lot: decision.lot,
      sl: Number(signal.sl),
      tp: signal.tp === null ? null : Number(signal.tp),
      comment: `sig-${signal.id}`
    });
  } catch (error) {
    await query(
      `UPDATE trades SET status = 'CANCELLED', broker_comment = ?, last_synced_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [String(error.message).slice(0, 255), tradeId]
    );
    return { status: 'failed', tradeId, reason: error.message };
  }

  if (!result.ok) {
    await query(
      `UPDATE trades SET status = 'CANCELLED', retcode = ?, broker_comment = ?,
              last_synced_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [result.retcode ?? null, String(result.comment || 'rejected').slice(0, 255), tradeId]
    );
    alertOrderFailed({
      symbol: symbol.broker_symbol,
      reason: result.comment || 'rejected',
      mode
    }).catch(() => {});
    return { status: 'failed', tradeId, reason: result.comment || 'the broker rejected the order' };
  }

  // Some brokers return price 0 in the order result rather than the fill
  // price, and `??` would happily store that zero - which silently corrupts
  // every P&L figure derived from the journal. Treat non-positive as missing;
  // the reconciler then corrects it from the broker's own position record.
  const fillPrice = Number(result.price) > 0 ? Number(result.price) : Number(signal.entry);
  const filledLot = Number(result.volume) > 0 ? Number(result.volume) : decision.lot;

  await query(
    `UPDATE trades
        SET status = 'OPEN', broker_ticket = ?, retcode = ?, broker_comment = ?,
            entry_price = ?, lot = ?, last_synced_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [
      result.ticket ?? null, result.retcode ?? null,
      String(result.comment || '').slice(0, 255),
      fillPrice,
      filledLot,
      tradeId
    ]
  );

  await query(
    `UPDATE signals SET status = 'executed', decided_at = UTC_TIMESTAMP() WHERE id = ?`,
    [signal.id]
  );

  await query(
    `INSERT INTO audit_log (logged_at, actor, action, payload)
     VALUES (UTC_TIMESTAMP(), 'system', 'order_filled', CAST(? AS JSON))`,
    [JSON.stringify({ tradeId, signalId: signal.id, ticket: result.ticket, lot: decision.lot, mode })]
  );

  alertOrderFilled({
    symbol: symbol.broker_symbol, side: signal.side, lot: decision.lot,
    ticket: result.ticket, mode
  }).catch(() => {});

  return { status: 'filled', tradeId, ticket: result.ticket };
}

async function executeApprovedSignals({ bridge, mode = 'demo', balance = 10000 }) {
  const signals = await loadApprovedSignals(mode);

  let filled = 0;
  let skipped = 0;
  let failed = 0;

  for (const signal of signals) {
    const outcome = await executeSignal({ bridge, signal, mode, balance });
    if (outcome.status === 'filled') filled += 1;
    else if (outcome.status === 'skipped') skipped += 1;
    else failed += 1;
  }

  return { attempted: signals.length, filled, skipped, failed };
}

module.exports = { executeApprovedSignals, executeSignal };
