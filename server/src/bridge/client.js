/**
 * The only place the Node server talks to the Python MT5 bridge.
 * Node 22 provides global fetch and AbortSignal.timeout.
 */

const ORDER_TIMEOUT_MS = 30000;

function createBridgeClient({ baseUrl, token, timeoutMs = 15000 }) {
  if (!baseUrl) throw new Error('bridge client requires baseUrl');

  async function request(path, params, overrideTimeoutMs, options = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const budgetMs = overrideTimeoutMs ?? timeoutMs;
    const headers = { 'X-Bridge-Token': token || '' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(budgetMs)
      });
    } catch (cause) {
      // fetch reports an abort as either TimeoutError or AbortError depending
      // on where in the request lifecycle the signal fires.
      const timedOut = cause.name === 'TimeoutError' || cause.name === 'AbortError';
      const err = new Error(
        timedOut
          ? `bridge request to ${path} timed out after ${budgetMs}ms`
          : `bridge request to ${path} failed: ${cause.message}`
      );
      err.cause = cause;
      throw err;
    }

    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text };
    }

    if (!response.ok) {
      const err = new Error(`bridge ${path} returned ${response.status}: ${body.error || text}`);
      err.status = response.status;
      throw err;
    }
    return body;
  }

  return {
    // Health is polled by the dashboard, so it must fail fast; a sync may
    // legitimately pull thousands of bars and gets the full timeout.
    health: () => request('/health', undefined, 8000),
    account: () => request('/account', undefined, 8000),
    symbols: () => request('/symbols'),
    candles: ({ symbol, timeframe = 'H1', count = 500 }) =>
      request('/candles', { symbol, timeframe, count }),

    positions: () => request('/positions', undefined, 20000),
    deals: ({ ticket }) => request('/deals', { ticket }, 20000),

    // Orders get their own, longer budget. A fill can take several seconds,
    // and timing out mid-order leaves the caller unsure whether a position
    // now exists - the worst possible state to be in.
    order: (payload) => request('/order', undefined, ORDER_TIMEOUT_MS, { method: 'POST', body: payload }),
    closePosition: ({ ticket }) =>
      request('/close', undefined, ORDER_TIMEOUT_MS, { method: 'POST', body: { ticket } })
  };
}

function bridgeFromEnv() {
  return createBridgeClient({
    baseUrl: process.env.BRIDGE_URL || 'http://127.0.0.1:8000',
    // Symbol and candle syncs can pull thousands of bars from the terminal.
    timeoutMs: Number(process.env.BRIDGE_TIMEOUT_MS || 60000),
    token: process.env.BRIDGE_TOKEN
  });
}

module.exports = { createBridgeClient, bridgeFromEnv };
