const { query } = require('../db/pool');
const { getCandles } = require('../market/candles');
const { getStrategy, mergeParams } = require('../strategies/registry');
const { assessSignal } = require('../risk/engine');
const { loadOperationsSettings } = require('../settings/operations');
const { loadScopes, scopeAllows, scopeOnlyTimeframes } = require('../strategies/scopes');
const { loadPromotedParams } = require('../strategies/promotions');

const DEFAULT_TIMEFRAME = 'H1';
const HISTORY_BARS = 500;

async function countOpenPositions(mode) {
  const rows = await query(
    "SELECT COUNT(*) AS n FROM trades WHERE mode = ? AND status = 'OPEN'",
    [mode]
  );
  return rows[0].n;
}

/**
 * Runs enabled strategies over stored candles and persists what they produce.
 *
 * This calls the SAME evaluate() the backtester calls. That is the whole point
 * of the strategy contract: if live and backtest ever run different code, the
 * demo period measures nothing about the strategy.
 */
/**
 * Generate signals for one timeframe.
 *
 * Split out from generateSignals so several timeframes can be run in one
 * pass: each is an independent stream of candidates against the same account,
 * which is what makes comparing their results meaningful.
 */
async function generateForTimeframe({
  mode, now, timeframe, strategies, symbols, autoApprove, scopes = new Map(),
  promoted = new Map()
}) {

  let evaluated = 0;
  let created = 0;
  let skipped = 0;
  let outOfScope = 0;

  for (const strategyRow of strategies) {
    let strategy;
    try {
      strategy = getStrategy(strategyRow.name);
    } catch {
      skipped += 1;
      continue; // Registered in the database but no longer shipped in code.
    }

    for (const symbol of symbols) {
      // A strategy with no scope rows runs everywhere, so this only ever
      // narrows a strategy someone has deliberately narrowed.
      if (!scopeAllows(scopes, { strategyId: strategyRow.id, symbolId: symbol.id, timeframe })) {
        outOfScope += 1;
        continue;
      }

      const candles = await getCandles({ symbolId: symbol.id, timeframe, limit: HISTORY_BARS });
      if (candles.length < 2) { skipped += 1; continue; }

      evaluated += 1;

      /**
       * Promoted parameters win.
       *
       * A promotion is evidence about a specific set of NUMBERS - measured
       * here, macd-trend clears its holdout on XAUUSD H1 with a 5.25 ATR
       * target and fails at the shipped 3.0. Trading the default while citing
       * the promoted result would be the worst of both worlds: a backtest's
       * confidence attached to a bet it never covered.
       */
      const promotedParams = promoted.get(`${strategyRow.id}|${symbol.id}|${timeframe}`);
      const params = mergeParams(strategy, promotedParams || strategyRow.params);
      const context = strategy.prepare(candles, params);

      // Only the last CLOSED bar is considered. The newest bar is still
      // forming, and acting on a price that can still move is the live
      // equivalent of the backtest's lookahead bug.
      const index = candles.length - 2;
      const raw = strategy.evaluate(candles, index, params, context);
      if (!raw) continue;

      const barTime = candles[index].open_time.slice(0, 19).replace('T', ' ');

      const decision = await assessSignal({
        signal: { ...raw, symbol_id: symbol.id, strategy_status: strategyRow.status, timeframe },
        symbol,
        mode,
        balance: Number(process.env.ACCOUNT_BALANCE_HINT || 10000),
        openPositions: await countOpenPositions(mode),
        now
      });

      const status = decision.allowed ? (autoApprove ? 'approved' : 'new') : 'rejected';
      const autoApproved = decision.allowed && autoApprove ? 1 : 0;

      const result = await query(
        `INSERT IGNORE INTO signals
           (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time, side,
            entry, sl, tp, lot, confidence, reason, features, decision, status,
            auto_approved, decided_at, decided_by)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?,
                 CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?, ?)`,
        [
          strategyRow.id, symbol.id, timeframe, mode, barTime, raw.side,
          raw.entry, raw.sl, raw.tp ?? null, decision.lot || null,
          raw.confidence ?? null, raw.reason || null,
          JSON.stringify(raw.features || {}),
          JSON.stringify(decision),
          status,
          autoApproved,
          status === 'new' ? null : new Date().toISOString().slice(0, 19).replace('T', ' '),
          status === 'new' ? null : 'system'
        ]
      );

      if (result.affectedRows > 0) created += 1;
    }
  }

  return { evaluated, created, skipped, outOfScope };
}

/**
 * Runs enabled strategies over every traded timeframe.
 *
 * Several timeframes at once is deliberate: it is the only way to find out
 * which one this edge actually works on. It is also several times the trade
 * frequency, so the concurrent-position limit and the daily loss cap are
 * doing real work here rather than sitting idle.
 */
async function generateSignals({
  mode = 'demo',
  now = new Date(),
  timeframe = null,
  timeframes = null,
  settings = null
} = {}) {
  const ops = settings || (await loadOperationsSettings());

  // A single `timeframe` still wins when passed - the tests and the manual
  // paths use it - otherwise every configured timeframe runs.
  const active = timeframe ? [timeframe] : (timeframes || ops.tradedTimeframes || [DEFAULT_TIMEFRAME]);

  // Auto-approval is the operator's switch, not the mode's. With it off a
  // signal waits as `new` for a click; the execution path is identical either
  // way, so an approved signal behaves exactly like an auto-approved one.
  const autoApprove = ops.autoTradeEnabled && (mode !== 'live' || ops.autoTradeLive);

  const strategies = await query('SELECT * FROM strategies WHERE enabled = 1 AND superseded_at IS NULL');
  const symbols = await query('SELECT * FROM symbols WHERE enabled = 1');
  const scopes = await loadScopes();
  // The parameters each combination actually earned its promotion with.
  const promoted = await loadPromotedParams();

  // Timeframes reached only through a scope row. See scopeOnlyTimeframes.
  const extras = scopeOnlyTimeframes({ strategies, scopes, active });

  const byTimeframe = {};
  let evaluated = 0;
  let created = 0;
  let skipped = 0;
  let outOfScope = 0;

  const passes = [
    ...active.map((tf) => ({ timeframe: tf, strategies })),
    ...[...extras.entries()].map(([tf, only]) => ({ timeframe: tf, strategies: only, scopedOnly: true }))
  ];

  for (const pass of passes) {
    const result = await generateForTimeframe({
      mode, now, timeframe: pass.timeframe, strategies: pass.strategies, symbols,
      autoApprove, scopes, promoted
    });
    byTimeframe[pass.timeframe] = { ...result, scopedOnly: pass.scopedOnly === true };
    evaluated += result.evaluated;
    created += result.created;
    skipped += result.skipped;
    outOfScope += result.outOfScope;
  }

  return {
    evaluated,
    created,
    skipped,
    outOfScope,
    autoApprove,
    timeframes: passes.map((p) => p.timeframe),
    byTimeframe
  };
}

module.exports = { generateSignals, generateForTimeframe, countOpenPositions };
