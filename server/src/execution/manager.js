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

// How many times a signal may be sent before it is abandoned. One failed
// send is a rejected order; a hundred is a loop. A EURUSD H4 signal retried
// 278 times over four and a half hours before anything stopped it.
const MAX_SEND_ATTEMPTS = 3;

/**
 * Claim a signal for execution.
 *
 * The UPDATE is the lock: only the caller whose statement actually matched a
 * row may send an order. Two scheduler ticks, a manual run and a Trade-now
 * click can all reach the same signal at once, and exactly one of them wins.
 * Without this there was nothing at all preventing a second execution.
 */
async function claimSignal(signalId) {
  const result = await query(
    `UPDATE signals
        SET status = 'executing', send_attempts = send_attempts + 1
      WHERE id = ? AND status = 'approved'`,
    [signalId]
  );
  return result.affectedRows === 1;
}

async function releaseSignal(signalId, { status, reason }) {
  await query(
    `UPDATE signals
        SET status = ?, decided_at = UTC_TIMESTAMP(), decided_by = 'system',
            decision = JSON_SET(COALESCE(decision, JSON_OBJECT()), '$.sendOutcome', ?)
      WHERE id = ?`,
    [status, String(reason || '').slice(0, 480), signalId]
  );
}

async function executeSignal({ bridge, signal, mode, balance, claimed = false }) {
  // Belt to the claim's braces: a trade row that is not CANCELLED means this
  // signal has already reached the broker once.
  const existing = await query(
    "SELECT id, broker_ticket, status FROM trades WHERE signal_id = ? AND status <> 'CANCELLED'",
    [signal.id]
  );
  if (existing.length > 0) {
    return {
      status: 'skipped',
      reason: `signal ${signal.id} has already been executed (trade ${existing[0].id}, ticket ${existing[0].broker_ticket ?? 'pending'})`,
      tradeId: existing[0].id
    };
  }

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
      strategy_status: signal.strategy_status,
      // The news blackout scales with the bar, so the gate needs to know which.
      timeframe: signal.timeframe
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
    // A signal whose send threw is finished unless it has attempts left. It
    // used to stay 'approved', which is why one of them was retried every
    // minute for four and a half hours.
    await releaseSignal(signal.id, {
      status: signal.send_attempts >= MAX_SEND_ATTEMPTS ? 'rejected' : 'approved',
      reason: error.message
    });
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
    await releaseSignal(signal.id, {
      status: signal.send_attempts >= MAX_SEND_ATTEMPTS ? 'rejected' : 'approved',
      reason: result.comment || 'the broker rejected the order'
    });
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
    // Claim it first. If the UPDATE matched nothing, another worker already
    // has this signal and sending it here would open a second position.
    if (!(await claimSignal(signal.id))) {
      skipped += 1;
      continue;
    }

    const outcome = await executeSignal({
      bridge, signal: { ...signal, send_attempts: signal.send_attempts + 1 }, mode, balance, claimed: true
    });

    // A claimed signal must never be left in 'executing': the next tick would
    // skip it for ever and the operator would see a signal that simply stopped.
    if (outcome.status === 'skipped') {
      const still = await query("SELECT status FROM signals WHERE id = ?", [signal.id]);
      if (still[0]?.status === 'executing') {
        await releaseSignal(signal.id, { status: 'rejected', reason: outcome.reason });
      }
    }

    if (outcome.status === 'filled') filled += 1;
    else if (outcome.status === 'skipped') skipped += 1;
    else failed += 1;
  }

  return { attempted: signals.length, filled, skipped, failed };
}

module.exports = { claimSignal, releaseSignal, MAX_SEND_ATTEMPTS, executeApprovedSignals, executeSignal };
