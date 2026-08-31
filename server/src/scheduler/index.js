const { syncCandles } = require('../market/candles');
const { listSymbols } = require('../market/symbols');
const { generateSignals } = require('../signals/generator');
const { expireStaleSignals } = require('../signals/store');
const { executeApprovedSignals } = require('../execution/manager');
const { reconcile } = require('../execution/reconciler');
const { ensureBridgeConnected, checkDisk } = require('./health');
const healthAlerts = require('../alerts/health');
const { loadOperationsSettings, expiryMinutesFor } = require('../settings/operations');
const { evaluateMissedSignals } = require('../signals/missed');
const { refreshMarketStatus, watchedSymbols } = require('../market/market-hours');
const { syncCalendar } = require('../news/calendar');
const { scopeOnlyTimeframeNames } = require('../strategies/scopes');

/**
 * Periodic candle sync followed by signal generation.
 *
 * setInterval rather than a cron library: the cadence is a plain fixed
 * interval and a dependency would earn nothing.
 *
 * The dependencies are injectable so the tests can drive the loop without a
 * database or a broker.
 */
function createScheduler({
  bridge,
  intervalMs = 60000,
  mode = process.env.TRADING_MODE || 'demo',
  // The timeframe the strategy was validated on. Trading a timeframe the
  // backtest never covered is running an unvalidated strategy.
  // An explicit override wins; otherwise the operator's saved setting decides,
  // re-read every tick so a dashboard change lands without a restart.
  timeframes = null,
  syncCandlesFn = syncCandles,
  listSymbolsFn = listSymbols,
  generateSignalsFn = generateSignals,
  expireStaleSignalsFn = expireStaleSignals,
  executeFn = executeApprovedSignals,
  reconcileFn = reconcile,
  // A loop that watches and a loop that trades are different things, so they
  // get separate switches. Even with the scheduler running, no order is sent
  // until this is explicitly enabled.
  executionEnabled = process.env.EXECUTION_ENABLED === 'true',
  balance = Number(process.env.ACCOUNT_BALANCE_HINT || 10000),
  loadSettingsFn = loadOperationsSettings,
  // The live scanner sweeps in the background. Kicking it from here rather
  // than on its own timer means it always runs against candles that were
  // synced moments earlier, instead of racing the sync.
  scanRunner = null,
  gradeMissedFn = evaluateMissedSignals,
  syncCalendarFn = syncCalendar,
  // The economic calendar changes by the day, not the minute.
  calendarIntervalMs = 3600000,
  refreshMarketStatusFn = refreshMarketStatus,
  watchedSymbolsFn = watchedSymbols,
  ensureBridgeConnectedFn = ensureBridgeConnected,
  checkDiskFn = checkDisk,
  alerts = healthAlerts,
  logger = console
} = {}) {
  let timer = null;
  let ticking = false;
  let lastResult = null;
  let calendarAt = 0;
  // Survives across ticks so an outage alerts once, not every minute.
  const health = { bridgeDown: false, lowDisk: false };

  async function runOnce() {
    const settings = await loadSettingsFn();
    const tradedTimeframes = timeframes || settings.tradedTimeframes;

    /**
     * A timeframe reached only through a strategy scope still needs candles
     * and still needs its signals expired. Leaving it out of this list was
     * the whole reason a scope on an untraded timeframe did nothing: the
     * generator would have been asked for signals on candles nobody synced.
     */
    let scopedOnly = [];
    try {
      scopedOnly = await scopeOnlyTimeframeNames(tradedTimeframes);
    } catch (error) {
      logger.error(`scope timeframe lookup failed: ${error.message}`);
    }
    const activeTimeframes = [...tradedTimeframes, ...scopedOnly];

    // Before anything else: is the broker link alive? A dropped MT5
    // connection never recovers on its own - the bridge cannot retry from
    // inside a request without freezing itself - so the retry happens here.
    const link = await ensureBridgeConnectedFn({ bridge, state: health, alerts, logger });
    const disk = await checkDiskFn({ state: health, alerts, logger });

    if (!link.connected) {
      lastResult = {
        at: new Date().toISOString(),
        bridgeDown: true,
        diskFreeGb: disk.freeGb,
        timeframes: activeTimeframes,
        note: 'broker link is down; skipping this cycle'
      };
      return lastResult;
    }

    // Refresh the economic calendar hourly. Until this existed the news gate
    // read an empty table and reported "no high impact news" for every signal
    // ever assessed - true only in the sense that an empty table has no rows.
    let calendar = null;
    if (Date.now() - calendarAt >= calendarIntervalMs) {
      calendarAt = Date.now();
      calendar = await syncCalendarFn({ logger });
    }

    // Ask the broker which of the watched markets are open, every tick. This
    // is a cached snapshot rather than a calendar, so it has to be kept fresh:
    // the risk gate refuses any symbol whose status has gone stale, which is
    // the right answer for a symbol the broker has stopped answering about.
    let marketsChecked = 0;
    try {
      marketsChecked = (await refreshMarketStatusFn(bridge, {
        symbols: await watchedSymbolsFn(), logger
      })).updated;
    } catch (error) {
      logger.error(`market status refresh failed: ${error.message}`);
    }

    // Candles are synced for watched symbols as well, so the scanner has
    // fresh data. Signal generation and execution below still read `enabled`
    // only - watching a symbol must never make it tradeable.
    const symbols = await listSymbolsFn({ watchedOnly: true });

    // Every traded timeframe needs its own candles. Sequential on purpose:
    // concurrent history requests to a single MT5 terminal are how the bridge
    // stops answering.
    let symbolsSynced = 0;
    for (const symbol of symbols) {
      for (const tf of activeTimeframes) {
        await syncCandlesFn(bridge, {
          symbolId: symbol.id,
          brokerSymbol: symbol.broker_symbol,
          timeframe: tf,
          count: 300
        });
      }
      symbolsSynced += 1;
    }

    // Only the TRADED list is handed over. The generator derives the
    // scope-only timeframes itself, and it must, because there each one runs
    // just the strategies scoped to it - passing the widened list would make
    // every unscoped strategy trade there too, which is the opposite of what
    // narrowing a strategy is for.
    const signals = await generateSignalsFn({ mode, timeframes: tradedTimeframes, settings });

    // Execute before reconciling: a fill from this tick is then picked up by
    // the next one, rather than being reconciled against a broker that has
    // not registered it yet.
    const execution = executionEnabled
      ? await executeFn({ bridge, mode, balance })
      : { attempted: 0, filled: 0, skipped: 0, failed: 0, disabled: true };

    const reconciliation = await reconcileFn({ bridge, mode });
    // Per timeframe, because a signal is priced at its bar's close: an M15
    // signal is stale in minutes while a D1 signal is still good hours later.
    const expired = await expireStaleSignalsFn({
      olderThanMinutes: Object.fromEntries(
        activeTimeframes.map((tf) => [tf, expiryMinutesFor(tf, settings)])
      ),
      mode
    });

    // Grade the setups we refused against the candles that have arrived since.
    // Cheap - it only touches signals with no verdict yet - and it is the only
    // thing that turns a rejection into something we can learn from.
    let missed = null;
    try {
      missed = await gradeMissedFn({ modes: [mode] });
    } catch (error) {
      logger.error(`missed-signal grading failed: ${error.message}`);
      missed = { error: error.message };
    }

    if (scanRunner && !scanRunner.isScanning()) {
      // Deliberately not awaited: a full sweep can outlast the tick interval,
      // and the runner has its own guard against overlapping scans.
      scanRunner.scan({ mode }).catch((error) => {
        logger.error(`background scan failed: ${error.message}`);
      });
    }

    lastResult = {
      at: new Date().toISOString(),
      bridgeDown: false,
      diskFreeGb: disk.freeGb,
      timeframes: activeTimeframes,
      autoTrade: settings.autoTradeEnabled,
      symbolsSynced, marketsChecked, calendar, signals, execution, reconciliation, expired, missed
    };
    return lastResult;
  }

  async function tick() {
    // A slow candle sync must never have a second tick running behind it, or
    // two generators race to create a signal for the same bar.
    if (ticking) return;
    ticking = true;
    try {
      await runOnce();
    } catch (error) {
      // One bad tick - a closed terminal, a dropped connection - must not end
      // the schedule.
      logger.error(`scheduler tick failed: ${error.message}`);
      lastResult = { at: new Date().toISOString(), error: error.message };
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      // Do not hold the process open on this timer alone.
      if (typeof timer.unref === 'function') timer.unref();
      tick();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    isRunning: () => timer !== null,
    lastRun: () => lastResult,
    runOnce
  };
}

module.exports = { createScheduler };
