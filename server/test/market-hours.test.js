require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { marketStatus, refreshMarketStatus, MAX_STATUS_AGE_SECONDS } = require('../src/market/market-hours');

const NOW = new Date('2026-08-30T12:00:00Z');

function checkedAgo(seconds) {
  return new Date(NOW.getTime() - seconds * 1000);
}

function symbolWith(overrides = {}) {
  return {
    id: 1,
    broker_symbol: 'EURUSD',
    trade_mode: 4,
    market_open: 1,
    market_reason: 'the broker accepts orders',
    market_checked_at: checkedAgo(30),
    ...overrides
  };
}

test('a market the broker reports open is allowed', () => {
  const status = marketStatus({ symbol: symbolWith(), now: NOW });
  assert.equal(status.open, true);
  assert.equal(status.known, true);
  assert.equal(status.ageSeconds, 30);
});

test('a market the broker reports closed is refused, with the broker word for word', () => {
  const status = marketStatus({
    symbol: symbolWith({
      market_open: 0,
      market_reason: 'the broker reports the market closed (Market closed)'
    }),
    now: NOW
  });

  assert.equal(status.open, false);
  assert.match(status.reason, /Market closed/);
});

test('a status that has never been checked refuses rather than assuming open', () => {
  // Failing open here would put the gate back where it started: an order sent
  // into a shut market because nobody had current information.
  const status = marketStatus({
    symbol: symbolWith({ market_checked_at: null, market_open: null }),
    now: NOW
  });

  assert.equal(status.open, false);
  assert.equal(status.known, false);
  assert.match(status.reason, /never been checked/);
});

test('a stale status refuses even when it last said open', () => {
  // The commonest way this goes wrong: the bridge drops, the row keeps its old
  // "open" flag, and the system trades on an answer from an hour ago.
  const status = marketStatus({
    symbol: symbolWith({ market_open: 1, market_checked_at: checkedAgo(MAX_STATUS_AGE_SECONDS + 60) }),
    now: NOW
  });

  assert.equal(status.open, false);
  assert.equal(status.known, false);
  assert.match(status.reason, /is \d+s old/);
  assert.match(status.reason, /broker link may be down/);
});

test('a status just inside the age limit is still trusted', () => {
  const status = marketStatus({
    symbol: symbolWith({ market_checked_at: checkedAgo(MAX_STATUS_AGE_SECONDS - 1) }),
    now: NOW
  });
  assert.equal(status.open, true);
});

test('a MySQL datetime string is parsed as UTC, not as local time', () => {
  // The column has no zone. Read as local time on a UTC+5:30 machine it would
  // look five and a half hours stale and refuse every symbol.
  const status = marketStatus({
    symbol: symbolWith({ market_checked_at: '2026-08-30 11:59:00' }),
    now: NOW
  });

  assert.equal(status.ageSeconds, 60);
  assert.equal(status.open, true);
});

test('the refresh stores what the broker said', async () => {
  const writes = [];
  const bridge = {
    marketStatus: async (symbol) => ({
      symbol, open: symbol === 'BTCUSD', trade_mode: 4, tick_age_seconds: 3,
      reason: symbol === 'BTCUSD' ? 'the broker accepts orders' : 'the broker reports the market closed'
    })
  };

  const result = await refreshMarketStatus(bridge, {
    symbols: [{ id: 1, broker_symbol: 'BTCUSD' }, { id: 2, broker_symbol: 'EURUSD' }],
    logger: { error: () => {} },
    queryFn: async (sql, params) => { writes.push(params); return { affectedRows: 1 }; }
  });

  assert.equal(result.updated, 2);
  assert.equal(writes[0][1], 1, 'BTCUSD open');
  assert.equal(writes[1][1], 0, 'EURUSD closed');
});

test('one unreachable symbol does not cost the others their status', async () => {
  const bridge = {
    marketStatus: async (symbol) => {
      if (symbol === 'EURUSD') throw new Error('bridge timed out');
      return { symbol, open: true, trade_mode: 4, tick_age_seconds: 1, reason: 'open' };
    }
  };

  const result = await refreshMarketStatus(bridge, {
    symbols: [{ id: 1, broker_symbol: 'BTCUSD' }, { id: 2, broker_symbol: 'EURUSD' }],
    logger: { error: () => {} },
    queryFn: async () => ({ affectedRows: 1 })
  });

  assert.equal(result.updated, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].symbol, 'EURUSD');
  // Its row keeps the old timestamp, goes stale, and the gate refuses it -
  // the correct outcome for a symbol we cannot ask about.
});
