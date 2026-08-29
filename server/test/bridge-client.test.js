const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createBridgeClient } = require('../src/bridge/client');

function startStub(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('bridge client sends the token header and parses JSON', async (t) => {
  let seenToken = null;
  const { server, url } = await startStub((req, res) => {
    seenToken = req.headers['x-bridge-token'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, account_login: 50045322 }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 'secret-token' });
  const health = await client.health();

  assert.equal(seenToken, 'secret-token');
  assert.equal(health.account_login, 50045322);
});

test('bridge client surfaces the status code on an error response', async (t) => {
  const { server, url } = await startStub((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 'wrong' });
  await assert.rejects(
    () => client.health(),
    (err) => {
      assert.equal(err.status, 401);
      assert.match(err.message, /unauthorized/);
      return true;
    }
  );
});

test('bridge client passes candle query parameters through', async (t) => {
  let seenUrl = null;
  const { server, url } = await startStub((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ symbol: 'EURUSD', timeframe: 'H1', server_utc_offset_seconds: 7200, candles: [] }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't' });
  const result = await client.candles({ symbol: 'EURUSD', timeframe: 'H1', count: 250 });

  assert.match(seenUrl, /symbol=EURUSD/);
  assert.match(seenUrl, /timeframe=H1/);
  assert.match(seenUrl, /count=250/);
  assert.equal(result.server_utc_offset_seconds, 7200);
});

test('bridge client times out rather than hanging', async (t) => {
  const sockets = new Set();
  const { server, url } = await startStub(() => {
    // Never respond: the bridge is wedged behind a frozen terminal.
  });
  server.on('connection', (socket) => sockets.add(socket));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  const client = createBridgeClient({ baseUrl: url, token: 't', timeoutMs: 150 });
  await assert.rejects(() => client.health(), /timed out/i);
});
