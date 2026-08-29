const express = require('express');

const { query } = require('../db/pool');
const { loadRiskSettings, saveRiskSettings } = require('../risk/settings');
const { getState, tripKillSwitch, resetKillSwitch } = require('../risk/state');
const { assessSignal } = require('../risk/engine');
const { countOpenPositions } = require('../signals/generator');

const MODES = ['backtest', 'demo', 'live'];

function createRiskRouter({ scheduler } = {}) {
  const router = express.Router();

  router.get('/risk/state', async (req, res, next) => {
    try {
      const mode = String(req.query.mode || 'demo');
      if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
      res.json(await getState(mode));
    } catch (error) {
      next(error);
    }
  });

  router.get('/risk/settings', async (req, res, next) => {
    try {
      res.json(await loadRiskSettings());
    } catch (error) {
      next(error);
    }
  });

  router.put('/risk/settings', async (req, res, next) => {
    try {
      res.json(await saveRiskSettings(req.body || {}));
    } catch (error) {
      next(error);
    }
  });

  router.post('/risk/kill-switch', async (req, res, next) => {
    try {
      const { mode = 'demo', on, reason } = req.body || {};
      if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
      if (typeof on !== 'boolean') return res.status(400).json({ error: 'body must include { on: boolean }' });

      res.json(on
        ? await tripKillSwitch({ mode, reason: reason || 'tripped by the operator' })
        : await resetKillSwitch({ mode }));
    } catch (error) {
      next(error);
    }
  });

  // A dry run, so the operator can ask "what would happen if this fired now"
  // without waiting for the market. Stores nothing.
  router.post('/risk/assess', async (req, res, next) => {
    try {
      const { symbolId, mode = 'demo', balance = 10000, signal } = req.body || {};
      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });
      if (!signal) return res.status(400).json({ error: 'signal is required' });

      const rows = await query('SELECT * FROM symbols WHERE id = ?', [symbolId]);
      if (rows.length === 0) return res.status(404).json({ error: `unknown symbolId ${symbolId}` });

      res.json(await assessSignal({
        signal,
        symbol: rows[0],
        mode,
        balance: Number(balance),
        openPositions: await countOpenPositions(mode)
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/scheduler', (req, res) => {
    res.json({
      running: scheduler ? scheduler.isRunning() : false,
      lastRun: scheduler ? scheduler.lastRun() : null
    });
  });

  router.post('/scheduler/run', async (req, res, next) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'no scheduler is configured' });
      res.json(await scheduler.runOnce());
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createRiskRouter };
