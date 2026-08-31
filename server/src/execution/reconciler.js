const { query } = require('../db/pool');
const { alertTradeClosed, alertDaySummary } = require('../alerts/events');
const { recordTradeResult } = require('../risk/state');

/**
 * The broker is the source of truth.
 *
 * Every cycle reads open positions from MT5 and reconciles them against the
 * trades table. A trade the app believes is OPEN that the broker no longer
 * reports has been closed - by stop, by target, or by hand in the terminal -
 * and its realised result is recovered from the deal history and pushed into
 * the daily risk state, so the kill switch reacts to what actually happened
 * rather than to what the app assumed.
 *
 * The app never acts on its own cached picture of the account.
 */

async function realisedResultFor(bridge, ticket) {
  let deals = [];
  try {
    deals = (await bridge.deals({ ticket })).deals || [];
  } catch {
    // History can be briefly unavailable. Closing with a zero result is
    // recoverable; leaving the trade open forever is not.
    return null;
  }
  if (deals.length === 0) return null;

  // DEAL_ENTRY_OUT === 1 is the closing leg.
  const closing = deals.filter((d) => Number(d.entry) === 1);
  const source = closing.length > 0 ? closing : deals;

  const pnl = deals.reduce(
    (sum, d) => sum + Number(d.profit || 0) + Number(d.commission || 0) + Number(d.swap || 0),
    0
  );
  const commission = deals.reduce((sum, d) => sum + Number(d.commission || 0), 0);
  const swap = deals.reduce((sum, d) => sum + Number(d.swap || 0), 0);

  return {
    pnl: Number(pnl.toFixed(4)),
    commission: Number(commission.toFixed(4)),
    swap: Number(swap.toFixed(4)),
    closePrice: Number(source[source.length - 1].price)
  };
}

async function snapshotEquity(bridge, mode) {
  try {
    const account = await bridge.account();
    if (!account || account.balance === undefined) return;
    await query(
      `INSERT INTO equity_snapshots (mode, captured_at, balance, equity, margin_free)
       VALUES (?, UTC_TIMESTAMP(), ?, ?, ?)`,
      [mode, account.balance, account.equity, account.margin_free ?? null]
    );
  } catch {
    // A missing snapshot is cosmetic; it must never abort reconciliation.
  }
}

async function reconcile({ bridge, mode = 'demo', logger = console }) {
  const { positions = [] } = await bridge.positions();
  const openTickets = new Set(positions.map((p) => Number(p.ticket)));
  const byTicket = new Map(positions.map((p) => [Number(p.ticket), p]));

  // PENDING is deliberately excluded: those orders were never confirmed, so
  // their absence from the broker means nothing.
  const tracked = await query(
    "SELECT * FROM trades WHERE mode = ? AND status = 'OPEN' AND broker_ticket IS NOT NULL",
    [mode]
  );
  const trackedTickets = new Set(tracked.map((t) => Number(t.broker_ticket)));

  let closed = 0;
  let updated = 0;

  for (const trade of tracked) {
    const ticket = Number(trade.broker_ticket);

    if (openTickets.has(ticket)) {
      // The broker is the source of truth for the fill, so correct the stored
      // entry price and volume from its own record. Some brokers report a
      // zero price in the order result, and an entry of 0 quietly poisons
      // every P&L number computed from the journal.
      const position = byTicket.get(ticket);
      const brokerEntry = Number(position?.price_open);
      const brokerVolume = Number(position?.volume);

      await query(
        `UPDATE trades
            SET last_synced_at = UTC_TIMESTAMP(),
                entry_price = CASE WHEN ? > 0 THEN ? ELSE entry_price END,
                lot         = CASE WHEN ? > 0 THEN ? ELSE lot END
          WHERE id = ?`,
        [brokerEntry || 0, brokerEntry || 0, brokerVolume || 0, brokerVolume || 0, trade.id]
      );
      updated += 1;
      continue;
    }

    const realised = await realisedResultFor(bridge, ticket);
    const pnl = realised ? realised.pnl : 0;

    await query(
      `UPDATE trades
          SET status = 'CLOSED', closed_at = UTC_TIMESTAMP(), last_synced_at = UTC_TIMESTAMP(),
              close_price = ?, pnl = ?, commission = ?, swap = ?, exit_reason = ?
        WHERE id = ?`,
      [
        realised ? realised.closePrice : null,
        pnl,
        realised ? Math.abs(realised.commission) : 0,
        realised ? realised.swap : 0,
        realised ? 'BROKER' : 'BROKER_NO_HISTORY',
        trade.id
      ]
    );

    // Feed the real result into the daily state so the kill switch reacts to
    // what happened rather than to what was expected.
    await recordTradeResult({ mode, pnl });

    await query(
      `INSERT INTO audit_log (logged_at, actor, action, payload)
       VALUES (UTC_TIMESTAMP(), 'system', 'trade_closed', CAST(? AS JSON))`,
      [JSON.stringify({ tradeId: trade.id, ticket, pnl, mode })]
    );

    // Tell someone. Nothing reported closes before, so the first news of a
    // losing trade was the next time the dashboard happened to be open.
    try {
      const [context] = await query(
        `SELECT sym.broker_symbol, sym.digits, st.name AS strategy_name, sig.timeframe,
                TIMESTAMPDIFF(MINUTE, t.opened_at, UTC_TIMESTAMP()) AS held_minutes
           FROM trades t
           JOIN symbols sym       ON sym.id = t.symbol_id
           LEFT JOIN signals sig  ON sig.id = t.signal_id
           LEFT JOIN strategies st ON st.id = sig.strategy_id
          WHERE t.id = ?`,
        [trade.id]
      );
      const [today] = await query(
        `SELECT COALESCE(SUM(pnl), 0) AS day_pnl FROM trades
          WHERE mode = ? AND status = 'CLOSED' AND DATE(closed_at) = UTC_DATE()`,
        [mode]
      );

      await alertTradeClosed({
        symbol: context?.broker_symbol || 'unknown',
        side: trade.side,
        lot: trade.lot,
        ticket,
        mode,
        pnl,
        entry: trade.entry_price,
        exit: realised ? realised.closePrice : null,
        digits: context?.digits,
        strategy: context?.strategy_name,
        timeframe: context?.timeframe,
        heldMinutes: context?.held_minutes,
        exitReason: realised ? 'BROKER' : null,
        dayPnl: today?.day_pnl
      });
    } catch (error) {
      // An alerting outage must never stop reconciliation: the journal being
      // correct matters far more than the message being delivered.
      logger.error(`close alert failed: ${error.message}`);
    }

    closed += 1;
  }

  /**
   * The day's scoreboard, once, after everything that closed this cycle.
   *
   * Sent per cycle rather than per trade on purpose: three positions closing
   * on the same tick would otherwise send three identical summaries, and a
   * summary that repeats stops being read.
   */
  if (closed > 0) {
    try {
      const today = await query(
        `SELECT t.pnl, st.name AS strategy
           FROM trades t
           LEFT JOIN signals sig    ON sig.id = t.signal_id
           LEFT JOIN strategies st  ON st.id = sig.strategy_id
          WHERE t.mode = ? AND t.status = 'CLOSED' AND DATE(t.closed_at) = UTC_DATE()
          ORDER BY t.closed_at`,
        [mode]
      );
      await alertDaySummary({
        mode,
        closedNow: closed,
        trades: today,
        // What the broker still holds. Read from the same snapshot the closes
        // were detected against, so it can never disagree with them.
        openPositions: positions.length
      });
    } catch (error) {
      logger.error(`day summary alert failed: ${error.message}`);
    }
  }

  // A broker position with no trade row. Reported, never touched: closing a
  // position the system does not understand is worse than reporting it.
  const orphans = positions
    .filter((p) => !trackedTickets.has(Number(p.ticket)))
    .map((p) => ({ ticket: Number(p.ticket), symbol: p.symbol, side: p.side, volume: p.volume }));

  if (orphans.length > 0) {
    await query(
      `INSERT INTO audit_log (logged_at, actor, action, payload)
       VALUES (UTC_TIMESTAMP(), 'system', 'orphan_positions', CAST(? AS JSON))`,
      [JSON.stringify({ mode, orphans })]
    );
  }

  await snapshotEquity(bridge, mode);

  return { openAtBroker: positions.length, closed, updated, orphans };
}

module.exports = { reconcile };
