const { syncCandles } = require('../market/candles');
const { listSymbols } = require('../market/symbols');
const { generateSignals } = require('../signals/generator');
const { expireStaleSignals } = require('../signals/store');
const { executeApprovedSignals } = require('../execution/manager');
const { reconcile } = require('../execution/reconciler');
const { ensureBridgeConnected, checkDisk } = require('./health');
const healthAlerts = require('../alerts/health');

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
  timeframe = process.env.STRATEGY_TIMEFRAME || 'H1',
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
  ensureBridgeConnectedFn = ensureBridgeConnected,
  checkDiskFn = checkDisk,
  alerts = healthAlerts,
  logger = console
} = {}) {
  let timer = null;
  let ticking = false;
  let lastResult = null;
  // Survives across ticks so an outage alerts once, not every minute.
  const health = { bridgeDown: false, lowDisk: false };

  async function runOnce() {
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
        note: 'broker link is down; skipping this cycle'
      };
      return lastResult;
    }

    const symbols = await listSymbolsFn({ enabledOnly: true });

    let symbolsSynced = 0;
    for (const symbol of symbols) {
      await syncCandlesFn(bridge, {
        symbolId: symbol.id,
        brokerSymbol: symbol.broker_symbol,
        timeframe,
        count: 300
      });
      symbolsSynced += 1;
    }

    const signals = await generateSignalsFn({ mode, timeframe });

    // Execute before reconciling: a fill from this tick is then picked up by
    // the next one, rather than being reconciled against a broker that has
    // not registered it yet.
    const execution = executionEnabled
      ? await executeFn({ bridge, mode, balance })
      : { attempted: 0, filled: 0, skipped: 0, failed: 0, disabled: true };

    const reconciliation = await reconcileFn({ bridge, mode });
    const expired = await expireStaleSignalsFn({ olderThanMinutes: 60, mode });

    lastResult = {
      at: new Date().toISOString(),
      bridgeDown: false,
      diskFreeGb: disk.freeGb,
      symbolsSynced, signals, execution, reconciliation, expired
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
