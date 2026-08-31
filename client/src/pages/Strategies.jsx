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
const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

/**
 * Which symbols and timeframes a strategy may run on.
 *
 * Selecting nothing means "runs everywhere", which is the default and is a
 * different statement from "runs nowhere". Saying so on screen matters: an
 * empty grid that silently disabled a strategy would look identical to one
 * that was working.
 */
function ScopeGrid({ strategy, symbols, busy, onSave }) {
  const [picked, setPicked] = useState(() => new Set(
    (strategy.scopes || []).map((sc) => `${sc.symbolId ?? 'any'}|${sc.timeframe ?? 'any'}`)
  ));
  const [dirty, setDirty] = useState(false);

  const tradeable = symbols.filter((s) => s.enabled || s.watched);

  function toggle(symbolId, timeframe) {
    const key = `${symbolId ?? 'any'}|${timeframe ?? 'any'}`;
    const next = new Set(picked);
    if (next.has(key)) next.delete(key); else next.add(key);
    setPicked(next);
    setDirty(true);
  }

  function save() {
    const scopes = [...picked].map((key) => {
      const [symbolPart, timeframePart] = key.split('|');
      return {
        symbolId: symbolPart === 'any' ? null : Number(symbolPart),
        timeframe: timeframePart === 'any' ? null : timeframePart
      };
    });
    onSave(scopes);
    setDirty(false);
  }

  return (
    <>
      <h4>Where this strategy may run</h4>
      <p className="muted">
        {picked.size === 0
          ? 'Nothing selected, so it runs on every enabled symbol and every traded timeframe. That is the default — it is not switched off.'
          : `${picked.size} combination${picked.size === 1 ? '' : 's'} selected. It runs only on these.`}
      </p>

      <table className="table scope-grid">
        <thead>
          <tr>
            <th>Symbol</th>
            {TIMEFRAMES.map((tf) => <th key={tf}>{tf}</th>)}
            <th>any TF</th>
          </tr>
        </thead>
        <tbody>
          {tradeable.map((sym) => (
            <tr key={sym.id}>
              <td>
                <strong>{sym.broker_symbol}</strong>
                {!sym.enabled && <small className="muted"> watch only</small>}
              </td>
              {TIMEFRAMES.map((tf) => (
                <td key={tf}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={picked.has(`${sym.id}|${tf}`)}
                    onChange={() => toggle(sym.id, tf)}
                  />
                </td>
              ))}
              <td>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={picked.has(`${sym.id}|any`)}
                  onChange={() => toggle(sym.id, null)}
                />
              </td>
            </tr>
          ))}
          <tr>
            <td><em>any symbol</em></td>
            {TIMEFRAMES.map((tf) => (
              <td key={tf}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={picked.has(`any|${tf}`)}
                  onChange={() => toggle(null, tf)}
                />
              </td>
            ))}
            <td />
          </tr>
        </tbody>
      </table>

      <div className="toolbar">
        <button disabled={busy || !dirty} onClick={save}>
          {dirty ? 'Save scope' : 'Scope saved'}
        </button>
        {picked.size > 0 && (
          <button className="link" disabled={busy} onClick={() => { setPicked(new Set()); setDirty(true); }}>
            clear (run everywhere)
          </button>
        )}
      </div>
    </>
  );
}

function Breakdown({ title, keyField, rows }) {
  if (!rows || rows.length === 0) return <p className="empty">Nothing yet.</p>;
  return (
    <>
      <h4>{title}</h4>
      <table className="table">
        <thead>
          <tr>
            <th>{keyField === 'timeframe' ? 'TF' : 'Symbol'}</th>
            <th>Signals</th><th>Rejected</th><th>Closed</th><th>Wins</th><th>Losses</th>
            <th>Win rate</th><th>Expectancy</th><th>Net P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[keyField]}>
              <td><strong>{r[keyField]}</strong></td>
              <td>{r.signals}</td>
              <td className="muted">{r.rejected}</td>
              <td>{r.tradesClosed}</td>
              <td className="up">{r.wins}</td>
              <td className="down">{r.losses}</td>
              <td>{r.winRatePct === null ? '—' : `${r.winRatePct}%`}</td>
              <td className={(r.expectancy ?? 0) >= 0 ? 'up' : 'down'}>{num(r.expectancy)}</td>
              <td className={r.pnl >= 0 ? 'up' : 'down'}>{num(r.pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function num(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(digits);
}

export default function Strategies() {
  const [mode, setMode] = useState('demo');
  const [data, setData] = useState(null);
  const [symbols, setSymbols] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setData(await api.strategyAnalytics(mode));
  }, [mode]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.symbols().then(setSymbols).catch(() => {});
  }, [load]);

  async function saveScopes(id, scopes) {
    setBusy(true);
    setError(null);
    try {
      await api.saveStrategyScopes(id, scopes);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

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

      <div className="panel">
        <div className="panel-header">
          <h3>Which timeframe is working</h3>
          <span>every strategy pooled, ranked by expectancy per trade</span>
        </div>
        {data.byTimeframe.length === 0 ? (
          <p className="empty">
            No signals on any timeframe yet. Pick more than one traded timeframe in Settings and
            this fills in as they trade.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>TF</th><th>Signals</th><th>Rejected</th><th>Closed</th>
                <th>Wins</th><th>Losses</th><th>Win rate</th><th>Expectancy</th><th>Net P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {data.byTimeframe.map((t) => (
                <tr key={t.timeframe}>
                  <td><strong>{t.timeframe}</strong></td>
                  <td>{t.signals}</td>
                  <td className="muted">{t.rejected}</td>
                  <td>{t.tradesClosed}</td>
                  <td className="up">{t.wins}</td>
                  <td className="down">{t.losses}</td>
                  <td>{t.winRatePct === null ? '—' : `${t.winRatePct}%`}</td>
                  <td className={(t.expectancy ?? 0) >= 0 ? 'up' : 'down'}>{num(t.expectancy)}</td>
                  <td className={t.pnl >= 0 ? 'up' : 'down'}>{num(t.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Ranked by <strong>expectancy per trade</strong>, not total P&amp;L. Total rewards
          whichever timeframe simply traded most, which is not the same as the one that traded
          best — and expectancy is what actually compounds.
        </p>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>Which symbol is working</h3>
          <span>every strategy pooled, ranked by expectancy per trade</span>
        </div>
        <Breakdown title="" keyField="symbol" rows={data.bySymbol} />
      </div>

      <p className="muted">
        <strong>Enabled</strong> is what the signal generator reads. <strong>Status</strong> is the
        promotion ladder the risk engine gates on — enabling a <code>draft</code> strategy produces
        signals the risk engine then refuses, which is the safe failure you want to see before
        promoting anything.
      </p>

      {/* Scalps have their own screen: they hold for minutes and take many more
          trades, so pooling them here would drown these numbers in theirs. */}
      {[...data.strategies].filter((s) => s.kind !== 'scalp').sort((a, b) => a.rank - b.rank).map((s) => (
        <div key={s.id} className="panel">
          <div className="panel-header">
            <h3>
              <span className="rank">#{s.rank}</span>
              {s.name} <small className="muted">v{s.version}</small>
              {s.backtests.passed > 0 && <span className="evidence-tag">{s.backtests.passed} passed</span>}
            </h3>
            <span>
              {s.totals.tradesClosed} closed · {s.totals.tradesOpen} open ·{' '}
              <span className={s.totals.pnl >= 0 ? 'up' : 'down'}>{num(s.totals.pnl)}</span>
            </span>
          </div>

          <div className="cycle-grid">
            <span>
              <strong className={(s.totals.expectancy ?? 0) >= 0 ? 'up' : 'down'}>
                {num(s.totals.expectancy)}
              </strong>
              <small>expectancy / trade</small>
            </span>
            <span>
              <strong>{s.totals.winRatePct === null ? '—' : `${s.totals.winRatePct}%`}</strong>
              <small>win rate</small>
            </span>
            <span><strong>{s.totals.signals}</strong><small>signals</small></span>
            <span><strong>{s.totals.rejected}</strong><small>rejected by risk</small></span>
            <span>
              <strong className="down">{s.totals.refusedButWorked}</strong>
              <small>refusals that worked</small>
            </span>
            <span>
              <strong className="up">{s.totals.refusedRightly}</strong>
              <small>refusals that saved us</small>
            </span>
            <span>
              <strong>{s.bestTimeframe ? s.bestTimeframe.timeframe : '—'}</strong>
              <small>best timeframe</small>
            </span>
            <span>
              <strong>{s.bestSymbol ? s.bestSymbol.symbol : '—'}</strong>
              <small>best symbol</small>
            </span>
            <span>
              <strong>{(s.scopes || []).length === 0 ? 'all' : s.scopes.length}</strong>
              <small>scoped combinations</small>
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
                      <th>Wins</th><th>Losses</th><th>Win rate</th><th>PF</th>
                      <th>Expectancy</th><th>Best</th><th>Worst</th><th>Net P&amp;L</th>
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
                        <td>{num(t.profitFactor)}</td>
                        <td className={(t.expectancy ?? 0) >= 0 ? 'up' : 'down'}>{num(t.expectancy)}</td>
                        <td className="up">{num(t.bestTrade)}</td>
                        <td className="down">{num(t.worstTrade)}</td>
                        <td className={t.pnl >= 0 ? 'up' : 'down'}>{num(t.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <Breakdown title="Live results by symbol" keyField="symbol" rows={s.bySymbol} />

              <ScopeGrid
                key={`${s.id}-${(s.scopes || []).length}`}
                strategy={s}
                symbols={symbols}
                busy={busy}
                onSave={(scopes) => saveScopes(s.id, scopes)}
              />

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
