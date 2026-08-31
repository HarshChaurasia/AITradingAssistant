import { useCallback, useEffect, useState } from 'react';
import CandleChart from '../components/CandleChart';
import SymbolSelect from '../components/SymbolSelect';
import { api } from '../api';
import SpreadViability from '../components/SpreadViability';

const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

/**
 * What history is stored, and a way to go and get more.
 *
 * Every backtest verdict rests on this and nothing showed it. A run reporting
 * "only 20 trades, 50 required" was usually not a strategy that rarely fires -
 * it was three weeks of M5 being asked a question that needs a year.
 *
 * Coverage is measured in BARS, not in calendar span: a gap-ridden series
 * whose oldest row is a year old still cannot answer a year's question, and
 * the bar count is what a backtest actually consumes.
 */
function DataCoverage() {
  const [data, setData] = useState(null);
  const [job, setJob] = useState(null);
  const [months, setMonths] = useState(12);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setData(await api.coverage());
    setJob(await api.backfillStatus());
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    // Polled rather than awaited: a full backfill takes minutes, and a request
    // held open that long times out somewhere in the middle.
    const timer = setInterval(() => load().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [load]);

  async function start() {
    setError(null);
    try {
      await api.startBackfill(months);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (!data) return <section className="panel"><p className="muted">Reading stored history…</p></section>;

  const running = job?.running;
  const p = job?.progress;
  const pct = p?.total ? Math.round((p.done / p.total) * 100) : 0;

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Stored history</h3>
        <span>months of bars held per symbol and timeframe</span>
      </div>

      <div className="toolbar">
        <label className="field">months
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))} disabled={running}>
            {[1, 3, 6, 12, 24].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <button disabled={running} onClick={start}>
          {running ? 'Backfilling…' : `Backfill ${months} months — every symbol, every timeframe`}
        </button>
        {job?.last && !running && (
          <span className="muted">
            last run: {job.last.storedBars.toLocaleString()} bars stored across{' '}
            {job.last.succeeded}/{job.last.combinations} combinations
            {job.last.failed > 0 && `, ${job.last.failed} failed`}
          </span>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {running && p && (
        <div className="scan-progress">
          <div className="scan-progress-bar"><span style={{ width: `${pct}%` }} /></div>
          <span className="muted">
            {p.done} of {p.total} — {p.symbol} {p.timeframe}
          </span>
        </div>
      )}

      <table className="table scope-grid">
        <thead>
          <tr>
            <th>Symbol</th>
            {data.timeframes.map((tf) => <th key={tf}>{tf}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.symbols.map((row) => (
            <tr key={row.symbolId}>
              <td>
                <strong>{row.symbol}</strong>
                {!row.tradeable && <small className="muted"> watch only</small>}
              </td>
              {row.coverage.map((c) => (
                <td
                  key={c.timeframe}
                  className={c.bars === 0 ? 'down' : c.sufficient ? 'up' : 'muted'}
                  title={c.bars === 0
                    ? 'nothing stored'
                    : `${c.bars.toLocaleString()} bars, ${String(c.firstBar).slice(0, 10)} to ${String(c.lastBar).slice(0, 10)}`}
                >
                  {c.bars === 0 ? '—' : `${c.months}m`}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted">
        <span className="up">green</span> is twelve months or more — enough for a walk-forward test to
        reach its 50-trade minimum on most timeframes. Grey is thinner than that; a backtest on it
        will fail on trade count rather than on merit. Hover a cell for the exact bar count and date
        range.
      </p>
      <p className="muted">
        A closed market has nothing new to give, so weekend backfills of FX and gold will report
        fewer bars than asked for. A year of M5 is about 105,000 bars per symbol, so a full run
        takes several minutes — it runs in the background and this updates as it goes.
      </p>
    </section>
  );
}

export default function Markets() {
  const [symbols, setSymbols] = useState([]);
  const [symbolId, setSymbolId] = useState(null);
  const [timeframe, setTimeframe] = useState('H1');
  const [candles, setCandles] = useState([]);
  const [bridge, setBridge] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const loadSymbols = useCallback(async () => {
    const rows = await api.symbols();
    setSymbols(rows);
    setSymbolId((current) => current ?? rows.find((r) => r.enabled)?.id ?? rows[0]?.id ?? null);
  }, []);

  useEffect(() => {
    api.bridgeHealth().then(setBridge).catch((e) => setBridge({ ok: false, error: e.message }));
    loadSymbols().catch((e) => setError(e.message));
  }, [loadSymbols]);

  useEffect(() => {
    if (!symbolId) return;
    api.candles(symbolId, timeframe, 500).then(setCandles).catch((e) => setError(e.message));
  }, [symbolId, timeframe]);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const selected = symbols.find((s) => s.id === symbolId);

  return (
    <>
    <DataCoverage />

    {/* What the spread leaves to work with. A property of the instrument,
        so it belongs beside its history rather than on a strategy screen. */}
    <SpreadViability />

    <section className="panel">
      <div className="panel-header">
        <h3>Markets</h3>
        <span className={bridge?.ok ? 'up' : 'down'}>
          {bridge?.ok ? `MT5 connected · account ${bridge.account_login}` : 'MT5 bridge offline'}
        </span>
      </div>

      <div className="toolbar">
        <SymbolSelect symbols={symbols} value={symbolId} onChange={setSymbolId} />

        <div className="tf-group">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              className={tf === timeframe ? 'tf active' : 'tf'}
              onClick={() => setTimeframe(tf)}
            >
              {tf}
            </button>
          ))}
        </div>

        <button
          disabled={busy}
          onClick={() => run(async () => { await api.syncSymbols(); await loadSymbols(); })}
        >
          Sync symbols
        </button>

        <button
          disabled={busy || !symbolId}
          onClick={() =>
            run(async () => {
              const result = await api.syncCandles(symbolId, timeframe, 12);
              setCandles(await api.candles(symbolId, timeframe, 500));
              setNotice(`backfilled ${result.stored} of ${result.received} ${timeframe} bars (asked for 12 months, ${result.requestedBars})`);
            })
          }
        >
          Backfill 12 months of {timeframe}
        </button>

        {selected && (
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.setSymbolEnabled(selected.id, !selected.enabled);
                await loadSymbols();
              })
            }
          >
            {selected.enabled ? 'Disable' : 'Enable'} {selected.broker_symbol}
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      {candles.length === 0 ? (
        <p className="empty">
          No candles stored for this symbol and timeframe. Start the MT5 terminal and the bridge,
          then press Backfill.
        </p>
      ) : (
        <CandleChart candles={candles} />
      )}

      <p className="muted">
        {candles.length} bars · times are UTC
        {selected && ` · min lot ${selected.min_lot} · step ${selected.lot_step} · tick value ${selected.tick_value}`}
      </p>
    </section>
    </>
  );
}
