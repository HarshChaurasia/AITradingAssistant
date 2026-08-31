const express = require('express');

const { syncSymbols, listSymbols, setSymbolEnabled, setSymbolWatched } = require('../market/symbols');
const { syncCandles, getCandles, barsForMonths, TIMEFRAMES } = require('../market/candles');
const { refreshMarketStatus, marketStatus } = require('../market/market-hours');
const { syncCalendar, upcoming } = require('../news/calendar');
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
      const result = await syncSymbols(bridge);
      // Market status is probed for the watched handful only. It is a round
      // trip per symbol, and only those can ever produce a signal.
      const markets = await refreshMarketStatus(bridge).catch((error) => ({ error: error.message }));
      res.json({ ...result, markets });
    } catch (error) {
      next(error);
    }
  });

  router.post('/symbols/market-status/refresh', async (req, res, next) => {
    try {
      res.json(await refreshMarketStatus(bridge));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Which watched markets are open right now, and why.
   *
   * The commonest weekend question is "why is nothing happening", and the
   * answer is usually that the instrument is shut. Better to say so plainly
   * than to leave an empty signal list to be interpreted.
   */
  router.get('/symbols/market-status', async (req, res, next) => {
    try {
      const rows = await query(
        'SELECT * FROM symbols WHERE watched = 1 OR enabled = 1 ORDER BY broker_symbol'
      );
      const now = new Date();
      res.json(rows.map((symbol) => ({
        symbolId: symbol.id,
        symbol: symbol.broker_symbol,
        tradeable: symbol.enabled === 1,
        checkedAt: symbol.market_checked_at,
        tickAgeSeconds: symbol.tick_age_seconds,
        ...marketStatus({ symbol, now })
      })));
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

      // A symbol that has just become watched or tradeable has no market
      // status, and the gate fails closed without one. Probe it now rather
      // than leaving the operator to wonder why their newly enabled symbol
      // refuses every signal for a minute.
      if (enabled === true || watched === true) {
        const rows = await query('SELECT id, broker_symbol FROM symbols WHERE id = ?', [Number(req.params.id)]);
        await refreshMarketStatus(bridge, { symbols: rows }).catch(() => {});
      }

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/news', async (req, res, next) => {
    try {
      res.json(await upcoming({
        hours: req.query.hours,
        minImpact: req.query.minImpact === 'HIGH' ? 'HIGH' : 'MEDIUM'
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/news/sync', async (req, res, next) => {
    try {
      res.json(await syncCalendar());
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
      const { symbolId, timeframe = 'H1', count, months } = req.body || {};
      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });
      if (!TIMEFRAMES.includes(timeframe)) {
        return res.status(400).json({ error: `timeframe must be one of ${TIMEFRAMES.join(', ')}` });
      }

      const rows = await query('SELECT broker_symbol FROM symbols WHERE id = ?', [symbolId]);
      if (rows.length === 0) return res.status(404).json({ error: `unknown symbolId ${symbolId}` });

      // `months` is what the dashboard sends: the bar count for a span is a
      // function of the timeframe, and a flat 2,000 meant three weeks of M5
      // against nine years of D1.
      const bars = months
        ? barsForMonths(timeframe, Math.min(Math.max(Number(months) || 6, 1), 60))
        : Math.min(Number(count) || 1000, 120000);

      res.json({
        ...(await syncCandles(bridge, {
          symbolId,
          brokerSymbol: rows[0].broker_symbol,
          timeframe,
          count: bars
        })),
        requestedBars: bars
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createMarketRouter };
