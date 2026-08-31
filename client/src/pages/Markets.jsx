import { useCallback, useEffect, useState } from 'react';
import CandleChart from '../components/CandleChart';
import SymbolSelect from '../components/SymbolSelect';
import { api } from '../api';

const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

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
              const result = await api.syncCandles(symbolId, timeframe, 6);
              setCandles(await api.candles(symbolId, timeframe, 500));
              setNotice(`backfilled ${result.stored} of ${result.received} ${timeframe} bars (asked for six months, ${result.requestedBars})`);
            })
          }
        >
          Backfill 6 months of {timeframe}
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
  );
}
