import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * What each strategy is allowed to do, and what it has actually done.
 *
 * Backtest verdicts and live results sit side by side and are never merged. A
 * strategy can pass every backtest and have taken no trade at all, so the live
 * columns are counted from the trades table rather than inferred from a
 * verdict.
 */

const STATUSES = ['draft', 'backtested', 'demo', 'live'];

function num(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(digits);
}

export default function Strategies() {
  const [mode, setMode] = useState('demo');
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setData(await api.strategyAnalytics(mode));
  }, [mode]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  async function patch(id, body) {
    setBusy(true);
    setError(null);
    try {
      await api.patchStrategy(id, body);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <section className="panel"><p className="error">{error}</p></section>;
  if (!data) return <section className="panel"><p className="muted">Loading…</p></section>;

  return (
    <>
      <div className="toolbar">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="demo">demo</option>
          <option value="live">live</option>
        </select>
      </div>

      {error && <p className="error">{error}</p>}

      <p className="muted">
        <strong>Enabled</strong> is what the signal generator reads. <strong>Status</strong> is the
        promotion ladder the risk engine gates on — enabling a <code>draft</code> strategy produces
        signals the risk engine then refuses, which is the safe failure you want to see before
        promoting anything.
      </p>

      {data.strategies.map((s) => (
        <div key={s.id} className="panel">
          <div className="panel-header">
            <h3>
              {s.name} <small className="muted">v{s.version}</small>
              {s.backtests.passed > 0 && <span className="evidence-tag">{s.backtests.passed} passed</span>}
            </h3>
            <span>
              {s.totals.tradesClosed} closed · {s.totals.tradesOpen} open ·{' '}
              <span className={s.totals.pnl >= 0 ? 'up' : 'down'}>{num(s.totals.pnl)}</span>
            </span>
          </div>

          <div className="toolbar">
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={s.enabled}
                disabled={busy}
                onChange={(e) => patch(s.id, { enabled: e.target.checked })}
              />
              <span><strong>Enabled</strong></span>
            </label>

            <select
              value={s.status}
              disabled={busy}
              onChange={(e) => patch(s.id, { status: e.target.value })}
            >
              {STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
            </select>

            <span className="muted">
              {s.backtests.runs} backtest run{s.backtests.runs === 1 ? '' : 's'},{' '}
              {s.backtests.passed} passed out-of-sample
              {s.backtests.best && (
                <> · best {s.backtests.best.symbol} {s.backtests.best.timeframe} PF{' '}
                  {num(s.backtests.best.profitFactor)}</>
              )}
            </span>

            <button className="link" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
              {expanded === s.id ? 'hide' : 'show'} breakdown
            </button>
          </div>

          {s.totals.signals === 0 && (
            <p className="muted">
              No signals generated yet, so there is nothing live to measure. That is expected for a
              strategy that is disabled, or one whose symbol has no stored candles.
            </p>
          )}

          {expanded === s.id && (
            <>
              <h4>Live results by timeframe</h4>
              {s.byTimeframe.length === 0 ? <p className="empty">Nothing yet.</p> : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>TF</th><th>Signals</th><th>Rejected</th><th>Opened</th><th>Closed</th>
                      <th>Wins</th><th>Losses</th><th>Win rate</th><th>Avg P&amp;L</th><th>Net P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byTimeframe.map((t) => (
                      <tr key={t.timeframe}>
                        <td>{t.timeframe}</td>
                        <td>{t.signals}</td>
                        <td className="muted">{t.rejected}</td>
                        <td>{t.tradesOpened}</td>
                        <td>{t.tradesClosed}</td>
                        <td className="up">{t.wins}</td>
                        <td className="down">{t.losses}</td>
                        <td>{t.winRatePct === null ? '—' : `${t.winRatePct}%`}</td>
                        <td>{num(t.avgPnl)}</td>
                        <td className={t.pnl >= 0 ? 'up' : 'down'}>{num(t.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h4>Backtest verdicts</h4>
              {data.matrix.filter((m) => m.strategy === s.name).length === 0
                ? <p className="empty">Never backtested. Run a sweep from the Backtests screen.</p> : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Symbol</th><th>TF</th><th>Trades</th><th>PF</th><th>Net</th>
                      <th>Win rate</th><th>Max DD</th><th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.matrix.filter((m) => m.strategy === s.name).map((m) => (
                      <tr key={m.runId}>
                        <td>{m.symbol}</td>
                        <td>{m.timeframe}</td>
                        <td>{m.trades ?? '—'}</td>
                        <td>{num(m.profitFactor)}</td>
                        <td className={(m.netProfit ?? 0) >= 0 ? 'up' : 'down'}>{num(m.netProfit)}</td>
                        <td>{num(m.winRatePct, 1)}%</td>
                        <td>{num(m.maxDrawdownPct, 1)}%</td>
                        <td className={m.passed ? 'up' : 'down'} title={(m.failures || []).join('; ')}>
                          {m.passed ? 'PASS' : 'fail'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      ))}
    </>
  );
}
