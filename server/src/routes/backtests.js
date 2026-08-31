const express = require('express');

const { listStrategies, registerStrategies } = require('../strategies/registry');
const { executeRun, sweep, listRuns, getRun } = require('../backtest/runner');
const {
  strategyAnalytics, setStrategyEnabled, setStrategyStatus, STATUSES
} = require('../strategies/analytics');
const { loadOperationsSettings, TIMEFRAMES } = require('../settings/operations');
const { setScopes, listScopes } = require('../strategies/scopes');
const { createLabJob } = require('../backtest/lab');
const {
  listStudies, listPromotions, promoteFromStudy, revokePromotion
} = require('../strategies/promotions');

function createBacktestRouter({ bridge = null } = {}) {
  // One lab job per server. Two grids at once would fight for the same CPU
  // and produce two sets of half-speed progress.
  const labJob = createLabJob();
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

  /**
   * Narrow a strategy to particular symbols and timeframes.
   *
   * An empty list CLEARS the scope, which restores "runs everywhere" rather
   * than switching the strategy off. Turning it off is what `enabled` does,
   * and conflating the two would make an accidental deselection look like a
   * working strategy that had quietly stopped.
   */
  router.put('/strategies/:id/scopes', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const rows = await listStrategies();
      if (!rows.some((s) => s.id === id)) {
        return res.status(404).json({ error: `unknown strategy ${id}` });
      }

      const entries = Array.isArray(req.body?.scopes) ? req.body.scopes : [];
      for (const entry of entries) {
        if (entry.timeframe && !TIMEFRAMES.includes(entry.timeframe)) {
          return res.status(400).json({ error: `timeframe must be one of ${TIMEFRAMES.join(', ')}` });
        }
      }

      res.json(await setScopes(id, entries));
    } catch (error) {
      next(error);
    }
  });

  router.get('/strategies/:id/scopes', async (req, res, next) => {
    try {
      res.json(await listScopes(Number(req.params.id)));
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
      const { symbolId, symbolIds, strategyNames, timeframes, params = {}, options = {} } = req.body || {};
      const targets = Array.isArray(symbolIds) && symbolIds.length
        ? symbolIds
        : (symbolId ? [symbolId] : null);
      if (!targets) return res.status(400).json({ error: 'symbolId or symbolIds is required' });

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
        symbolIds: targets, strategyNames: names, timeframes: chosen, params, options, bridge, backfillBars
      }));
    } catch (error) {
      if (/unknown symbolId|unknown strategy/i.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });

  /**
   * The lab: search parameters, judge on data the search never saw, and
   * promote only what survives the holdout.
   *
   * Started rather than awaited. A grid of forty-eight combinations scores
   * tens of thousands of parameter sets, which is minutes of CPU, and a
   * request held open that long dies somewhere in the middle with nothing to
   * show for it.
   */
  router.post('/lab/studies', async (req, res, next) => {
    try {
      const { strategyNames, symbolIds, timeframes, iterations, options } = req.body || {};
      if (labJob.isRunning()) {
        return res.status(409).json({ error: 'a study is already running' });
      }

      await registerStrategies();
      labJob.start({
        strategyNames,
        symbolIds,
        timeframes,
        iterations: Math.min(Math.max(Number(iterations) || 5, 1), 10),
        options: options || {}
      }).catch((error) => {
        // Already logged inside the job; this only stops an unhandled
        // rejection from taking the process down with it.
        console.error(`lab study failed: ${error.message}`);
      });

      res.status(202).json({ started: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/lab/studies', async (req, res, next) => {
    try {
      res.json({
        job: labJob.snapshot(),
        studies: await listStudies({
          limit: req.query.limit,
          promotableOnly: req.query.promotable === 'true'
        }),
        promotions: await listPromotions({ includeRevoked: req.query.revoked === 'true' })
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/lab/studies/cancel', async (req, res, next) => {
    try {
      res.json(labJob.cancel());
    } catch (error) {
      next(error);
    }
  });

  router.post('/lab/studies/:id/promote', async (req, res, next) => {
    try {
      res.json(await promoteFromStudy(Number(req.params.id), {
        promotedBy: req.user?.username || 'operator',
        force: req.body?.force === true
      }));
    } catch (error) {
      if (/not promotable|unknown study/i.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });

  router.post('/lab/promotions/:id/revoke', async (req, res, next) => {
    try {
      res.json(await revokePromotion(Number(req.params.id), { note: req.body?.note || null }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createBacktestRouter };
