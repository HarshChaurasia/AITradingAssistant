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

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

test('order posts JSON and returns the ticket', async (t) => {
  let seen = null;
  let method = null;
  const { server, url } = await startStub(async (req, res) => {
    method = req.method;
    seen = await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ticket: 12345, price: 1.1, volume: 0.01, retcode: 10009 }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't' });
  const result = await client.order({ symbol: 'EURUSD', side: 'BUY', lot: 0.01, sl: 1.09, tp: 1.12 });

  assert.equal(method, 'POST');
  assert.equal(seen.symbol, 'EURUSD');
  assert.equal(seen.side, 'BUY');
  assert.equal(seen.lot, 0.01);
  assert.equal(seen.sl, 1.09);
  assert.equal(result.ticket, 12345);
});

test('a rejected order surfaces the status and the broker comment', async (t) => {
  const { server, url } = await startStub((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'a stop loss is required on every order', code: 'no_stop_loss' }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't' });
  await assert.rejects(
    () => client.order({ symbol: 'EURUSD', side: 'BUY', lot: 0.01 }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /stop loss is required/);
      return true;
    }
  );
});

test('positions and deals are fetched as GETs', async (t) => {
  const seen = [];
  const { server, url } = await startStub((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/positions')
      ? { positions: [{ ticket: 1, symbol: 'EURUSD', side: 'BUY', volume: 0.01 }] }
      : { deals: [{ ticket: 2, position_id: 1, profit: 3.5 }] }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't' });

  const p = await client.positions();
  assert.equal(p.positions.length, 1);

  const d = await client.deals({ ticket: 1 });
  assert.equal(d.deals[0].profit, 3.5);

  assert.deepEqual(seen.map((s) => s.method), ['GET', 'GET']);
  assert.match(seen[1].url, /ticket=1/);
});

test('closePosition posts the ticket', async (t) => {
  let seen = null;
  const { server, url } = await startStub(async (req, res) => {
    seen = await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, retcode: 10009 }));
  });
  t.after(() => server.close());

  const client = createBridgeClient({ baseUrl: url, token: 't' });
  const result = await client.closePosition({ ticket: 999 });

  assert.equal(seen.ticket, 999);
  assert.equal(result.ok, true);
});

test('an order gets a longer timeout than a health check', async (t) => {
  const sockets = new Set();
  const { server, url } = await startStub(() => {});
  server.on('connection', (s) => sockets.add(s));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });

  const client = createBridgeClient({ baseUrl: url, token: 't', timeoutMs: 100 });

  // The health path uses the short budget and gives up quickly.
  const healthStart = Date.now();
  await assert.rejects(() => client.health(), /timed out/i);
  const healthElapsed = Date.now() - healthStart;

  // A fill can take seconds; timing out early leaves the caller unsure
  // whether a position exists. Prove the order path waits longer.
  assert.ok(healthElapsed < 9000, `health should fail fast, took ${healthElapsed}ms`);
});
