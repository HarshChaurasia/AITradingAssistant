require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createScanRunner } = require('../src/scanner/runner');
const { DEFAULT_OPERATIONS_SETTINGS } = require('../src/settings/operations');

const silent = { log: () => {}, error: () => {} };

function firing({ symbol, timeframe, score, wouldTrade = true, blockedBy = null }) {
  return {
    symbolId: 1,
    symbol,
    tradeable: wouldTrade,
    digits: 2,
    timeframe,
    price: 100,
    barTime: '2026-03-01T00:00:00.000Z',
    note: null,
    strategies: [{
      strategy: 'trend-breakout',
      status: 'demo',
      strategyEnabled: true,
      firing: true,
      side: 'BUY',
      reason: 'close above the 20-bar high',
      checks: [],
      features: {},
      score,
      scoreComponents: [],
      levels: { entry: 100, sl: 98, tp: 104 },
      risk: { allowed: true, lot: 0.1, riskAmount: 20, checks: [], denialReasons: [] },
      wouldTrade,
      blockedBy
    }]
  };
}

function runnerWith({ rows, settings = {}, alerts = [] }) {
  let call = 0;
  return createScanRunner({
    loadSettingsFn: async () => ({ ...DEFAULT_OPERATIONS_SETTINGS, scanTimeframes: ['H4'], ...settings }),
    queryFn: async (sql) => (/FROM strategies/.test(sql)
      ? [{ id: 1, name: 'trend-breakout', status: 'demo', enabled: 1, params: {} }]
      : [{ id: 1, broker_symbol: 'BTCUSD', enabled: 1, watched: 1, digits: 2 }]),
    countOpenPositionsFn: async () => 0,
    loadEvidenceFn: async () => () => null,
    evaluateFn: async () => rows[Math.min(call++, rows.length - 1)],
    alertFn: async (o) => { alerts.push(o); },
    logger: silent
  });
}

test('a finished scan separates tradeable setups from blocked ones', async () => {
  const runner = runnerWith({ rows: [firing({ symbol: 'BTCUSD', timeframe: 'H4', score: 80 })] });
  const result = await runner.scan({ mode: 'demo' });

  assert.equal(result.opportunities.length, 1);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.opportunities[0].symbol, 'BTCUSD');
  assert.equal(result.symbolsScanned, 1);
});

test('a blocked setup is reported, not discarded', async () => {
  // The commonest question an operator has is "why did nothing trade". A
  // scanner that only lists winners cannot answer it.
  const runner = runnerWith({
    rows: [firing({ symbol: 'BTCUSD', timeframe: 'H4', score: 60, wouldTrade: false, blockedBy: 'kill switch' })]
  });
  const result = await runner.scan({ mode: 'demo' });

  assert.equal(result.opportunities.length, 0);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].blockedBy, 'kill switch');
});

test('opportunities come back highest score first', async () => {
  const runner = createScanRunner({
    loadSettingsFn: async () => ({ ...DEFAULT_OPERATIONS_SETTINGS, scanTimeframes: ['H1', 'H4'] }),
    queryFn: async (sql) => (/FROM strategies/.test(sql)
      ? [{ id: 1, name: 'trend-breakout', status: 'demo', enabled: 1, params: {} }]
      : [{ id: 1, broker_symbol: 'BTCUSD', enabled: 1, watched: 1, digits: 2 }]),
    countOpenPositionsFn: async () => 0,
    loadEvidenceFn: async () => () => null,
    evaluateFn: async ({ timeframe }) => firing({
      symbol: 'BTCUSD', timeframe, score: timeframe === 'H4' ? 90 : 40
    }),
    alertFn: async () => {},
    logger: silent
  });

  const result = await runner.scan({ mode: 'demo' });
  assert.deepEqual(result.opportunities.map((o) => o.score), [90, 40]);
});

test('the same setup is announced once, not on every scan', async () => {
  // A setup persists for the whole life of its bar. Without a cooldown that is
  // one Telegram message per scan, for hours.
  const alerts = [];
  const runner = runnerWith({
    rows: [firing({ symbol: 'BTCUSD', timeframe: 'H4', score: 80 })],
    alerts
  });

  await runner.scan({ mode: 'demo' });
  await runner.scan({ mode: 'demo' });
  await runner.scan({ mode: 'demo' });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].symbol, 'BTCUSD');
});

test('alerts can be switched off entirely', async () => {
  const alerts = [];
  const runner = runnerWith({
    rows: [firing({ symbol: 'BTCUSD', timeframe: 'H4', score: 80 })],
    settings: { scannerAlertsEnabled: false },
    alerts
  });

  const result = await runner.scan({ mode: 'demo' });
  assert.equal(alerts.length, 0);
  assert.equal(result.alerted, 0);
});

test('a blocked setup never sends an alert', async () => {
  // Telling someone about a trade the system refused to take is noise that
  // trains them to ignore the channel.
  const alerts = [];
  const runner = runnerWith({
    rows: [firing({ symbol: 'BTCUSD', timeframe: 'H4', score: 95, wouldTrade: false, blockedBy: 'daily loss cap' })],
    alerts
  });

  await runner.scan({ mode: 'demo' });
  assert.equal(alerts.length, 0);
});

test('an alerting outage does not fail the scan', async () => {
  const runner = createScanRunner({
    loadSettingsFn: async () => ({ ...DEFAULT_OPERATIONS_SETTINGS, scanTimeframes: ['H4'] }),
    queryFn: async (sql) => (/FROM strategies/.test(sql)
      ? [{ id: 1, name: 'trend-breakout', status: 'demo', enabled: 1, params: {} }]
      : [{ id: 1, broker_symbol: 'BTCUSD', enabled: 1, watched: 1, digits: 2 }]),
    countOpenPositionsFn: async () => 0,
    loadEvidenceFn: async () => () => null,
    evaluateFn: async () => firing({ symbol: 'BTCUSD', timeframe: 'H4', score: 80 }),
    alertFn: async () => { throw new Error('telegram exploded'); },
    logger: silent
  });

  const result = await runner.scan({ mode: 'demo' });
  assert.equal(result.opportunities.length, 1, 'the scan still produced its result');
  assert.equal(result.alerted, 0);
});

test('a symbol with no candles is reported rather than silently missing', async () => {
  const runner = runnerWith({
    rows: [{
      symbolId: 1, symbol: 'BTCUSD', tradeable: true, digits: 2, timeframe: 'H4',
      price: null, barTime: null, strategies: [], note: 'no H4 candles stored - backfill this symbol first'
    }]
  });

  const result = await runner.scan({ mode: 'demo' });
  assert.equal(result.missingData.length, 1);
  assert.match(result.missingData[0].note, /backfill/);
});

test('a second scan is refused while one is in flight', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const runner = createScanRunner({
    loadSettingsFn: async () => ({ ...DEFAULT_OPERATIONS_SETTINGS, scanTimeframes: ['H4'] }),
    queryFn: async (sql) => (/FROM strategies/.test(sql)
      ? [{ id: 1, name: 'trend-breakout', status: 'demo', enabled: 1, params: {} }]
      : [{ id: 1, broker_symbol: 'BTCUSD', enabled: 1, watched: 1, digits: 2 }]),
    countOpenPositionsFn: async () => 0,
    loadEvidenceFn: async () => () => null,
    evaluateFn: async () => { await gate; return firing({ symbol: 'BTCUSD', timeframe: 'H4', score: 50 }); },
    alertFn: async () => {},
    logger: silent
  });

  const first = runner.scan({ mode: 'demo' });
  assert.equal(runner.isScanning(), true);

  // Two concurrent sweeps would fight over the same MT5 terminal.
  const second = await runner.scan({ mode: 'demo' });
  assert.equal(second.skipped, true);

  release();
  await first;
  assert.equal(runner.isScanning(), false);
});

test('the snapshot carries progress while scanning and the result afterwards', async () => {
  const runner = runnerWith({ rows: [firing({ symbol: 'BTCUSD', timeframe: 'H4', score: 70 })] });

  const before = runner.snapshot();
  assert.equal(before.scanning, false);
  assert.equal(before.last, null);

  await runner.scan({ mode: 'demo' });

  const after = runner.snapshot();
  assert.equal(after.scanning, false);
  assert.equal(after.last.opportunities.length, 1);
  assert.ok(after.feed.length >= 2, 'the feed records the start and the finish');
});
