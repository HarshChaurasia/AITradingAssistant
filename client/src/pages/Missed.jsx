import { useCallback, useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';
import { api } from '../api';

/**
 * The trades we refused, graded against what the market did next.
 *
 * The point is not to regret them. It is to find the rejection reasons that
 * keep costing money: a gate that refuses ten setups and saves nine is doing
 * its job, one that refuses ten and saves two has a threshold worth arguing
 * with.
 */

const AXIS = '#9aa7bc';
const GRID = '#2d3748';

function num(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(digits);
}

const VERDICTS = {
  correct: { label: 'refusal was right', tone: 'up' },
  costly: { label: 'refusal cost us', tone: 'down' },
  undecided: { label: 'not yet decided', tone: 'muted' }
};

export default function Missed() {
  const [mode, setMode] = useState('demo');
  const [verdict, setVerdict] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setData(await api.missed(mode, verdict));
  }, [mode, verdict]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  async function regrade() {
    setBusy(true);
    setError(null);
    try {
      await api.evaluateMissed();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <section className="panel"><p className="error">{error}</p></section>;
  if (!data) return <section className="panel"><p className="muted">Loading…</p></section>;

  const { summary, rows } = data;
  const chart = summary.byReason.map((r) => ({
    ...r,
    label: r.reason.length > 28 ? `${r.reason.slice(0, 26)}…` : r.reason
  }));

  return (
    <>
      <div className="toolbar">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="demo">demo</option>
          <option value="live">live</option>
        </select>
        <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
          <option value="">every verdict</option>
          <option value="costly">refusal cost us</option>
          <option value="correct">refusal was right</option>
          <option value="undecided">not yet decided</option>
        </select>
        <button disabled={busy} onClick={regrade}>
          {busy ? 'Grading…' : 'Re-grade against latest candles'}
        </button>
      </div>

      <section className="stats-grid">
        <div className="stat-card blue">
          <span>Refused signals</span><strong>{summary.total}</strong>
        </div>
        <div className="stat-card green">
          <span>Refusal was right</span><strong>{summary.correct}</strong>
        </div>
        <div className="stat-card orange">
          <span>Refusal cost us</span><strong>{summary.costly}</strong>
        </div>
        <div className="stat-card purple">
          <span>Accuracy</span>
          <strong>{summary.accuracyPct === null ? '—' : `${summary.accuracyPct}%`}</strong>
        </div>
      </section>

      <p className="muted">
        A setup is graded by replaying the candles that arrived after its bar. If a bar spans both
        the stop and the target, the stop wins — the same pessimistic rule the backtest uses,
        because assuming the good fill would turn every volatile bar into a fictional winner.
        {summary.undecided > 0 && (
          <> <strong>{summary.undecided}</strong> are still undecided: not enough bars have closed
          since, or price never reached either level.</>
        )}
      </p>

      <div className="panel">
        <div className="panel-header">
          <h3>Net R by rejection reason</h3>
          <span>below zero means refusing for this reason has cost money</span>
        </div>
        {chart.length === 0 ? <p className="empty">Nothing graded yet.</p> : (
          <ResponsiveContainer width="100%" height={Math.max(180, chart.length * 44)}>
            <BarChart data={chart} layout="vertical" margin={{ left: 140 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
              <XAxis type="number" stroke={AXIS} />
              <YAxis type="category" dataKey="label" stroke={AXIS} width={140} />
              <Tooltip contentStyle={{ background: '#0f1724', border: `1px solid ${GRID}` }} />
              <ReferenceLine x={0} stroke="#64748b" />
              <Bar dataKey="netR" name="net R" fill="#f87171" />
            </BarChart>
          </ResponsiveContainer>
        )}

        <table className="table">
          <thead>
            <tr>
              <th>Rejection reason</th><th>Refused</th><th>Right</th><th>Cost us</th>
              <th>Undecided</th><th>Accuracy</th><th>Net R</th>
            </tr>
          </thead>
          <tbody>
            {summary.byReason.map((r) => (
              <tr key={r.reason}>
                <td>{r.reason}</td>
                <td>{r.total}</td>
                <td className="up">{r.correct}</td>
                <td className="down">{r.costly}</td>
                <td className="muted">{r.undecided}</td>
                <td>{r.accuracyPct === null ? '—' : `${r.accuracyPct}%`}</td>
                <td className={r.netR >= 0 ? 'up' : 'down'}>{num(r.netR)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>Every refused signal</h3>
          <span>{rows.length} shown</span>
        </div>

        {rows.length === 0 ? (
          <p className="empty">
            Nothing has been refused and graded yet. Rejections appear here once the scheduler has
            generated some and enough later candles exist to judge them.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Bar</th><th>Symbol</th><th>Side</th><th>TF</th><th>Strategy</th>
                <th>Blocked by</th><th>Outcome</th><th>R</th><th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.signalId}>
                  <td className="muted">{String(r.barTime).slice(0, 16).replace('T', ' ')}</td>
                  <td><strong>{r.symbol}</strong></td>
                  <td><span className={`badge ${r.side === 'BUY' ? 'buy' : 'sell'}`}>{r.side}</span></td>
                  <td>{r.timeframe}</td>
                  <td>{r.strategy}</td>
                  <td className="muted" title={r.blockedBy || ''}>{r.blockedBy}</td>
                  <td title={r.detail || ''}>{r.outcome}</td>
                  <td className={(r.rMultiple ?? 0) >= 0 ? 'up' : 'down'}>{num(r.rMultiple)}</td>
                  <td className={VERDICTS[r.verdict]?.tone}>{VERDICTS[r.verdict]?.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
