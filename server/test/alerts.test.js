const test = require('node:test');
const assert = require('node:assert/strict');

const { sendAlert } = require('../src/alerts/notifier');

function stubFetch(impl) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return impl ? impl(url, options) : { ok: true, status: 200, text: async () => 'ok' };
  };
  fn.calls = calls;
  return fn;
}

test('an alert posts to the Telegram bot API', async () => {
  const fetchImpl = stubFetch();
  const result = await sendAlert('kill switch tripped', {
    fetchImpl, botToken: 'BOT123', chatId: '456'
  });

  assert.equal(result.sent, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /api\.telegram\.org\/botBOT123\/sendMessage/);

  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.chat_id, '456');
  assert.match(body.text, /kill switch tripped/);
});

test('an unconfigured notifier is a no-op, not an error', async () => {
  const fetchImpl = stubFetch();
  const result = await sendAlert('anything', { fetchImpl, botToken: '', chatId: '' });

  assert.equal(result.sent, false);
  assert.match(result.reason, /not configured/i);
  assert.equal(fetchImpl.calls.length, 0, 'nothing is sent when there is nowhere to send it');
});

test('a network failure is swallowed, never thrown', async () => {
  const fetchImpl = stubFetch(() => { throw new Error('ENOTFOUND api.telegram.org'); });

  const result = await sendAlert('important', {
    fetchImpl, botToken: 'B', chatId: 'C', logger: { error: () => {} }
  });

  assert.equal(result.sent, false);
  assert.match(result.reason, /ENOTFOUND/);
});

test('a non-2xx response is reported but does not throw', async () => {
  const fetchImpl = stubFetch(async () => ({ ok: false, status: 429, text: async () => 'Too Many Requests' }));

  const result = await sendAlert('rate limited', {
    fetchImpl, botToken: 'B', chatId: 'C', logger: { error: () => {} }
  });

  assert.equal(result.sent, false);
  assert.match(result.reason, /429/);
});

test('event helpers produce messages naming what happened', async () => {
  const events = require('../src/alerts/events');
  const sent = [];
  const send = async (text) => { sent.push(text); return { sent: true }; };

  await events.alertKillSwitch({ mode: 'demo', reason: '3 consecutive losses', send });
  await events.alertOrderFilled({ symbol: 'EURUSD', side: 'BUY', lot: 0.1, ticket: 42, mode: 'demo', send });
  await events.alertOrderFailed({ symbol: 'XAUUSD', reason: 'Invalid stops', mode: 'demo', send });
  await events.alertDailyLossCap({ mode: 'live', realized: -55, cap: 50, send });

  assert.match(sent[0], /KILL SWITCH/i);
  assert.match(sent[0], /3 consecutive losses/);
  assert.match(sent[1], /EURUSD/);
  assert.match(sent[1], /BUY/);
  assert.match(sent[1], /0\.1/);
  assert.match(sent[2], /Invalid stops/);
  assert.match(sent[3], /loss cap/i);
  assert.match(sent[3], /-55/);
});

test('an alert failure inside an event helper does not propagate', async () => {
  const events = require('../src/alerts/events');
  const send = async () => { throw new Error('telegram exploded'); };

  // Must resolve, not reject: an alerting outage cannot be allowed to break
  // the trading path that called it.
  await events.alertKillSwitch({ mode: 'demo', reason: 'x', send, logger: { error: () => {} } });
});

test('no alert leaves the machine while NODE_ENV is test', async () => {
  // This is the guard that stopped the test suite from texting fictional
  // fills to a real phone: stub tickets 555, 777 and 888 arrived on Telegram
  // looking exactly like live trades.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  const fetchImpl = stubFetch();
  const result = await sendAlert('this must never be delivered', {
    fetchImpl, botToken: 'REAL-LOOKING-TOKEN', chatId: '123456'
  });

  process.env.NODE_ENV = previous;

  assert.equal(result.sent, false);
  assert.match(result.reason, /NODE_ENV=test/);
  assert.equal(fetchImpl.calls.length, 0, 'not a single outbound request may be made');
});

test('the event helpers are silent under test even with a token configured', async () => {
  const events = require('../src/alerts/events');
  const previous = process.env.NODE_ENV;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChat = process.env.TELEGRAM_CHAT_ID;

  process.env.NODE_ENV = 'test';
  process.env.TELEGRAM_BOT_TOKEN = 'looks-real';
  process.env.TELEGRAM_CHAT_ID = '999';

  const realFetch = globalThis.fetch;
  let attempted = 0;
  globalThis.fetch = async () => { attempted += 1; return { ok: true, text: async () => 'ok' }; };

  try {
    await events.alertOrderFilled({ symbol: 'XAUUSD', side: 'BUY', lot: 1, ticket: 555, mode: 'demo' });
    await events.alertKillSwitch({ mode: 'demo', reason: 'test' });
  } finally {
    globalThis.fetch = realFetch;
    process.env.NODE_ENV = previous;
    process.env.TELEGRAM_BOT_TOKEN = previousToken;
    process.env.TELEGRAM_CHAT_ID = previousChat;
  }

  assert.equal(attempted, 0, 'the execution tests must not be able to reach Telegram');
});

/**
 * The day summary. The number in a close message is unreadable alone: -1,392
 * is a disaster or a rounding error depending on what the other trades did.
 */
test('the day summary totals the day and names the worst strategy', async () => {
  const events = require('../src/alerts/events');
  let text = null;
  const send = async (message) => { text = message; };

  await events.alertDaySummary({
    mode: 'demo',
    closedNow: 2,
    openPositions: 4,
    trades: [
      { pnl: 500, strategy: 'trend-breakout' },
      { pnl: -1392.32, strategy: 'macd-trend' },
      { pnl: 250, strategy: 'trend-breakout' }
    ],
    send
  });

  assert.match(text, /TODAY so far {2}-642\.32/);
  assert.match(text, /3 closed \(2W \/ 1L\)/);
  assert.match(text, /2 of them just now/);
  assert.match(text, /profit factor 0\.54/);
  assert.match(text, /trend-breakout \+750\.00 \(2\)/);
  assert.match(text, /macd-trend -1392\.32 \(1\)/);
  assert.match(text, /worst macd-trend/);
  assert.match(text, /4 still open/);
});

test('a day summary with no closes yet still reports a total rather than failing', async () => {
  const events = require('../src/alerts/events');
  let text = null;
  await events.alertDaySummary({ mode: 'demo', trades: [], send: async (m) => { text = m; } });

  assert.match(text, /TODAY so far {2}\+0\.00/);
  assert.match(text, /0 closed/);
  // No profit factor, because dividing by no losses is not a number anyone
  // should be shown.
  assert.doesNotMatch(text, /profit factor/);
});
