const express = require('express');

const { loadOperationsSettings, saveOperationsSettings, TIMEFRAMES } = require('../settings/operations');
const { loadRiskSettings, saveRiskSettings } = require('../risk/settings');

/**
 * One screen's worth of settings, from two stores.
 *
 * Risk limits and operational switches are kept apart on disk deliberately,
 * but an operator thinks of them as one page. This router joins them for
 * reading and splits the patch again on the way back down, so neither store
 * ever receives a key that belongs to the other.
 */
function createSettingsRouter() {
  const router = express.Router();

  router.get('/settings', async (req, res, next) => {
    try {
      res.json({
        operations: await loadOperationsSettings(),
        risk: await loadRiskSettings(),
        // The environment holds the switches a dashboard must not be able to
        // flip. Reporting them read-only explains why a toggle can look on
        // and still not trade.
        environment: {
          executionEnabled: process.env.EXECUTION_ENABLED === 'true',
          allowTrading: process.env.MT5_ALLOW_TRADING === 'true',
          allowLive: process.env.MT5_ALLOW_LIVE === 'true',
          schedulerEnabled: process.env.SCHEDULER_ENABLED === 'true',
          tradingMode: process.env.TRADING_MODE || 'demo'
        },
        timeframes: TIMEFRAMES
      });
    } catch (error) {
      next(error);
    }
  });

  router.put('/settings', async (req, res, next) => {
    try {
      const body = req.body || {};
      const operations = body.operations ? await saveOperationsSettings(body.operations) : await loadOperationsSettings();
      const risk = body.risk ? await saveRiskSettings(body.risk) : await loadRiskSettings();
      res.json({ operations, risk });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createSettingsRouter };
