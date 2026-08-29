import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

export default function Risk() {
  const [mode, setMode] = useState('demo');
  const [state, setState] = useState(null);
  const [settings, setSettings] = useState(null);
  const [scheduler, setScheduler] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setState(await api.riskState(mode));
    setSettings(await api.riskSettings());
    setScheduler(await api.scheduler());
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

  const killed = state?.kill_switch === 1;

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Risk</h3>
        <span>{scheduler?.running ? 'scheduler running' : 'scheduler stopped'}</span>
      </div>

      <div className="toolbar">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="demo">demo</option>
          <option value="live">live</option>
        </select>
      </div>

      {error && <p className="error">{error}</p>}

      <div className={killed ? 'verdict fail' : 'verdict pass'}>
        <strong>{killed ? 'TRADING HALTED' : 'TRADING ENABLED'}</strong>
        <span>{killed ? state.kill_switch_reason : `no halt on ${mode}`}</span>
        <div>
          <button
            disabled={busy}
            onClick={() => act(() => api.killSwitch(mode, !killed, 'toggled from the dashboard'))}
          >
            {killed ? 'Reset kill switch' : 'Halt trading'}
          </button>
        </div>
      </div>

      {state && (
        <table className="table">
          <tbody>
            <tr><td>Trading day (UTC)</td><td>{String(state.trading_day).slice(0, 10)}</td></tr>
            <tr><td>Realized P&amp;L</td><td className={Number(state.realized_pnl) >= 0 ? 'up' : 'down'}>{state.realized_pnl}</td></tr>
            <tr><td>Trades today</td><td>{state.trades_count}</td></tr>
            <tr><td>Consecutive losses</td><td>{state.consecutive_losses}</td></tr>
          </tbody>
        </table>
      )}

      <h4>Risk settings</h4>
      {settings && (
        <div className="toolbar">
          {[
            ['riskPctPerTrade', 'risk % / trade', 0.1],
            ['dailyLossCapPct', 'daily loss cap %', 0.5],
            ['maxConcurrentPositions', 'max positions', 1],
            ['consecutiveLossLimit', 'loss streak limit', 1],
            ['newsBlackoutMinutes', 'news blackout min', 1]
          ].map(([key, label, step]) => (
            <label className="field" key={key}>
              {label}
              <input
                type="number"
                step={step}
                value={settings[key]}
                onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })}
              />
            </label>
          ))}
          <button disabled={busy} onClick={() => act(() => api.saveRiskSettings(settings))}>
            Save
          </button>
        </div>
      )}

      <p className="muted">
        The kill switch trips automatically on the loss streak limit and only ever resets by hand.
        A stop loss is required on every order and is not configurable.
      </p>
    </section>
  );
}
