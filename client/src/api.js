export class AuthError extends Error {}

async function request(path, options) {
  // Cookies must be sent explicitly: the dev server proxies to another port,
  // and without this every call after login is silently anonymous.
  const response = await fetch(path, { credentials: 'include', ...options });

  if (!response.ok) {
    let message = response.statusText;
    try {
      message = (await response.json()).error || message;
    } catch {
      // Response had no JSON body; the status text is the best we have.
    }
    if (response.status === 401) throw new AuthError(message);
    throw new Error(message);
  }
  return response.json();
}

export const api = {
  authStatus: () => request('/api/auth/status'),
  login: (username, password) =>
    request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
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
  signals: (params = '') => request(`/api/signals${params}`),
  approveSignal: (id) => request(`/api/signals/${id}/approve`, { method: 'POST' }),
  rejectSignal: (id, reason) =>
    request(`/api/signals/${id}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason })
    }),
  riskState: (mode = 'demo') => request(`/api/risk/state?mode=${mode}`),
  riskSettings: () => request('/api/risk/settings'),
  saveRiskSettings: (patch) =>
    request('/api/risk/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    }),
  killSwitch: (mode, on, reason) =>
    request('/api/risk/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, on, reason })
    }),
  scheduler: () => request('/api/scheduler'),
  runScheduler: () => request('/api/scheduler/run', { method: 'POST' }),
  trades: (mode = 'demo', status = '') =>
    request(`/api/trades?mode=${mode}${status ? `&status=${status}` : ''}`),
  tradeStats: (mode = 'demo') => request(`/api/trades/stats?mode=${mode}`),
  equity: (mode = 'demo') => request(`/api/equity?mode=${mode}`),
  runExecution: (mode = 'demo') =>
    request('/api/execution/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode })
    }),
  reconcile: (mode = 'demo') =>
    request('/api/execution/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode })
    }),
  closeTrade: (tradeId) => request(`/api/execution/close/${tradeId}`, { method: 'POST' }),
  commentary: (symbolId, timeframe = 'H1') =>
    request(`/api/commentary?symbolId=${symbolId}&timeframe=${timeframe}`),
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
