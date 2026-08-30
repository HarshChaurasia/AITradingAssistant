const { query } = require('../db/pool');
const { countOpenPositions } = require('../signals/generator');
const { evaluateSymbolTimeframe } = require('./evaluate');
const { loadEvidence } = require('./index');
const { loadOperationsSettings } = require('../settings/operations');
const { alertOpportunity } = require('../alerts/events');

/**
 * The engine behind the live scanner screen.
 *
 * A full sweep - every watched symbol against every scanned timeframe against
 * every strategy - takes long enough that running it inside a request would
 * make the dashboard feel broken. So it runs in the background and publishes
 * a snapshot: progress while it works, results when it finishes.
 *
 * The snapshot is held in memory on purpose. It is a view of this instant,
 * derived entirely from stored candles, and persisting it would create rows
 * that look like signals the system acted on. Signals are the only record of
 * intent; the scanner never writes one.
 */

const MAX_FEED = 60;

function emptyProgress() {
  return { phase: 'idle', done: 0, total: 0, symbol: null, timeframe: null };
}

function createScanRunner({
  loadSettingsFn = loadOperationsSettings,
  evaluateFn = evaluateSymbolTimeframe,
  loadEvidenceFn = loadEvidence,
  countOpenPositionsFn = countOpenPositions,
  queryFn = query,
  alertFn = alertOpportunity,
  now = () => new Date(),
  logger = console
} = {}) {
  let running = false;
  let progress = emptyProgress();
  let last = null;
  const feed = [];
  // Keyed by symbol|strategy|timeframe|barTime, holding the time we last said
  // something about it. Without this a setup that persists for a whole session
  // sends a Telegram message on every single scan.
  const announced = new Map();

  function push(event) {
    feed.unshift({ ...event, at: now().toISOString() });
    if (feed.length > MAX_FEED) feed.length = MAX_FEED;
  }

  async function announce({ opportunity, cooldownMinutes, mode }) {
    const key = `${opportunity.symbol}|${opportunity.strategy}|${opportunity.timeframe}|${opportunity.barTime}`;
    const previous = announced.get(key);
    const cutoff = now().getTime() - cooldownMinutes * 60000;
    if (previous && previous > cutoff) return false;

    announced.set(key, now().getTime());
    // Forget entries older than a day so a long-lived process does not grow
    // an unbounded map of setups nobody will ever see again.
    for (const [k, at] of announced) {
      if (at < now().getTime() - 86400000) announced.delete(k);
    }

    await alertFn({ ...opportunity, mode });
    return true;
  }

  async function scan({ mode = process.env.TRADING_MODE || 'demo' } = {}) {
    if (running) return { skipped: true, reason: 'a scan is already in flight' };
    running = true;
    const startedAt = now();

    try {
      const settings = await loadSettingsFn();
      const timeframes = settings.scanTimeframes;
      const balance = Number(process.env.ACCOUNT_BALANCE_HINT || 10000);

      const strategyRows = await queryFn('SELECT * FROM strategies ORDER BY name');
      const symbols = await queryFn(
        'SELECT * FROM symbols WHERE watched = 1 OR enabled = 1 ORDER BY broker_symbol'
      );

      const openPositions = await countOpenPositionsFn(mode);
      const evidenceFor = await loadEvidenceFn();

      const total = symbols.length * timeframes.length;
      progress = { phase: 'scanning', done: 0, total, symbol: null, timeframe: null };
      push({ kind: 'scan_started', text: `Scanning ${symbols.length} symbols across ${timeframes.join(', ')}` });

      const opportunities = [];
      const blocked = [];
      const missingData = [];

      for (const symbol of symbols) {
        for (const timeframe of timeframes) {
          progress = { ...progress, symbol: symbol.broker_symbol, timeframe };

          const row = await evaluateFn({
            symbol, timeframe, strategyRows, mode, balance, openPositions, evidenceFor, now: startedAt
          });

          if (row.note) {
            missingData.push({ symbol: row.symbol, symbolId: row.symbolId, timeframe, note: row.note });
          }

          for (const s of row.strategies) {
            if (!s.firing || !s.risk) continue;
            const opportunity = {
              symbolId: row.symbolId,
              symbol: row.symbol,
              digits: row.digits,
              price: row.price,
              barTime: row.barTime,
              timeframe,
              strategy: s.strategy,
              strategyStatus: s.status,
              strategyEnabled: s.strategyEnabled,
              side: s.side,
              reason: s.reason,
              score: s.score,
              scoreComponents: s.scoreComponents,
              evidence: s.evidence,
              levels: s.levels,
              lot: s.risk.lot,
              riskAmount: s.risk.riskAmount,
              wouldTrade: Boolean(s.wouldTrade),
              blockedBy: s.blockedBy || null,
              checks: s.checks,
              gates: s.risk.checks,
              features: s.features
            };

            if (opportunity.wouldTrade) opportunities.push(opportunity);
            else blocked.push(opportunity);
          }

          progress = { ...progress, done: progress.done + 1 };
        }
      }

      // Highest score first. Ties break on the tighter risk, because between
      // two equally-rated setups the cheaper one to be wrong about wins.
      const byScore = (a, b) => b.score - a.score || (a.riskAmount ?? 0) - (b.riskAmount ?? 0);
      opportunities.sort(byScore);
      blocked.sort(byScore);

      let alerted = 0;
      if (settings.scannerAlertsEnabled) {
        for (const opportunity of opportunities) {
          try {
            if (await announce({ opportunity, cooldownMinutes: settings.alertCooldownMinutes, mode })) {
              alerted += 1;
            }
          } catch (error) {
            // An alerting outage must never fail a scan.
            logger.error(`opportunity alert failed: ${error.message}`);
          }
        }
      }

      for (const o of opportunities.slice(0, 5)) {
        push({
          kind: 'opportunity',
          text: `${o.symbol} ${o.side} ${o.timeframe} · ${o.strategy} · score ${o.score}`,
          score: o.score,
          symbol: o.symbol
        });
      }

      const finishedAt = now();
      last = {
        at: finishedAt.toISOString(),
        startedAt: startedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        mode,
        timeframes,
        tradedTimeframes: settings.tradedTimeframes,
        balance,
        symbolsScanned: symbols.length,
        strategiesRun: strategyRows.length,
        combinations: total * strategyRows.length,
        opportunities,
        blocked,
        missingData,
        alerted
      };

      push({
        kind: 'scan_finished',
        text: `${opportunities.length} tradeable, ${blocked.length} blocked, ${missingData.length} without data`
      });

      return last;
    } finally {
      running = false;
      progress = emptyProgress();
    }
  }

  return {
    scan,
    isScanning: () => running,
    snapshot: () => ({ scanning: running, progress, last, feed: [...feed] })
  };
}

module.exports = { createScanRunner };
