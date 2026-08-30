import { useCallback, useEffect, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend
} from 'recharts';
import { api } from '../api';

const AXIS = '#9aa7bc';
const GRID = '#2d3748';

function num(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(digits);
}

function Panel({ title, subtitle, children }) {
  return (
    <div className="panel">
      <div className="panel-header"><h3>{title}</h3>{subtitle && <span>{subtitle}</span>}</div>
      {children}
    </div>
  );
}

export default function Performance() {
  const [mode, setMode] = useState('demo');
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setData(await api.performance(mode, days));
  }, [mode, days]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => load().catch(() => {}), 10000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) return <section className="panel"><p className="error">{error}</p></section>;
  if (!data) return <section className="panel"><p className="muted">Loading…</p></section>;

  const daily = data.daily.map((d) => ({ ...d, label: d.day.slice(5) }));
  const totals = daily.reduce((a, d) => ({
    trades: a.trades + d.trades,
    wins: a.wins + d.wins,
    pnl: a.pnl + d.pnl,
    signals: a.signals + d.signalsCreated
  }), { trades: 0, wins: 0, pnl: 0, signals: 0 });

  const activeDays = daily.filter((d) => d.trades > 0).length;
  const passed = data.backtests.filter((b) => b.passed);

  return (
    <>
      <div className="toolbar">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="demo">demo</option>
          <option value="live">live</option>
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30, 90].map((d) => <option key={d} value={d}>last {d} days</option>)}
        </select>
      </div>

      <section className="stats-grid">
        <div className="stat-card blue"><span>Closed trades</span><strong>{totals.trades}</strong></div>
        <div className={`stat-card ${totals.pnl >= 0 ? 'green' : 'orange'}`}>
          <span>Net P&amp;L</span><strong>{num(totals.pnl)}</strong>
        </div>
        <div className="stat-card purple">
          <span>Win rate</span>
          <strong>{totals.trades ? num((totals.wins / totals.trades) * 100, 1) + '%' : '—'}</strong>
        </div>
        <div className="stat-card orange"><span>Signals</span><strong>{totals.signals}</strong></div>
      </section>

      {totals.trades === 0 && (
        <p className="muted">
          No closed trades in this window. The validated strategy took <strong>54 trades in
          eight months</strong> of backtest — about one every four days — so quiet stretches are
          the expected shape, not a fault. The activity chart below shows the system is running.
        </p>
      )}

      <Panel title="Cumulative P&L" subtitle={`${activeDays} of ${daily.length} days had a trade`}>
        {daily.length === 0 ? <p className="empty">No data yet.</p> : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
              <XAxis dataKey="label" stroke={AXIS} />
              <YAxis stroke={AXIS} />
              <Tooltip contentStyle={{ background: '#0f1724', border: `1px solid ${GRID}` }} />
              {/* Zero is the line that matters: above it the run is profitable. */}
              <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="cumulativePnl" name="cumulative P&L"
                stroke="#67e8f9" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <Panel title="Daily P&L" subtitle="closed trades only">
        {daily.length === 0 ? <p className="empty">No data yet.</p> : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
              <XAxis dataKey="label" stroke={AXIS} />
              <YAxis stroke={AXIS} />
              <Tooltip contentStyle={{ background: '#0f1724', border: `1px solid ${GRID}` }} />
              <ReferenceLine y={0} stroke="#64748b" />
              <Bar dataKey="pnl" name="P&L" fill="#67e8f9" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <Panel title="Activity" subtitle="signals generated against trades opened">
        {daily.length === 0 ? <p className="empty">No data yet.</p> : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
              <XAxis dataKey="label" stroke={AXIS} />
              <YAxis stroke={AXIS} allowDecimals={false} />
              <Tooltip contentStyle={{ background: '#0f1724', border: `1px solid ${GRID}` }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="signalsCreated" name="signals" fill="#818cf8" />
              <Bar dataKey="signalsRejected" name="rejected" fill="#f87171" />
              <Bar dataKey="opened" name="trades opened" fill="#4ade80" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <Panel title="Equity" subtitle="from the broker, sampled every minute">
        {daily.filter((d) => d.equityClose !== null).length === 0
          ? <p className="empty">No equity snapshots yet.</p> : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={daily.filter((d) => d.equityClose !== null)}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
              <XAxis dataKey="label" stroke={AXIS} />
              <YAxis stroke={AXIS} domain={['auto', 'auto']} />
              <Tooltip contentStyle={{ background: '#0f1724', border: `1px solid ${GRID}` }} />
              <Line type="monotone" dataKey="equityClose" name="equity"
                stroke="#4ade80" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <Panel title="By strategy" subtitle="live results, not backtest">
        <table className="table">
          <thead><tr><th>Strategy</th><th>Status</th><th>Trades</th><th>Wins</th><th>P&amp;L</th></tr></thead>
          <tbody>
            {data.byStrategy.map((s) => (
              <tr key={s.strategy}>
                <td>{s.strategy}</td>
                <td>{s.status}</td>
                <td>{s.trades}</td>
                <td>{s.wins}</td>
                <td className={s.pnl >= 0 ? 'up' : 'down'}>{num(s.pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="By symbol">
        <table className="table">
          <thead><tr><th>Symbol</th><th>Tradeable</th><th>Trades</th><th>Wins</th><th>P&amp;L</th></tr></thead>
          <tbody>
            {data.bySymbol.map((s) => (
              <tr key={s.symbol}>
                <td>{s.symbol}</td>
                <td>{s.enabled ? 'yes' : 'watch only'}</td>
                <td>{s.trades}</td>
                <td>{s.wins}</td>
                <td className={s.pnl >= 0 ? 'up' : 'down'}>{num(s.pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Backtest verdicts" subtitle={`${passed.length} of ${data.backtests.length} runs passed out-of-sample`}>
        <table className="table">
          <thead><tr><th>Strategy</th><th>Symbol</th><th>TF</th><th>PF</th><th>Trades</th><th>Verdict</th></tr></thead>
          <tbody>
            {[...data.backtests]
              .sort((a, b) => (b.passed - a.passed) || ((b.profitFactor ?? 0) - (a.profitFactor ?? 0)))
              .slice(0, 15)
              .map((b, i) => (
                <tr key={`${b.strategy}-${b.symbol}-${b.timeframe}-${i}`}>
                  <td>{b.strategy}</td>
                  <td>{b.symbol}</td>
                  <td>{b.timeframe}</td>
                  <td>{b.profitFactor === null ? '—' : num(b.profitFactor)}</td>
                  <td>{b.trades ?? '—'}</td>
                  <td className={b.passed ? 'up' : 'down'}>{b.passed ? 'PASS' : 'fail'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
