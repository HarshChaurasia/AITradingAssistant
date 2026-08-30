const { query } = require('../db/pool');
const { loadOperationsSettings } = require('../settings/operations');

/**
 * Is this market open right now, according to the broker?
 *
 * The rule "don't trade instruments that are shut at the weekend" cannot be
 * hardcoded. On this account BTCUSD trades straight through Saturday while
 * EURUSD does not, several instruments close early on Friday, and some take a
 * daily break. Nor can it be read from a weekly calendar: the MetaTrader5
 * Python package has no session API at all (symbol_info_session_trade is
 * MQL5-only). So the bridge asks the direct question with order_check - would
 * this order be accepted right now - and the answer is cached here.
 *
 * Because it is a cached snapshot rather than a calendar, staleness matters:
 * a status nobody has refreshed for an hour is not evidence that a market is
 * open, and this module treats it as a refusal.
 */

// The scheduler refreshes every minute. Five minutes of slack absorbs a
// missed tick or a slow broker without ever letting a genuinely stale answer
// authorise an order.
const MAX_STATUS_AGE_SECONDS = 300;

function ageSeconds(checkedAt, now) {
  if (!checkedAt) return null;
  const at = checkedAt instanceof Date ? checkedAt.getTime() : Date.parse(`${String(checkedAt).replace(' ', 'T')}Z`);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now.getTime() - at) / 1000));
}

/**
 * Decide whether a symbol can be traded at this instant.
 *
 * Returns a reason in every case, including the open one. The risk gate
 * renders it verbatim, and "the broker accepts orders" is far more useful on
 * screen than a bare tick.
 */
function marketStatus({ symbol, now = new Date(), maxAgeSeconds = MAX_STATUS_AGE_SECONDS }) {
  const age = ageSeconds(symbol.market_checked_at, now);

  // Never probed is not the same as probed and shut, and only one of the two
  // is fixed by pressing Sync.
  if (age === null) {
    return {
      open: false,
      known: false,
      ageSeconds: null,
      reason: `market status for ${symbol.broker_symbol} has never been checked — sync it, or wait for the next scheduler tick`
    };
  }

  // Failing open on a stale status would put this gate back where it started:
  // an order sent into a shut market because nobody had current information.
  if (age > maxAgeSeconds) {
    return {
      open: false,
      known: false,
      ageSeconds: age,
      reason: `market status for ${symbol.broker_symbol} is ${age}s old (limit ${maxAgeSeconds}s) — the broker link may be down`
    };
  }

  const open = symbol.market_open === 1 || symbol.market_open === true;
  return {
    open,
    known: true,
    ageSeconds: age,
    reason: symbol.market_reason || (open ? 'the broker accepts orders' : 'the broker reports the market closed')
  };
}

/**
 * Refresh the cached status for the symbols that matter.
 *
 * Deliberately not every symbol: the broker advertises over twelve thousand,
 * each needs its own round trip, and only the handful that are watched or
 * enabled can ever produce a signal. Symbols are probed one at a time because
 * concurrent requests to a single MT5 terminal are how the bridge stops
 * answering.
 */
async function refreshMarketStatus(bridge, {
  symbols = null, logger = console, queryFn = query, staleTickSeconds = null
} = {}) {
  const staleAfter = staleTickSeconds
    ?? (await loadOperationsSettings().catch(() => ({ staleTickSeconds: 600 }))).staleTickSeconds;

  const rows = symbols || await queryFn(
    'SELECT id, broker_symbol FROM symbols WHERE watched = 1 OR enabled = 1 ORDER BY broker_symbol'
  );

  let updated = 0;
  const failures = [];

  for (const symbol of rows) {
    try {
      const result = await bridge.marketStatus(symbol.broker_symbol, staleAfter);
      await queryFn(
        `UPDATE symbols
            SET trade_mode = ?, market_open = ?, market_reason = ?,
                tick_age_seconds = ?, market_checked_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [
          result.trade_mode ?? null,
          result.open ? 1 : 0,
          String(result.reason || '').slice(0, 255),
          result.tick_age_seconds ?? null,
          symbol.id
        ]
      );
      updated += 1;
    } catch (error) {
      // One unreachable symbol must not cost the others their status. The row
      // keeps its old timestamp, so it goes stale and the gate refuses it -
      // which is the correct outcome for a symbol we cannot ask about.
      failures.push({ symbol: symbol.broker_symbol, error: error.message });
      logger.error(`market status probe failed for ${symbol.broker_symbol}: ${error.message}`);
    }
  }

  return { requested: rows.length, updated, failures };
}

async function watchedSymbols() {
  return query(
    'SELECT id, broker_symbol FROM symbols WHERE watched = 1 OR enabled = 1 ORDER BY broker_symbol'
  );
}

module.exports = {
  marketStatus,
  refreshMarketStatus,
  watchedSymbols,
  MAX_STATUS_AGE_SECONDS
};
