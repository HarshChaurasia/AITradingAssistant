const express = require('express');

const { syncSymbols, listSymbols, setSymbolEnabled, setSymbolWatched } = require('../market/symbols');
const { syncCandles, getCandles, TIMEFRAMES } = require('../market/candles');
const { query } = require('../db/pool');

function createMarketRouter({ bridge }) {
  const router = express.Router();

  // Never propagate a bridge outage as a 500: the dashboard has to stay usable
  // when the MT5 terminal is closed, which is most of the time during setup.
  router.get('/bridge/health', async (req, res) => {
    try {
      res.json(await bridge.health());
    } catch (error) {
      res.json({ ok: false, error: error.message });
    }
  });

  router.get('/bridge/account', async (req, res) => {
    try {
      res.json(await bridge.account());
    } catch (error) {
      res.json({ ok: false, error: error.message });
    }
  });

  router.get('/symbols', async (req, res, next) => {
    try {
      res.json(await listSymbols({
        enabledOnly: req.query.enabledOnly === '1',
        watchedOnly: req.query.watchedOnly === '1'
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/symbols/sync', async (req, res, next) => {
    try {
      res.json(await syncSymbols(bridge));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/symbols/:id', async (req, res, next) => {
    try {
      const { enabled, watched } = req.body || {};
      if (typeof enabled !== 'boolean' && typeof watched !== 'boolean') {
        return res.status(400).json({ error: 'body must include { enabled: boolean } or { watched: boolean }' });
      }
      // Two independent flags: watching a symbol must never make it tradeable.
      if (typeof enabled === 'boolean') await setSymbolEnabled(Number(req.params.id), enabled);
      if (typeof watched === 'boolean') await setSymbolWatched(Number(req.params.id), watched);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/candles', async (req, res, next) => {
    try {
      const symbolId = Number(req.query.symbolId);
      const timeframe = String(req.query.timeframe || 'H1');
      const limit = Math.min(Number(req.query.limit || 500), 5000);

      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });
      if (!TIMEFRAMES.includes(timeframe)) {
        return res.status(400).json({ error: `timeframe must be one of ${TIMEFRAMES.join(', ')}` });
      }

      res.json(await getCandles({ symbolId, timeframe, limit }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/candles/sync', async (req, res, next) => {
    try {
      const { symbolId, timeframe = 'H1', count = 1000 } = req.body || {};
      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });
      if (!TIMEFRAMES.includes(timeframe)) {
        return res.status(400).json({ error: `timeframe must be one of ${TIMEFRAMES.join(', ')}` });
      }

      const rows = await query('SELECT broker_symbol FROM symbols WHERE id = ?', [symbolId]);
      if (rows.length === 0) return res.status(404).json({ error: `unknown symbolId ${symbolId}` });

      res.json(await syncCandles(bridge, {
        symbolId,
        brokerSymbol: rows[0].broker_symbol,
        timeframe,
        count: Math.min(Number(count), 20000)
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createMarketRouter };
