const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { query } = require('./db/pool');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const { bridgeFromEnv } = require('./bridge/client');
const { createMarketRouter } = require('./routes/market');

app.use('/api', createMarketRouter({ bridge: bridgeFromEnv() }));

const { createBacktestRouter } = require('./routes/backtests');

app.use('/api', createBacktestRouter());

const { createSignalRouter } = require('./routes/signals');
const { createRiskRouter } = require('./routes/risk');
const { createScheduler } = require('./scheduler');

const scheduler = createScheduler({ bridge: bridgeFromEnv() });

app.use('/api', createSignalRouter());
app.use('/api', createRiskRouter({ scheduler }));

// Opt-in: an unattended loop should never start just because the server did.
if (process.env.SCHEDULER_ENABLED === 'true') {
  scheduler.start();
  console.log(`scheduler started (mode ${process.env.TRADING_MODE || 'demo'})`);
}

const sampleOverview = {
  accountValue: 100,
  dailyPnL: 3.4,
  totalPnl: 14.2,
  openTrades: 2,
  winRate: 62,
  riskUsed: 1.2,
  confidence: 78,
  activeStrategies: 3
};

const sampleNews = [
  { id: 1, title: 'Dollar softens as growth concerns rise', source: 'Reuters', time: '12 min ago', impact: 'Medium' },
  { id: 2, title: 'Gold rebounds on safe-haven demand', source: 'Bloomberg', time: '26 min ago', impact: 'High' },
  { id: 3, title: 'Crypto markets see renewed momentum after ETF inflows', source: 'CoinDesk', time: '41 min ago', impact: 'Medium' }
];

const sampleTrades = [
  { id: 1, symbol: 'EUR/USD', side: 'BUY', lot: 0.10, pnl: 2.8, status: 'Closed' },
  { id: 2, symbol: 'XAU/USD', side: 'SELL', lot: 0.04, pnl: -1.1, status: 'Closed' },
  { id: 3, symbol: 'EUR/USD', side: 'BUY', lot: 0.08, pnl: 1.9, status: 'Open' }
];

app.get('/api/health', async (req, res) => {
  let database = { connected: false, message: 'unknown' };
  try {
    const rows = await query('SELECT 1 AS ok');
    database = { connected: rows[0].ok === 1, message: 'MySQL OK' };
  } catch (error) {
    database = { connected: false, message: error.message };
  }
  res.json({ ok: true, service: 'trading-agent-server', timestamp: new Date().toISOString(), database });
});

app.get('/api/overview', (req, res) => {
  res.json(sampleOverview);
});

app.get('/api/news', (req, res) => {
  res.json(sampleNews);
});

app.get('/api/trades', (req, res) => {
  res.json(sampleTrades);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Trading agent server running on http://localhost:${PORT}`);
});
