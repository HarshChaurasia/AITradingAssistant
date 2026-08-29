import { useCallback, useEffect, useState } from 'react';
import EquityCurve from '../components/EquityCurve';
import { api } from '../api';

function num(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(digits);
}

export default function Trades() {
  const [mode, setMode] = useState('demo');
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [equity, setEquity] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setTrades(await api.trades(mode));
    setStats(await api.tradeStats(mode));
    setEquity(await api.equity(mode));
  }, [mode]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const open = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING');
  const done = trades.filter((t) => t.status === 'CLOSED' || t.status === 'CANCELLED');

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Execution</h3>
        <span>{mode} account</span>
      </div>

      <div className="toolbar">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="demo">demo</option>
          <option value="live">live</option>
        </select>
        <button disabled={busy} onClick={() => act(() => api.runExecution(mode))}>
          Send approved signals
        </button>
        <button disabled={busy} onClick={() => act(() => api.reconcile(mode))}>
          Reconcile with broker
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {stats && (
        <section className="stats-grid">
          <div className="stat-card blue"><span>Open</span><strong>{stats.open}</strong></div>
          <div className="stat-card purple"><span>Closed</span><strong>{stats.closed}</strong></div>
          <div className={`stat-card ${stats.netPnl >= 0 ? 'green' : 'orange'}`}>
            <span>Net P&amp;L</span><strong>{num(stats.netPnl)}</strong>
          </div>
          <div className="stat-card orange"><span>Win rate</span><strong>{num(stats.winRatePct, 1)}%</strong></div>
        </section>
      )}

      <h4>Open positions</h4>
      {open.length === 0 ? <p className="empty">No open positions.</p> : (
        <table className="table">
          <thead>
            <tr><th>#</th><th>Symbol</th><th>Side</th><th>Lot</th><th>Entry</th><th>Stop</th><th>Target</th><th>Ticket</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {open.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td>{t.broker_symbol}</td>
                <td className={t.side === 'BUY' ? 'up' : 'down'}>{t.side}</td>
                <td>{num(t.lot, 2)}</td>
                <td>{num(t.entry_price, 5)}</td>
                <td>{num(t.sl, 5)}</td>
                <td>{t.tp ? num(t.tp, 5) : '—'}</td>
                <td>{t.broker_ticket ?? '—'}</td>
                <td>{t.status}</td>
                <td>
                  {t.status === 'OPEN' && (
                    <button disabled={busy} onClick={() => act(() => api.closeTrade(t.id))}>Close</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>Equity</h4>
      <EquityCurve equity={equity.map((e) => Number(e.equity))} />

      <h4>Journal</h4>
      {done.length === 0 ? <p className="empty">No closed trades yet.</p> : (
        <table className="table">
          <thead>
            <tr><th>#</th><th>Symbol</th><th>Side</th><th>Lot</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Reason</th><th>Status</th></tr>
          </thead>
          <tbody>
            {done.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td>{t.broker_symbol}</td>
                <td className={t.side === 'BUY' ? 'up' : 'down'}>{t.side}</td>
                <td>{num(t.lot, 2)}</td>
                <td>{num(t.entry_price, 5)}</td>
                <td>{t.close_price ? num(t.close_price, 5) : '—'}</td>
                <td className={Number(t.pnl) >= 0 ? 'up' : 'down'}>{num(t.pnl)}</td>
                <td>{t.exit_reason || t.broker_comment || '—'}</td>
                <td>{t.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
