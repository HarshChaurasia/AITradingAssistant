import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * The signal queue: what the scheduler generated, and what happened to each.
 *
 * This is deliberately NOT the scanner. The scanner is a live read of every
 * watched symbol on every scanned timeframe and persists nothing. This screen
 * shows only what was actually generated - one timeframe, enabled symbols,
 * enabled strategies - because those are the only rows that can become orders.
 */

function num(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(digits);
}

function price(value, digits) {
  return num(value, Number.isInteger(digits) ? digits : 2);
}

function ago(iso) {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

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

/**
 * What the last cycle actually did.
 *
 * "Run a cycle now" used to fire and say nothing, which is indistinguishable
 * from a broken button when the honest answer is "it ran and found no setup".
 */
function CycleReport({ result }) {
  if (!result) return null;
  if (result.error) return <p className="error">The cycle failed: {result.error}</p>;

  if (result.bridgeDown) {
    return (
      <p className="error">
        The broker link is down, so the cycle was skipped rather than trading blind. Start the MT5
        terminal and the bridge, then run it again.
      </p>
    );
  }

  const { signals = {}, execution = {}, reconciliation = {}, missed = {} } = result;

  return (
    <div className="cycle-report">
      <div className="cycle-grid">
        <span><strong>{result.timeframe}</strong><small>timeframe</small></span>
        <span><strong>{result.symbolsSynced}</strong><small>symbols synced</small></span>
        <span><strong>{signals.evaluated ?? 0}</strong><small>pairs evaluated</small></span>
        <span><strong>{signals.created ?? 0}</strong><small>signals created</small></span>
        <span><strong>{signals.skipped ?? 0}</strong><small>skipped, no data</small></span>
        <span><strong>{execution.disabled ? 'off' : execution.filled ?? 0}</strong><small>orders filled</small></span>
        <span><strong>{reconciliation.closed ?? 0}</strong><small>positions closed</small></span>
        <span><strong>{result.expired ?? 0}</strong><small>signals expired</small></span>
        <span><strong>{missed.graded ?? 0}</strong><small>refusals graded</small></span>
      </div>

      {signals.created === 0 && (signals.evaluated ?? 0) > 0 && (
        <p className="muted">
          Everything was evaluated and no strategy fired. That is the normal result: the validated
          BTCUSD H4 edge takes roughly one trade every four days, so most cycles find nothing.
        </p>
      )}
      {(signals.evaluated ?? 0) === 0 && (
        <p className="muted">
          Nothing was evaluated. That happens when no strategy is <strong>enabled</strong>, no symbol
          is enabled, or the enabled symbols have no stored candles on {result.timeframe}. The
          Strategies screen shows which are on.
        </p>
      )}
      {result.autoTrade === false && (signals.created ?? 0) > 0 && (
        <p className="muted">
          Auto-trade is off, so new signals are queued below for your approval rather than sent.
        </p>
      )}
    </div>
  );
}

export default function Signals() {
  const [mode, setMode] = useState('demo');
  const [status, setStatus] = useState('');
  const [signals, setSignals] = useState([]);
  const [scheduler, setScheduler] = useState(null);
  const [cycle, setCycle] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const query = `?mode=${mode}${status ? `&status=${status}` : ''}`;
    setSignals(await api.signals(query));
    setScheduler(await api.scheduler());
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

  async function runCycle() {
    setBusy(true);
    setError(null);
    setCycle(null);
    try {
      // A cycle syncs candles for every watched symbol before it evaluates
      // anything, so this can take a while. The button stays disabled rather
      // than letting a second cycle race the first.
      setCycle(await api.runScheduler());
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const counts = signals.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});

  const lastRun = scheduler?.lastRun;

  return (
    <>
      <section className="stats-grid">
        <div className="stat-card blue"><span>Showing</span><strong>{signals.length}</strong></div>
        <div className="stat-card green"><span>Approved</span><strong>{counts.approved || 0}</strong></div>
        <div className="stat-card orange"><span>Awaiting you</span><strong>{counts.new || 0}</strong></div>
        <div className="stat-card purple"><span>Rejected</span><strong>{counts.rejected || 0}</strong></div>
      </section>

      <div className="panel">
        <div className="panel-header">
          <h3>Signals</h3>
          <span>
            {scheduler?.running ? 'scheduler running' : 'scheduler stopped'}
            {lastRun?.at && ` · last cycle ${ago(lastRun.at)}`}
          </span>
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
            <option value="executed">executed</option>
          </select>
          <button disabled={busy} onClick={runCycle}>
            {busy ? 'Running a cycle…' : 'Run a cycle now'}
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        <CycleReport result={cycle || lastRun} />

        {signals.length === 0 && (
          <p className="empty">
            No signals for this filter. This screen only shows what the scheduler
            <strong> generated</strong> — one timeframe, enabled symbols, enabled strategies. For a
            live read of every watched symbol on every timeframe, use the Scanner.
          </p>
        )}
      </div>

      {signals.map((s) => (
        <div key={s.id} className={`signal-card ${s.status}`}>
          <div className="signal-head">
            <div>
              <strong>{s.broker_symbol}</strong>
              <span className={`badge ${s.side === 'BUY' ? 'buy' : 'sell'}`}>{s.side}</span>
              <small>{s.strategy_name} · {s.timeframe} · bar {String(s.bar_time).slice(0, 16).replace('T', ' ')}</small>
            </div>
            <div className="align-right">
              <span className={`status-tag ${s.status}`}>{s.status}</span>
              {s.auto_approved === 1 && <small> auto</small>}
              <small className="muted"> · {ago(s.generated_at)}</small>
            </div>
          </div>

          <div className="signal-numbers">
            <span>entry <strong>{price(s.entry, s.digits)}</strong></span>
            <span>stop <strong>{price(s.sl, s.digits)}</strong></span>
            <span>target <strong>{s.tp === null ? '—' : price(s.tp, s.digits)}</strong></span>
            <span>lot <strong>{s.lot ?? '—'}</strong></span>
            {s.decision?.riskAmount !== undefined && (
              <span>risk <strong>{num(s.decision.riskAmount)}</strong></span>
            )}
            {s.tp !== null && s.tp !== undefined && (
              <span>
                R:R <strong>
                  {num(Math.abs(s.tp - s.entry) / Math.max(Math.abs(s.entry - s.sl), 1e-9), 2)}
                </strong>
              </span>
            )}
          </div>

          {s.reason && <p className="muted">{s.reason}</p>}

          {s.status === 'rejected' && s.decision?.denialReasons?.length > 0 && (
            <p className="scan-verdict blocked">blocked: {s.decision.denialReasons[0]}</p>
          )}

          <button className="link" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
            {expanded === s.id ? 'hide' : 'show'} risk gates
          </button>
          {expanded === s.id && (
            <>
              <Gates decision={s.decision} />
              {s.features && Object.keys(s.features).length > 0 && (
                <p className="muted">
                  {Object.entries(s.features).map(([k, v]) => `${k} ${num(v, 2)}`).join(' · ')}
                </p>
              )}
            </>
          )}

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
    </>
  );
}
