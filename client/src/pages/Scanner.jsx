import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';

/**
 * The live scanner.
 *
 * The sweep runs in the background on the server, so this screen polls a
 * snapshot rather than waiting on a request. That is what lets it show
 * progress while a scan is in flight instead of blanking out and looking
 * broken for however long the sweep takes.
 */

const POLL_MS = 1500;

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
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function Stat({ label, value, sub, tone = '' }) {
  return (
    <div className={`scan-stat ${tone}`}>
      <span className="scan-stat-label">{label}</span>
      <strong className="scan-stat-value">{value}</strong>
      {sub && <span className="scan-stat-sub">{sub}</span>}
    </div>
  );
}

/**
 * The score bar.
 *
 * Rendered with its components on hover because a bare number invites being
 * trusted. The score ranks candidates within one scan; it is not a
 * probability, and it never overrides a risk gate.
 */
function Score({ value, components }) {
  const tone = value >= 70 ? 'high' : value >= 45 ? 'mid' : 'low';
  const title = (components || [])
    .map((c) => `${c.name}: ${Math.round(c.weight * c.ratio)}/${c.weight}`)
    .join('\n');

  return (
    <div className={`score ${tone}`} title={title || 'no breakdown available'}>
      <span className="score-value">{value}</span>
      <span className="score-track"><span className="score-fill" style={{ width: `${value}%` }} /></span>
    </div>
  );
}

function Checks({ title, checks }) {
  if (!checks?.length) return null;
  return (
    <>
      <div className="gate-title">{title}</div>
      <ul className="gates">
        {checks.map((c) => (
          <li key={c.name} className={c.passed ? 'gate pass' : 'gate fail'}>
            <span className="gate-name">{c.name.replace(/_/g, ' ')}</span>
            <span className="gate-detail">{c.detail}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function Scanner() {
  const [snap, setSnap] = useState(null);
  const [symbols, setSymbols] = useState([]);
  const [markets, setMarkets] = useState([]);
  const [filter, setFilter] = useState('tradeable');
  const [sortBy, setSortBy] = useState('score');
  const [timeframeFilter, setTimeframeFilter] = useState('');
  const [strategyFilter, setStrategyFilter] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setSnap(await api.scannerLive());
    setMarkets(await api.marketStatus());
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.symbols().then(setSymbols).catch(() => {});
    const timer = setInterval(() => load().catch(() => {}), POLL_MS);
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

  const last = snap?.last || null;
  const all = useMemo(
    () => [...(last?.opportunities || []), ...(last?.blocked || [])],
    [last]
  );

  const timeframes = useMemo(() => [...new Set(all.map((o) => o.timeframe))].sort(), [all]);
  const strategies = useMemo(() => [...new Set(all.map((o) => o.strategy))].sort(), [all]);

  const rows = useMemo(() => {
    let list = filter === 'tradeable' ? (last?.opportunities || [])
      : filter === 'blocked' ? (last?.blocked || [])
        : all;

    if (timeframeFilter) list = list.filter((o) => o.timeframe === timeframeFilter);
    if (strategyFilter) list = list.filter((o) => o.strategy === strategyFilter);

    const sorters = {
      score: (a, b) => b.score - a.score,
      risk: (a, b) => (a.riskAmount ?? 0) - (b.riskAmount ?? 0),
      symbol: (a, b) => a.symbol.localeCompare(b.symbol),
      timeframe: (a, b) => a.timeframe.localeCompare(b.timeframe)
    };
    return [...list].sort(sorters[sortBy] || sorters.score);
  }, [last, all, filter, timeframeFilter, strategyFilter, sortBy]);

  const progress = snap?.progress;
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const watchable = symbols.filter((s) => !s.watched && !s.enabled).slice(0, 400);

  return (
    <section className="scanner-page">
      <div className="scan-topbar">
        <div>
          <h3>Scanner</h3>
          <span className="muted">
            {snap?.scanning
              ? `scanning ${progress.symbol || ''} ${progress.timeframe || ''}`
              : last ? `last scan ${ago(last.at)} · ${last.durationMs}ms` : 'no scan yet'}
          </span>
        </div>
        <div className="scan-topbar-right">
          <span className={snap?.scanning ? 'live-pill on' : 'live-pill'}>
            {snap?.scanning ? 'SCANNING' : 'IDLE'}
          </span>
          <button disabled={busy || snap?.scanning} onClick={() => act(() => api.startScan())}>
            {snap?.scanning ? 'Scanning…' : 'Start scan'}
          </button>
        </div>
      </div>

      {snap?.scanning && (
        <div className="scan-progress">
          <div className="scan-progress-bar"><span style={{ width: `${pct}%` }} /></div>
          <span className="muted">{progress.done} of {progress.total} symbol-timeframes</span>
        </div>
      )}

      <div className="scan-stats">
        <Stat
          label="Markets open"
          value={markets.length ? `${markets.filter((m) => m.open).length}/${markets.length}` : '—'}
          sub="by the broker's own calendar"
          tone={markets.length && markets.some((m) => m.open) ? 'green' : 'orange'}
        />
        <Stat
          label="Tradeable now"
          value={last ? last.opportunities.length : '—'}
          sub="pass every risk gate"
          tone="green"
        />
        <Stat
          label="Blocked setups"
          value={last ? last.blocked.length : '—'}
          sub="firing but refused"
          tone="orange"
        />
        <Stat
          label="Combinations"
          value={last ? last.combinations : '—'}
          sub={last ? `${last.symbolsScanned} symbols × ${last.timeframes.length} TF × ${last.strategiesRun} strategies` : ''}
        />
        <Stat
          label="Scan time"
          value={last ? `${(last.durationMs / 1000).toFixed(2)}s` : '—'}
          sub={last ? `alerts sent ${last.alerted}` : ''}
        />
        <Stat
          label="Traded timeframe"
          value={last?.tradedTimeframe || '—'}
          sub="the only one the scheduler acts on"
          tone="blue"
        />
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="scan-verdict go">{notice}</p>}

      <div className="scan-layout">
        <div className="scan-main">
          <div className="panel">
            <div className="panel-header">
              <h3>Opportunities</h3>
              <span>{rows.length} shown</span>
            </div>

            <div className="toolbar">
              <div className="tf-group">
                {[['tradeable', 'Tradeable'], ['blocked', 'Blocked'], ['all', 'All']].map(([key, label]) => (
                  <button
                    key={key}
                    className={filter === key ? 'tf active' : 'tf'}
                    onClick={() => setFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <select value={timeframeFilter} onChange={(e) => setTimeframeFilter(e.target.value)}>
                <option value="">all timeframes</option>
                {timeframes.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
              </select>

              <select value={strategyFilter} onChange={(e) => setStrategyFilter(e.target.value)}>
                <option value="">all strategies</option>
                {strategies.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>

              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="score">sort by score</option>
                <option value="risk">sort by risk</option>
                <option value="symbol">sort by symbol</option>
                <option value="timeframe">sort by timeframe</option>
              </select>

              <select
                defaultValue=""
                disabled={busy}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  e.target.value = '';
                  if (id) act(async () => {
                    await api.setSymbolWatched(id, true);
                    setSymbols(await api.symbols());
                  });
                }}
              >
                <option value="">add a symbol to watch…</option>
                {watchable.map((s) => <option key={s.id} value={s.id}>{s.broker_symbol}</option>)}
              </select>
            </div>

            {!last && <p className="empty">No scan has finished yet. Press Start scan.</p>}
            {last && rows.length === 0 && (
              <p className="empty">
                Nothing matches this filter. {filter === 'tradeable' && last.blocked.length > 0
                  && `${last.blocked.length} setups are firing but blocked — switch to Blocked to see why.`}
              </p>
            )}

            {rows.length > 0 && (
              <table className="table scan-table">
                <thead>
                  <tr>
                    <th>#</th><th>Symbol</th><th>Side</th><th>TF</th><th>Strategy</th>
                    <th>Score</th><th>Price</th><th>Entry / Stop</th><th>Lot</th><th>Risk</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o, i) => {
                    const key = `${o.symbolId}-${o.strategy}-${o.timeframe}`;
                    return (
                      <Fragment key={key}>
                        <tr className={o.wouldTrade ? 'row-go' : 'row-blocked'}>
                          <td className="muted">{i + 1}</td>
                          <td><strong>{o.symbol}</strong></td>
                          <td><span className={`badge ${o.side === 'BUY' ? 'buy' : 'sell'}`}>{o.side}</span></td>
                          <td>{o.timeframe}</td>
                          <td>
                            {o.strategy}
                            {o.evidence?.passed && <span className="evidence-tag" title="passed a walk-forward backtest on this exact combination">tested</span>}
                          </td>
                          <td><Score value={o.score} components={o.scoreComponents} /></td>
                          <td>{price(o.price, o.digits)}</td>
                          <td className="muted">
                            {price(o.levels?.entry, o.digits)} / {price(o.levels?.sl, o.digits)}
                          </td>
                          <td>{o.lot ?? '—'}</td>
                          <td>{num(o.riskAmount)}</td>
                          <td className="align-right">
                            {o.wouldTrade ? (
                              <button
                                className="trade-now"
                                disabled={busy}
                                onClick={() => act(async () => {
                                  const r = await api.tradeSetup(o.symbolId, o.strategy, o.timeframe);
                                  setNotice(`filled ${o.side} ${o.symbol} — ticket ${r.ticket}`);
                                })}
                              >
                                Trade
                              </button>
                            ) : (
                              <span className="blocked-tag" title={o.blockedBy || ''}>blocked</span>
                            )}
                            <button className="link" onClick={() => setExpanded(expanded === key ? null : key)}>
                              {expanded === key ? 'hide' : 'why'}
                            </button>
                          </td>
                        </tr>
                        {expanded === key && (
                          <tr>
                            <td colSpan={11}>
                              <div className="scan-detail">
                                <p className="scan-reason">{o.reason}</p>
                                {o.blockedBy && <p className="scan-verdict blocked">blocked: {o.blockedBy}</p>}
                                {o.timeframe !== last.tradedTimeframe && o.wouldTrade && (
                                  <p className="scan-verdict blocked">
                                    the scheduler only trades {last.tradedTimeframe}, so this{' '}
                                    {o.timeframe} setup will not be taken automatically
                                  </p>
                                )}
                                <Checks title="Strategy conditions" checks={o.checks} />
                                <Checks title="Risk gates" checks={o.gates} />
                                <div className="gate-title">Score breakdown</div>
                                <ul className="gates">
                                  {(o.scoreComponents || []).map((c) => (
                                    <li key={c.name} className="gate">
                                      <span className="gate-name">{c.name}</span>
                                      <span className="gate-detail">
                                        {Math.round(c.weight * c.ratio)} of {c.weight}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                <p className="muted">
                                  bar {o.barTime} ·{' '}
                                  {Object.entries(o.features || {})
                                    .map(([k, v]) => `${k} ${num(v, 2)}`)
                                    .join(' · ')}
                                </p>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {last?.missingData?.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <h3>No data</h3>
                <span>{last.missingData.length} symbol-timeframes could not be evaluated</span>
              </div>
              <p className="muted">
                These have no stored candles, so nothing was scanned for them. Backfill them from
                Markets, or run a backtest — that fills the history as a side effect.
              </p>
              <ul className="gates">
                {last.missingData.slice(0, 25).map((m) => (
                  <li key={`${m.symbol}-${m.timeframe}`} className="gate fail">
                    <span className="gate-name">{m.symbol} {m.timeframe}</span>
                    <span className="gate-detail">{m.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside className="scan-side">
          <div className="panel">
            <div className="panel-header">
              <h3>Market hours</h3>
              <button className="link" disabled={busy} onClick={() => act(() => api.refreshMarketStatus())}>
                re-sync
              </button>
            </div>
            {markets.length === 0 && <p className="empty">No watched symbols.</p>}
            <ul className="gates">
              {markets.map((m) => (
                <li key={m.symbolId} className={m.open ? 'gate pass' : 'gate fail'}>
                  <span className="gate-name">{m.symbol}</span>
                  <span className="gate-detail">{m.open ? 'open' : m.reason}</span>
                </li>
              ))}
            </ul>
            <p className="muted">
              A shut market is refused before an order is ever built. The calendar comes from the
              broker, not from a hardcoded weekend rule — BTCUSD trades straight through Saturday
              and several instruments close early on Friday.
            </p>
          </div>

          <div className="panel">
            <div className="panel-header"><h3>Activity feed</h3></div>
            {(!snap?.feed || snap.feed.length === 0) && <p className="empty">Nothing yet.</p>}
            <ul className="feed">
              {(snap?.feed || []).map((f, i) => (
                <li key={`${f.at}-${i}`} className={`feed-item ${f.kind}`}>
                  <span className="feed-dot" />
                  <div>
                    <p>{f.text}</p>
                    <small className="muted">{ago(f.at)}</small>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel">
            <div className="panel-header"><h3>How to read this</h3></div>
            <p className="muted">
              <strong>Score</strong> ranks candidates inside one scan. It is a weighted sum of the
              strategy&apos;s own conditions, the risk gates, the reward-to-risk on the levels, and
              whether this exact strategy/symbol/timeframe has ever passed a walk-forward backtest.
              Hover it for the breakdown. It is not a probability, and a high score never overrides
              a risk gate.
            </p>
            <p className="muted">
              <strong>Tradeable</strong> means every gate passed <em>and</em> the symbol is enabled.
              Watching a symbol shows it here; it does not make it tradeable.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
