const express = require('express');

const { marketCommentary } = require('../ai/commentary');

function createAiRouter() {
  const router = express.Router();

  router.get('/commentary', async (req, res, next) => {
    try {
      const symbolId = Number(req.query.symbolId);
      if (!symbolId) return res.status(400).json({ error: 'symbolId is required' });

      res.json(await marketCommentary({
        symbolId,
        timeframe: String(req.query.timeframe || 'H1')
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createAiRouter };
