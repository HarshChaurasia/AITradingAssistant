import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Scalping, kept on its own screen.
 *
 * Scalps are a different animal from swing strategies: they hold for minutes,
 * take many more trades, and are decided by spread rather than by direction.
 * Pooling them into the same tables makes both harder to read - a scalp's two
 * hundred trades drown a swing strategy's twenty in any average covering both.
 *
 * The screen leads with the cost question because it decides the answer before
 * any strategy is chosen.
 */

const STATUSES = ['draft', 'backtested', 'demo', 'live'];

// M1 is deliberately absent. On this account the spread is wider than the
// median M1 bar on ETHUSD and EURUSD, so there is nothing for a scalp to win
// there - see the viability grid above.
const SCALP_TIMEFRAMES = ['M5', 'M15', 'M30'];

/**
 * Where a scalp is allowed to run.
 *
 * Selecting nothing means everywhere, which is the default and is NOT the same
 * as switched off. The viability grid above is the guide: a red cell is a
 * combination the spread has already decided.
 */
function ScalpScope({ strategy, viability, symbols, busy, onSave }) {
  const [picked, setPicked] = useState(() => new Set(
    (strategy.scopes || [])
      .filter((sc) => sc.symbolId && sc.timeframe)
      .map((sc) => `${sc.symbolId}|${sc.timeframe}`)
  ));
  const [dirty, setDirty] = useState(false);

  function toggle(symbolId, timeframe) {
    const key = `${symbolId}|${timeframe}`;
    const next = new Set(picked);
    if (next.has(key)) next.delete(key); else next.add(key);
    setPicked(next);
    setDirty(true);
  }

  function verdictFor(symbolName, timeframe) {
    if (!viability) return null;
    return viability.rows.find((r) => r.symbol === symbolName && r.timeframe === timeframe);
  }

  const tradeable = symbols.filter((sym) => sym.enabled || sym.watched);

  return (
    <>
      <div className="gate-title">Where this scalp may run</div>
      <p className="muted">
        {picked.size === 0
          ? 'Nothing selected, so it runs on every enabled symbol and every scanned timeframe. That is the default, not "switched off".'
          : `${picked.size} combination${picked.size === 1 ? '' : 's'} selected. It runs only on these.`}
      </p>

      <table className="table scope-grid">
        <thead>
          <tr><th>Symbol</th>{SCALP_TIMEFRAMES.map((tf) => <th key={tf}>{tf}</th>)}</tr>
        </thead>
        <tbody>
          {tradeable.map((sym) => (
            <tr key={sym.id}>
              <td><strong>{sym.broker_symbol}</strong></td>
              {SCALP_TIMEFRAMES.map((tf) => {
                const v = verdictFor(sym.broker_symbol, tf);
                const bad = v && v.verdict === 'not viable';
                return (
                  <td key={tf} title={v ? v.detail : ''}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={picked.has(`${sym.id}|${tf}`)}
                      onChange={() => toggle(sym.id, tf)}
                    />
                    <small className={bad ? 'down' : v && v.verdict === 'viable' ? 'up' : 'muted'}>
                      {v && v.ratio !== null ? ` ${v.ratio}x` : ''}
                    </small>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="toolbar">
        <button
          disabled={busy || !dirty}
          onClick={() => {
            onSave([...picked].map((key) => {
              const [symbolId, timeframe] = key.split('|');
              return { symbolId: Number(symbolId), timeframe };
            }));
            setDirty(false);
          }}
        >
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

function num(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(digits);
}

const VERDICT_TONE = {
  viable: 'up',
  marginal: 'muted',
  'not viable': 'down',
  unknown: 'muted'
};

export default function Scalping() {
  const [data, setData] = useState(null);
  const [viability, setViability] = useState(null);
  const [symbols, setSymbols] = useState([]);
  const [sweep, setSweep] = useState(null);
  const [balance, setBalance] = useState(10000);
  const [months, setMonths] = useState(6);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setData(await api.strategyAnalytics('demo'));
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.scalpViability().then(setViability).catch((e) => setError(e.message));
    api.symbols().then(setSymbols).catch(() => {});
    api.bridgeAccount()
      .then((a) => { if (a?.balance > 0) setBalance(Math.round(a.balance)); })
      .catch(() => {});
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

  /**
   * A scalp-only sweep.
   *
   * Separate from the main Backtests screen on purpose. It fixes the
   * timeframes to the ones a scalp can trade, runs only the scalp strategies,
   * and takes the spread from the broker per symbol - which is the whole
   * argument here, and which one shared spread box would get wrong for every
   * instrument at once.
   */
  async function runSweep() {
    setBusy(true);
    setError(null);
    setSweep(null);
    const targets = symbols.filter((x) => x.enabled || x.watched);
    setRunning(`${targets.length * SCALP_TIMEFRAMES.length * scalps.length} combinations…`);
    try {
      const from = new Date();
      from.setMonth(from.getMonth() - Number(months));
      setSweep(await api.sweepBacktests({
        symbolIds: targets.map((x) => x.id),
        strategyNames: scalps.map((x) => x.name),
        timeframes: SCALP_TIMEFRAMES,
        options: {
          startingBalance: Number(balance),
          riskPctPerTrade: 1,
          commissionPerLot: 0,
          from: from.toISOString().slice(0, 10)
        }
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(null);
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

  const scalps = data.strategies.filter((s) => s.kind === 'scalp');
  const timeframes = viability ? [...new Set(viability.rows.map((r) => r.timeframe))] : [];
  // Named apart from the `symbols` state: this is the list the viability grid
  // measured, which includes timeframes that have no stored candles yet.
  const measuredSymbols = viability ? [...new Set(viability.rows.map((r) => r.symbol))] : [];
  const cell = (symbol, timeframe) =>
    viability.rows.find((r) => r.symbol === symbol && r.timeframe === timeframe);

  return (
    <>
      {error && <p className="error">{error}</p>}

      <div className="panel">
        <div className="panel-header">
          <h3>Can a scalp pay for its own spread?</h3>
          <span>median bar range ÷ spread</span>
        </div>

        <p className="muted">
          A scalp targets a fraction of a bar. If the round trip costs most of that fraction there
          is nothing left to win, and no parameter set fixes it — the strategy is being asked to
          out-trade its own commission. This is measured from your broker&apos;s actual spread and
          your stored candles, so it is this account, not a general claim.
        </p>

        {!viability ? <p className="muted">Measuring…</p> : (
          <>
            <table className="table scope-grid">
              <thead>
                <tr><th>Symbol</th>{timeframes.map((tf) => <th key={tf}>{tf}</th>)}</tr>
              </thead>
              <tbody>
                {measuredSymbols.map((symbol) => (
                  <tr key={symbol}>
                    <td><strong>{symbol}</strong></td>
                    {timeframes.map((tf) => {
                      const c = cell(symbol, tf);
                      return (
                        <td key={tf} className={VERDICT_TONE[c?.verdict] || 'muted'} title={c?.detail || ''}>
                          {c?.ratio === null || c?.ratio === undefined ? '—' : `${c.ratio}×`}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              <span className="up">green</span> ≥ {viability.thresholds.viable}× — room to work ·{' '}
              grey ≥ {viability.thresholds.marginal}× — little left after costs ·{' '}
              <span className="down">red</span> — most of any move is the spread itself.
            </p>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>What the backtests said</h3>
          <span>out-of-sample, at your broker&apos;s real spread</span>
        </div>
        <p className="muted">
          Both shipped scalps lose money on <strong>every</strong> symbol and timeframe tested. On
          BTCUSD M5 — the best cost ratio of any instrument here — micro-breakout ran at a profit
          factor of 0.51. Seven parameter variants were tried and none reached 1.0; the best was
          0.87.
        </p>
        <p className="muted">
          The shape of those results is the finding: <strong>every change that helped moved toward
          a wider target and a longer hold</strong> — that is, away from scalping and toward swing
          trading. That is evidence the premise is failing rather than the parameters.
        </p>
        <p className="muted">
          They are shipped <strong>disabled</strong>, with the measurements above, so the conclusion
          can be re-tested rather than taken on trust. What would change it is a raw-spread account
          where cost arrives as commission instead of a markup — on a 12-dollar BTCUSD spread there
          is no parameter set that works.
        </p>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>Backtest the scalps</h3>
          <span>scalp strategies, scalp timeframes, your broker&apos;s own spread</span>
        </div>

        <div className="toolbar">
          <label className="field">balance
            <input type="number" value={balance} onChange={(e) => setBalance(e.target.value)} />
          </label>
          <label className="field">months
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              {[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <button disabled={busy || scalps.length === 0} onClick={runSweep}>
            {busy ? 'Running…' : `Sweep ${SCALP_TIMEFRAMES.join('/')} × every watched symbol`}
          </button>
          {running && <span className="muted">{running}</span>}
        </div>

        <p className="muted">
          No spread box: it is taken from the broker for each symbol. One shared number cannot
          serve a sweep — 0.0002 is about right for EURUSD and is effectively zero for BTCUSD,
          whose real spread is twelve dollars.
        </p>

        {sweep && (
          <>
            <div className={sweep.passed > 0 ? 'verdict pass' : 'verdict fail'}>
              <strong>{sweep.passed} of {sweep.combinations} passed</strong>
              <span>
                {sweep.failed} failed the thresholds, {sweep.errored} could not run. Judged
                out-of-sample only.
              </span>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Symbol</th><th>Strategy</th><th>TF</th><th>Trades</th><th>PF</th>
                  <th>Net</th><th>Win</th><th>Spread</th><th>Time exits</th><th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {[...sweep.results]
                  .sort((a, b) => ((b.outOfSample?.profitFactor ?? 0) - (a.outOfSample?.profitFactor ?? 0)))
                  .map((r) => {
                    const o = r.outOfSample;
                    const exits = r.exits || {};
                    const total = Object.values(exits).reduce((n, v) => n + v, 0);
                    return (
                      <tr key={`${r.symbolId}-${r.strategyName}-${r.timeframe}`}>
                        <td>{symbols.find((x) => x.id === r.symbolId)?.broker_symbol ?? r.symbolId}</td>
                        <td>{r.strategyName}</td>
                        <td>{r.timeframe}</td>
                        <td>{r.ok ? o.trades : '—'}</td>
                        <td>{r.ok ? num(o.profitFactor) : '—'}</td>
                        <td className={r.ok && o.netProfit >= 0 ? 'up' : 'down'}>
                          {r.ok ? num(o.netProfit, 0) : '—'}
                        </td>
                        <td>{r.ok ? `${num(o.winRatePct, 0)}%` : '—'}</td>
                        <td className="muted">{r.costs ? num(r.costs.spreadPrice, 5) : '—'}</td>
                        <td className="muted">
                          {total ? `${Math.round(100 * (exits.TIME || 0) / total)}%` : '—'}
                        </td>
                        <td className={r.ok && r.passed ? 'up' : 'down'} title={r.ok ? (r.failures || []).join('; ') : r.error}>
                          {r.ok ? (r.passed ? 'PASS' : 'fail') : 'error'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>

            <p className="muted">
              <strong>Time exits</strong> is the share that ran out of bars rather than reaching a
              level. A high number means the setups are not resolving inside their hold window —
              which is a signal to lengthen the hold or leave the timeframe alone, not to widen the
              target.
            </p>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>Scalping strategies</h3>
          <span>{scalps.length} shipped · held for minutes, closed on a time stop</span>
        </div>

        {scalps.length === 0 && <p className="empty">None registered yet.</p>}

        {scalps.map((s) => (
          <div key={s.id} className="scan-strategy">
            <div className="scan-strategy-head">
              <span className="scan-strategy-name">
                <strong>{s.name}</strong> <small className="muted">v{s.version}</small>
              </span>
              <span className={s.totals.pnl >= 0 ? 'up' : 'down'}>
                {s.totals.tradesClosed} closed · {num(s.totals.pnl)}
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
                holds {s.params?.maxHoldBars ?? '—'} bars then closes at market ·{' '}
                {s.backtests.runs} backtest run{s.backtests.runs === 1 ? '' : 's'},{' '}
                {s.backtests.passed} passed
              </span>
            </div>

            <ScalpScope
              key={`${s.id}-${(s.scopes || []).length}`}
              strategy={s}
              viability={viability}
              symbols={symbols}
              busy={busy}
              onSave={(scopes) => saveScopes(s.id, scopes)}
            />

            {s.byTimeframe.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>TF</th><th>Signals</th><th>Closed</th><th>Wins</th>
                    <th>Win rate</th><th>Expectancy</th><th>Net P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byTimeframe.map((t) => (
                    <tr key={t.timeframe}>
                      <td><strong>{t.timeframe}</strong></td>
                      <td>{t.signals}</td>
                      <td>{t.tradesClosed}</td>
                      <td className="up">{t.wins}</td>
                      <td>{t.winRatePct === null ? '—' : `${t.winRatePct}%`}</td>
                      <td className={(t.expectancy ?? 0) >= 0 ? 'up' : 'down'}>{num(t.expectancy)}</td>
                      <td className={t.pnl >= 0 ? 'up' : 'down'}>{num(t.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
