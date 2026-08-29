const express = require('express');

const { listStrategies, registerStrategies } = require('../strategies/registry');
const { executeRun, listRuns, getRun } = require('../backtest/runner');

function createBacktestRouter() {
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
      res.json(await executeRun({ strategyName, symbolId, timeframe, params, options }));
    } catch (error) {
      // A bad strategy name, an unknown symbol or an empty candle store are
      // all the caller's problem, not a server fault.
      if (/unknown strategy|unknown symbolId|no candles/i.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });

  return router;
}

module.exports = { createBacktestRouter };
