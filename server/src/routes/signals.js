const express = require('express');

const { listSignals, getSignal, approveSignal, rejectSignal } = require('../signals/store');
const { evaluateMissedSignals, listMissedSignals, missedSummary } = require('../signals/missed');

function createSignalRouter() {
  const router = express.Router();

  /**
   * The trades we refused, graded against what the market did next.
   *
   * Kept on the signals router because that is what these rows are: signals
   * that were generated, refused, and then followed up. Nothing here has ever
   * been an order.
   */
  router.get('/missed', async (req, res, next) => {
    try {
      const mode = String(req.query.mode || 'demo');
      res.json({
        summary: await missedSummary({ mode }),
        rows: await listMissedSignals({
          mode,
          verdict: req.query.verdict ? String(req.query.verdict) : null,
          limit: req.query.limit
        })
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/missed/evaluate', async (req, res, next) => {
    try {
      res.json(await evaluateMissedSignals({
        horizonBars: Number(req.body?.horizonBars) || undefined
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/signals', async (req, res, next) => {
    try {
      res.json(await listSignals({
        mode: req.query.mode,
        status: req.query.status,
        limit: req.query.limit
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/signals/:id/approve', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!(await getSignal(id))) {
        return res.status(404).json({ error: `unknown signal ${id}` });
      }
      res.json(await approveSignal(id));
    } catch (error) {
      next(error);
    }
  });

  router.post('/signals/:id/reject', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!(await getSignal(id))) {
        return res.status(404).json({ error: `unknown signal ${id}` });
      }
      res.json(await rejectSignal(id, req.body?.reason));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createSignalRouter };
