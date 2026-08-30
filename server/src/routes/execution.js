const express = require('express');

const { query } = require('../db/pool');
const { executeApprovedSignals } = require('../execution/manager');
const { reconcile } = require('../execution/reconciler');
const { listTrades, tradeStats, equityHistory } = require('../execution/journal');
const { dailyPerformance, breakdown } = require('../execution/performance');

function createExecutionRouter({ bridge }) {
  const router = express.Router();

  router.get('/trades', async (req, res, next) => {
    try {
      res.json(await listTrades({
        mode: req.query.mode, status: req.query.status, limit: req.query.limit
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/trades/stats', async (req, res, next) => {
    try {
      res.json(await tradeStats({ mode: req.query.mode || 'demo' }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/equity', async (req, res, next) => {
    try {
      res.json(await equityHistory({ mode: req.query.mode || 'demo', limit: req.query.limit }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/performance', async (req, res, next) => {
    try {
      const mode = String(req.query.mode || 'demo');
      res.json({
        mode,
        daily: await dailyPerformance({ mode, days: req.query.days }),
        ...(await breakdown({ mode }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/execution/run', async (req, res, next) => {
    try {
      const mode = String(req.body?.mode || process.env.TRADING_MODE || 'demo');
      const balance = Number(req.body?.balance || process.env.ACCOUNT_BALANCE_HINT || 10000);
      res.json(await executeApprovedSignals({ bridge, mode, balance }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/execution/reconcile', async (req, res, next) => {
    try {
      const mode = String(req.body?.mode || process.env.TRADING_MODE || 'demo');
      res.json(await reconcile({ bridge, mode }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/execution/close/:tradeId', async (req, res, next) => {
    try {
      const rows = await query(
        "SELECT * FROM trades WHERE id = ? AND status = 'OPEN'",
        [Number(req.params.tradeId)]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: `no open trade with id ${req.params.tradeId}` });
      }
      res.json(await bridge.closePosition({ ticket: Number(rows[0].broker_ticket) }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createExecutionRouter };
