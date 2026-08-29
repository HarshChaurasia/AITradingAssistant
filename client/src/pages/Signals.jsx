import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

function Gates({ decision }) {
  if (!decision?.checks) return null;
  return (
    <ul className="gates">
      {decision.checks.map((c) => (
        <li key={c.name} className={c.passed ? 'gate pass' : 'gate fail'}>
          <span className="gate-name">{c.name.replace(/_/g, ' ')}</span>
          <span className="gate-detail">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Signals() {
  const [mode, setMode] = useState('demo');
  const [status, setStatus] = useState('');
  const [signals, setSignals] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const query = `?mode=${mode}${status ? `&status=${status}` : ''}`;
    setSignals(await api.signals(query));
  }, [mode, status]);

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

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Signals</h3>
        <span>{mode === 'live' ? 'live signals need your approval' : 'demo runs hands-off'}</span>
      </div>

      <div className="toolbar">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="demo">demo</option>
          <option value="live">live</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">all statuses</option>
          <option value="new">new</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
          <option value="expired">expired</option>
        </select>
        <button disabled={busy} onClick={() => act(() => api.runScheduler())}>
          Run a cycle now
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {signals.length === 0 && <p className="empty">No signals for this filter.</p>}

      {signals.map((s) => (
        <div key={s.id} className={`signal-card ${s.status}`}>
          <div className="signal-head">
            <div>
              <strong>{s.broker_symbol}</strong>
              <span className={`badge ${s.side === 'BUY' ? 'buy' : 'sell'}`}>{s.side}</span>
              <small>{s.strategy_name} · {s.timeframe}</small>
            </div>
            <div className="align-right">
              <span className={`status-tag ${s.status}`}>{s.status}</span>
              {s.auto_approved === 1 && <small> auto</small>}
            </div>
          </div>

          <div className="signal-numbers">
            <span>entry <strong>{s.entry}</strong></span>
            <span>stop <strong>{s.sl}</strong></span>
            <span>target <strong>{s.tp ?? '—'}</strong></span>
            <span>lot <strong>{s.lot ?? '—'}</strong></span>
          </div>

          {s.reason && <p className="muted">{s.reason}</p>}

          <button className="link" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
            {expanded === s.id ? 'hide' : 'show'} risk gates
          </button>
          {expanded === s.id && <Gates decision={s.decision} />}

          {s.status === 'new' && (
            <div className="signal-actions">
              <button disabled={busy} onClick={() => act(() => api.approveSignal(s.id))}>Approve</button>
              <button
                disabled={busy}
                onClick={() => act(() => api.rejectSignal(s.id, 'rejected from the dashboard'))}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
