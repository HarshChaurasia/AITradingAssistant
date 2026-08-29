async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = response.statusText;
    try {
      message = (await response.json()).error || message;
    } catch {
      // Response had no JSON body; the status text is the best we have.
    }
    throw new Error(message);
  }
  return response.json();
}

export const api = {
  bridgeHealth: () => request('/api/bridge/health'),
  bridgeAccount: () => request('/api/bridge/account'),
  symbols: (enabledOnly = false) => request(`/api/symbols${enabledOnly ? '?enabledOnly=1' : ''}`),
  syncSymbols: () => request('/api/symbols/sync', { method: 'POST' }),
  setSymbolEnabled: (id, enabled) =>
    request(`/api/symbols/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled })
    }),
  candles: (symbolId, timeframe, limit = 500) =>
    request(`/api/candles?symbolId=${symbolId}&timeframe=${timeframe}&limit=${limit}`),
  strategies: () => request('/api/strategies'),
  backtests: () => request('/api/backtests'),
  backtest: (id) => request(`/api/backtests/${id}`),
  runBacktest: (payload) =>
    request('/api/backtests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }),
  syncCandles: (symbolId, timeframe, count = 2000) =>
    request('/api/candles/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbolId, timeframe, count })
    })
};
