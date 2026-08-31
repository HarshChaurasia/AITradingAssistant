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
  scanner: (timeframe = 'H4') => request(`/api/scanner?timeframe=${timeframe}`),
  setSymbolWatched: (id, watched) =>
    request(`/api/symbols/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watched })
    }),
  tradeSetup: (symbolId, strategy, timeframe) =>
    request('/api/scanner/trade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbolId, strategy, timeframe })
    }),
  performance: (mode = 'demo', days = 30) =>
    request(`/api/performance?mode=${mode}&days=${days}`),
  strategies: () => request('/api/strategies'),
  backtests: () => request('/api/backtests'),
  backtest: (id) => request(`/api/backtests/${id}`),
  runBacktest: (payload) =>
    request('/api/backtests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }),
  marketStatus: () => request('/api/symbols/market-status'),
  news: (hours = 72, minImpact = 'HIGH') =>
    request(`/api/news?hours=${hours}&minImpact=${minImpact}`),
  syncNews: () => request('/api/news/sync', { method: 'POST' }),
  scalpViability: () => request('/api/scalp-viability'),
  coverage: () => request('/api/coverage'),
  backfillStatus: () => request('/api/coverage/backfill'),
  startBackfill: (months = 6) =>
    request('/api/coverage/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ months })
    }),
  refreshMarketStatus: () => request('/api/symbols/market-status/refresh', { method: 'POST' }),
  scannerLive: () => request('/api/scanner/live'),
  startScan: (mode = 'demo') =>
    request('/api/scanner/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode })
    }),
  settings: () => request('/api/settings'),
  saveSettings: (patch) =>
    request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    }),
  strategyAnalytics: (mode = 'demo') => request(`/api/strategies/analytics?mode=${mode}`),
  patchStrategy: (id, patch) =>
    request(`/api/strategies/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    }),
  strategyScopes: (id) => request(`/api/strategies/${id}/scopes`),
  saveStrategyScopes: (id, scopes) =>
    request(`/api/strategies/${id}/scopes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopes })
    }),
  // The strategy lab: parameter search, judged on data the search never saw.
  labStudies: (params = '') => request(`/api/lab/studies${params}`),
  startLabStudy: (payload) =>
    request('/api/lab/studies', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }),
  cancelLabStudy: () => request('/api/lab/studies/cancel', { method: 'POST' }),
  promoteStudy: (id) => request(`/api/lab/studies/${id}/promote`, { method: 'POST' }),
  revokePromotion: (id, note) =>
    request(`/api/lab/promotions/${id}/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note })
    }),

  sweepBacktests: (payload) =>
    request('/api/backtests/sweep', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }),
  missed: (mode = 'demo', verdict = '') =>
    request(`/api/missed?mode=${mode}${verdict ? `&verdict=${verdict}` : ''}`),
  evaluateMissed: () => request('/api/missed/evaluate', { method: 'POST' }),
  // `months` lets the server work out the bar count from the timeframe. Six
  // months of M5 is 52,000 bars and six months of D1 is 183; one flat number
  // cannot mean the same span on both.
  syncCandles: (symbolId, timeframe, months = 6) =>
    request('/api/candles/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbolId, timeframe, months })
    })
};
