const express = require('express');

const { listSignals, getSignal, approveSignal, rejectSignal } = require('../signals/store');

function createSignalRouter() {
  const router = express.Router();

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
