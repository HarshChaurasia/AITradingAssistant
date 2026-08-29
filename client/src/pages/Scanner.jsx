import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

const TIMEFRAMES = ['M15', 'M30', 'H1', 'H4', 'D1'];

function num(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(digits);
}

// Prices use the instrument's own precision. Rendering EURUSD at 2dp gives
// 1.16 for every price it will ever have.
function price(value, digits) {
  return num(value, Number.isInteger(digits) ? digits : 2);
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
  const [timeframe, setTimeframe] = useState('H4');
  const [scan, setScan] = useState(null);
  const [symbols, setSymbols] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [tradedTimeframe, setTradedTimeframe] = useState(null);

  const load = useCallback(async () => {
    const result = await api.scanner(timeframe);
    setScan(result);
    setTradedTimeframe(result.tradedTimeframe);
    setSymbols(await api.symbols());
  }, [timeframe]);

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

  const watchable = symbols.filter((s) => !s.watched && !s.enabled).slice(0, 400);

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Scanner</h3>
        <span>{scan ? `evaluated ${new Date(scan.at).toISOString().slice(11, 19)} UTC` : 'loading…'}</span>
      </div>

      <div className="toolbar">
        <div className="tf-group">
          {TIMEFRAMES.map((tf) => (
            <button key={tf} className={tf === timeframe ? 'tf active' : 'tf'} onClick={() => setTimeframe(tf)}>
              {tf}
            </button>
          ))}
        </div>

        <select
          defaultValue=""
          disabled={busy}
          onChange={(e) => {
            const id = Number(e.target.value);
            e.target.value = '';
            if (id) act(() => api.setSymbolWatched(id, true));
          }}
        >
          <option value="">add a symbol to watch…</option>
          {watchable.map((s) => <option key={s.id} value={s.id}>{s.broker_symbol}</option>)}
        </select>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="scan-verdict go">{notice}</p>}
      {tradedTimeframe && (
        <p className="muted">
          The scheduler trades <strong>{tradedTimeframe}</strong> only. Other timeframes here are
          observation; a setup on one can still be taken manually.
        </p>
      )}

      <p className="muted">
        Watching a symbol shows it here. It does <strong>not</strong> make it tradeable — only a
        symbol marked <span className="tradeable-tag">tradeable</span> can reach the order path,
        and that is earned by passing a backtest.
      </p>

      {scan?.rows.length === 0 && <p className="empty">Nothing watched yet. Add a symbol above.</p>}

      {scan?.rows.map((row) => (
        <div key={row.symbolId} className="scan-row">
          <div className="scan-head">
            <div>
              <strong>{row.symbol}</strong>
              {row.tradeable
                ? <span className="tradeable-tag">tradeable</span>
                : <span className="watch-tag">watch only</span>}
              <small>{row.timeframe} · {price(row.price, row.digits)}</small>
            </div>
            <div className="align-right">
              <button
                className="link"
                disabled={busy}
                onClick={() => act(() => api.setSymbolWatched(row.symbolId, false))}
              >
                unwatch
              </button>
            </div>
          </div>

          {row.note && <p className="empty">{row.note}</p>}

          {row.strategies.map((s) => (
            <div key={s.strategy} className={`scan-strategy ${s.firing ? 'firing' : ''}`}>
              <div className="scan-strategy-head">
                <span className="scan-strategy-name">
                  {s.strategy}
                  {!s.strategyEnabled && <em className="muted"> (strategy disabled)</em>}
                </span>
                {s.firing
                  ? <span className={`badge ${s.side === 'BUY' ? 'buy' : 'sell'}`}>{s.side}</span>
                  : <span className="status-tag">no setup</span>}
              </div>

              <p className="scan-reason">{s.reason}</p>

              {s.firing && s.risk && (
                <>
                  <p className={s.wouldTrade ? 'scan-verdict go' : 'scan-verdict blocked'}>
                    {s.wouldTrade
                      ? `risk allows ${s.risk.lot} lots risking ${num(s.risk.riskAmount)}`
                      : `blocked: ${s.blockedBy}`}
                  </p>

                  {/* The scheduler only ever evaluates one timeframe. Saying
                      "would trade" on any other would be a false promise. */}
                  {s.wouldTrade && tradedTimeframe && timeframe !== tradedTimeframe && (
                    <p className="scan-verdict blocked">
                      the scheduler only trades {tradedTimeframe}, so this {timeframe} setup
                      will not be taken automatically — use Trade now
                    </p>
                  )}

                  {s.wouldTrade && (
                    <button
                      className="trade-now"
                      disabled={busy}
                      onClick={() => act(async () => {
                        const r = await api.tradeSetup(row.symbolId, s.strategy, timeframe);
                        setNotice(`filled ${s.side} ${row.symbol} — ticket ${r.ticket}`);
                      })}
                    >
                      Trade now — {s.side} {s.risk.lot} lots
                    </button>
                  )}
                </>
              )}

              <button
                className="link"
                onClick={() => setExpanded(expanded === `${row.symbolId}-${s.strategy}` ? null : `${row.symbolId}-${s.strategy}`)}
              >
                {expanded === `${row.symbolId}-${s.strategy}` ? 'hide' : 'show'} detail
              </button>

              {expanded === `${row.symbolId}-${s.strategy}` && (
                <div className="scan-detail">
                  <Checks title="Strategy conditions" checks={s.checks} />
                  {s.risk && <Checks title="Risk gates" checks={s.risk.checks} />}
                  {s.levels && (
                    <p className="muted">
                      entry {price(s.levels.entry, row.digits)} · stop {price(s.levels.sl, row.digits)} · target {price(s.levels.tp, row.digits)}
                    </p>
                  )}
                  <p className="muted">
                    {Object.entries(s.features || {})
                      .map(([k, v]) => `${k} ${num(v, 2)}`)
                      .join(' · ')}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
