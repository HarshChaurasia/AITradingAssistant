const express = require('express');

const { listStrategies, registerStrategies } = require('../strategies/registry');
const { executeRun, sweep, listRuns, getRun } = require('../backtest/runner');
const {
  strategyAnalytics, setStrategyEnabled, setStrategyStatus, STATUSES
} = require('../strategies/analytics');
const { loadOperationsSettings, TIMEFRAMES } = require('../settings/operations');

function createBacktestRouter({ bridge = null } = {}) {
  const router = express.Router();

  router.get('/strategies', async (req, res, next) => {
    try {
      // Registering is idempotent and keeps the table in step with the code.
      await registerStrategies();
      res.json(await listStrategies());
    } catch (error) {
      next(error);
    }
  });

  router.get('/strategies/analytics', async (req, res, next) => {
    try {
      await registerStrategies();
      res.json(await strategyAnalytics({ mode: String(req.query.mode || 'demo') }));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Enable or promote a strategy.
   *
   * `enabled` is what the signal generator reads; `status` is the promotion
   * ladder the risk engine gates on. They are separate on purpose - enabling a
   * draft strategy produces signals that the risk engine will then refuse,
   * which is exactly the safe failure an operator should see before promoting
   * anything.
   */
  router.patch('/strategies/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { enabled, status } = req.body || {};
      if (typeof enabled !== 'boolean' && status === undefined) {
        return res.status(400).json({ error: 'body must include { enabled: boolean } or { status }' });
      }
      if (status !== undefined && !STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
      }

      let row = null;
      if (typeof enabled === 'boolean') row = await setStrategyEnabled(id, enabled);
      if (status !== undefined) row = await setStrategyStatus(id, status);
      if (!row) return res.status(404).json({ error: `unknown strategy ${id}` });
      res.json(row);
    } catch (error) {
      next(error);
    }
  });

  router.get('/backtests', async (req, res, next) => {
    try {
      res.json(await listRuns({ limit: req.query.limit }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/backtests/:id', async (req, res, next) => {
    try {
      const detail = await getRun(Number(req.params.id));
      if (!detail) return res.status(404).json({ error: `unknown run ${req.params.id}` });
      res.json(detail);
    } catch (error) {
      next(error);
    }
  });

  router.post('/backtests', async (req, res, next) => {
    try {
      const { strategyName, symbolId, timeframe = 'H1', params = {}, options = {} } = req.body || {};
      if (!strategyName) return res.status(400).json({ error: 'strategyName is required' });
      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });

      await registerStrategies();
      const { backfillBars } = await loadOperationsSettings();
      res.json(await executeRun({
        strategyName, symbolId, timeframe, params, options, bridge, backfillBars
      }));
    } catch (error) {
      // A bad strategy name, an unknown symbol or an empty candle store are
      // all the caller's problem, not a server fault.
      if (/unknown strategy|unknown symbolId|no candles/i.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });

  /**
   * Every strategy against every timeframe for one symbol, in one call.
   *
   * This is the honest way to ask "does anything work on this instrument?".
   * Running one combination at a time invites picking the best of sixty and
   * calling it an edge, so the response reports the whole grid - including the
   * failures - rather than only the winner.
   */
  router.post('/backtests/sweep', async (req, res, next) => {
    try {
      const { symbolId, strategyNames, timeframes, params = {}, options = {} } = req.body || {};
      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });

      await registerStrategies();
      const all = await listStrategies();
      const names = Array.isArray(strategyNames) && strategyNames.length
        ? strategyNames
        : all.map((s) => s.name);

      const requested = Array.isArray(timeframes) && timeframes.length ? timeframes : TIMEFRAMES;
      const chosen = requested.filter((tf) => TIMEFRAMES.includes(tf));
      if (chosen.length === 0) {
        return res.status(400).json({ error: `timeframes must be from ${TIMEFRAMES.join(', ')}` });
      }

      const { backfillBars } = await loadOperationsSettings();
      res.json(await sweep({
        symbolId, strategyNames: names, timeframes: chosen, params, options, bridge, backfillBars
      }));
    } catch (error) {
      if (/unknown symbolId|unknown strategy/i.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });

  return router;
}

module.exports = { createBacktestRouter };
