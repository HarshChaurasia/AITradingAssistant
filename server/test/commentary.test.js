const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase } = require('./helpers/db');

const SCRATCH_DB = 'trading_agent_commentary_test';

async function seeded(t) {
  await freshDatabase(t, SCRATCH_DB);
  const { runMigrations } = require('../src/db/migrate');
  const { query } = require('../src/db/pool');
  await runMigrations({ silent: true });

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, enabled, currency_profit, currency_margin, synced_at)
     VALUES ('EURUSD', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, 1, 'USD', 'EUR', UTC_TIMESTAMP())`
  );
  const [sym] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['EURUSD']);

  const rows = [];
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < 200; i += 1) {
    const close = 1.1 + i * 0.0001;
    rows.push([
      sym.id, 'H1',
      new Date(start + i * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      close, close + 0.0005, close - 0.0005, close, 100, 0, 8
    ]);
  }
  await query(
    `INSERT INTO candles (symbol_id, timeframe, open_time, open, high, low, close,
       tick_volume, real_volume, spread) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
    rows.flat()
  );

  return sym.id;
}

// A stand-in for the Anthropic client, so no test reaches the network.
function stubClient(impl) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        if (impl) return impl(params);
        return { content: [{ type: 'text', text: 'Price is grinding higher with no news risk nearby.' }] };
      }
    }
  };
}

test('commentary is unavailable without an API key', async (t) => {
  const symbolId = await seeded(t);
  const { marketCommentary } = require('../src/ai/commentary');

  const result = await marketCommentary({ symbolId, timeframe: 'H1', apiKey: '' });

  assert.equal(result.available, false);
  assert.match(result.reason, /not configured/i);
});

test('commentary summarises indicators and returns the model text', async (t) => {
  const symbolId = await seeded(t);
  const { marketCommentary } = require('../src/ai/commentary');

  const client = stubClient();
  const result = await marketCommentary({ symbolId, timeframe: 'H1', apiKey: 'sk-test', client });

  assert.equal(result.available, true);
  assert.match(result.text, /grinding higher/);

  assert.equal(client.calls.length, 1);
  const params = client.calls[0];
  assert.equal(params.model, 'claude-opus-5');

  // The prompt must carry computed indicator values, not raw candle rows.
  const prompt = JSON.stringify(params.messages);
  assert.match(prompt, /EURUSD/);
  assert.match(prompt, /rsi14/);
  assert.ok(!prompt.includes('open_time'), 'raw candle rows must not be pasted into the prompt');
});

test('an API failure degrades rather than throwing', async (t) => {
  const symbolId = await seeded(t);
  const { marketCommentary } = require('../src/ai/commentary');

  const client = stubClient(() => { throw new Error('overloaded_error'); });
  const result = await marketCommentary({
    symbolId, timeframe: 'H1', apiKey: 'sk-test', client, logger: { error: () => {} }
  });

  assert.equal(result.available, false);
  assert.match(result.reason, /overloaded/);
});

test('a refusal is reported rather than returned as commentary', async (t) => {
  const symbolId = await seeded(t);
  const { marketCommentary } = require('../src/ai/commentary');

  const client = stubClient(() => ({ stop_reason: 'refusal', content: [] }));
  const result = await marketCommentary({ symbolId, timeframe: 'H1', apiKey: 'sk-test', client });

  assert.equal(result.available, false);
  assert.match(result.reason, /declined/i);
});

test('a symbol with no candles reports why, without calling the model', async (t) => {
  await seeded(t);
  const { marketCommentary } = require('../src/ai/commentary');
  const { query } = require('../src/db/pool');

  await query(
    `INSERT INTO symbols (broker_symbol, digits, point, contract_size, tick_size,
       tick_value, min_lot, lot_step, max_lot, synced_at)
     VALUES ('GBPUSD', 5, 0.00001, 100000, 0.00001, 1, 0.01, 0.01, 100, UTC_TIMESTAMP())`
  );
  const [empty] = await query('SELECT id FROM symbols WHERE broker_symbol = ?', ['GBPUSD']);

  const client = stubClient();
  const result = await marketCommentary({ symbolId: empty.id, timeframe: 'H1', apiKey: 'sk-test', client });

  assert.equal(result.available, false);
  assert.match(result.reason, /no candles/i);
  assert.equal(client.calls.length, 0, 'no point paying for a call with nothing to describe');
});
