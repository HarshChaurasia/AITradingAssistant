const express = require('express');

const { scanWatchlist } = require('../scanner');

function createScannerRouter() {
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

  return router;
}

module.exports = { createScannerRouter };
