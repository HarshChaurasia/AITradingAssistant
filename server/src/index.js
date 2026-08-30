const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { query } = require('./db/pool');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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


const { bridgeFromEnv } = require('./bridge/client');
const { createMarketRouter } = require('./routes/market');

const { createAuthRouter } = require('./routes/auth');
const { requireSession } = require('./auth/middleware');

// Auth routes first: login and status must be reachable without a session.
app.use('/api', createAuthRouter());

// Everything mounted after this line requires a session. The guard sits here
// rather than on each route so a route added later is protected by default -
// a dashboard that can place orders must never be open by accident.
if (process.env.AUTH_ENABLED === 'false') {
  console.warn('WARNING: AUTH_ENABLED=false - the API is UNPROTECTED and it can place trades');
} else {
  app.use('/api', requireSession);
}

app.use('/api', createMarketRouter({ bridge: bridgeFromEnv() }));

const { createBacktestRouter } = require('./routes/backtests');

// The bridge is handed in so a backtest on a timeframe with no stored history
// can backfill it instead of failing with "backfill first".
app.use('/api', createBacktestRouter({ bridge: bridgeFromEnv() }));

const { createSignalRouter } = require('./routes/signals');
const { createRiskRouter } = require('./routes/risk');
const { createScheduler } = require('./scheduler');

const { createScanRunner } = require('./scanner/runner');

// One runner, shared: the scheduler drives it after each candle sync and the
// scanner routes read its snapshot. Two instances would show the dashboard a
// different scan from the one that sends the alerts.
const scanRunner = createScanRunner();
const scheduler = createScheduler({ bridge: bridgeFromEnv(), scanRunner });

app.use('/api', createSignalRouter());
app.use('/api', createRiskRouter({ scheduler }));

const { createExecutionRouter } = require('./routes/execution');

app.use('/api', createExecutionRouter({ bridge: bridgeFromEnv() }));

const { createAiRouter } = require('./routes/ai');

app.use('/api', createAiRouter());

const { createScannerRouter } = require('./routes/scanner');

app.use('/api', createScannerRouter({ bridge: bridgeFromEnv(), scanRunner }));

const { createSettingsRouter } = require('./routes/settings');

app.use('/api', createSettingsRouter());

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


app.get('/api/overview', (req, res) => {
  res.json(sampleOverview);
});

app.get('/api/news', (req, res) => {
  res.json(sampleNews);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Trading agent server running on http://localhost:${PORT}`);
});
