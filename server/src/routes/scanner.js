const express = require('express');

const { scanWatchlist } = require('../scanner');
const { query } = require('../db/pool');
const { getStrategy, mergeParams } = require('../strategies/registry');
const { getCandles } = require('../market/candles');
const { executeSignal } = require('../execution/manager');

function createScannerRouter({ bridge } = {}) {
  const router = express.Router();

  router.get('/scanner', async (req, res, next) => {
    try {
      res.json(await scanWatchlist({
        mode: String(req.query.mode || process.env.TRADING_MODE || 'demo'),
        timeframe: String(req.query.timeframe || process.env.STRATEGY_TIMEFRAME || 'H1'),
        balance: Number(req.query.balance || process.env.ACCOUNT_BALANCE_HINT || 10000)
      }));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Trade a setup the operator can see on the scanner.
   *
   * This takes no price, side, size or stop from the request. It re-derives
   * everything from the strategy on the current bar and then goes through the
   * ordinary execution path, so every risk gate applies exactly as it would to
   * an automatic trade. A caller cannot talk this endpoint into a position the
   * scheduler would have refused.
   */
  router.post('/scanner/trade', async (req, res, next) => {
    try {
      const { symbolId, strategy: strategyName, timeframe = 'H1' } = req.body || {};
      if (!symbolId || !strategyName) {
        return res.status(400).json({ error: 'symbolId and strategy are required' });
      }
      if (!bridge) return res.status(503).json({ error: 'no broker bridge is configured' });

      const mode = String(req.body.mode || process.env.TRADING_MODE || 'demo');
      const balance = Number(req.body.balance || process.env.ACCOUNT_BALANCE_HINT || 10000);

      const symbolRows = await query('SELECT * FROM symbols WHERE id = ?', [symbolId]);
      if (symbolRows.length === 0) return res.status(404).json({ error: `unknown symbolId ${symbolId}` });
      const symbol = symbolRows[0];

      // Watching a symbol is not permission to trade it.
      if (symbol.enabled !== 1) {
        return res.status(409).json({
          error: `${symbol.broker_symbol} is watched but not enabled for trading`,
          code: 'symbol_not_enabled'
        });
      }

      let strategy;
      try {
        strategy = getStrategy(strategyName);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      const strategyRows = await query(
        'SELECT * FROM strategies WHERE name = ? AND version = ?', [strategy.name, strategy.version]
      );
      if (strategyRows.length === 0) {
        return res.status(400).json({ error: `strategy ${strategy.name} is not registered` });
      }
      const strategyRow = strategyRows[0];

      const candles = await getCandles({ symbolId, timeframe, limit: 500 });
      if (candles.length < 2) {
        return res.status(400).json({ error: `no ${timeframe} candles stored for ${symbol.broker_symbol}` });
      }

      // The last CLOSED bar, matching the generator. Trading the forming bar
      // would act on a setup that can still disappear.
      const index = candles.length - 2;
      const params = mergeParams(strategy, strategyRow.params);
      const context = strategy.prepare(candles, params);
      const produced = strategy.evaluate(candles, index, params, context);

      if (!produced) {
        return res.status(409).json({
          error: 'the setup is no longer present on the last closed bar',
          code: 'setup_gone'
        });
      }

      const barTime = candles[index].open_time.slice(0, 19).replace('T', ' ');
      const inserted = await query(
        `INSERT INTO signals (strategy_id, symbol_id, timeframe, mode, generated_at, bar_time,
           side, entry, sl, tp, reason, features, status, auto_approved, decided_at, decided_by)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 'approved', 0,
                 UTC_TIMESTAMP(), 'user')`,
        [
          strategyRow.id, symbolId, timeframe, mode, barTime, produced.side,
          produced.entry, produced.sl, produced.tp ?? null,
          `manual: ${produced.reason}`, JSON.stringify(produced.features || {})
        ]
      );

      const signalRows = await query(
        `SELECT sig.*, st.status AS strategy_status FROM signals sig
           JOIN strategies st ON st.id = sig.strategy_id WHERE sig.id = ?`,
        [inserted.insertId]
      );

      const outcome = await executeSignal({ bridge, signal: signalRows[0], mode, balance });
      res.status(outcome.status === 'filled' ? 200 : 409).json({ signalId: inserted.insertId, ...outcome });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createScannerRouter };
