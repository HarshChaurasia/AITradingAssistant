import { useEffect, useState } from 'react';
import EquityCurve from '../components/EquityCurve';
import SymbolSelect from '../components/SymbolSelect';
import { api } from '../api';

const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

function fmt(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  if (value === Infinity || value === 'Infinity') return '∞';
  return Number(value).toFixed(digits);
}

function MetricsTable({ title, metrics }) {
  if (!metrics) return null;
  return (
    <div className="metrics-block">
      <h4>{title}</h4>
      <table className="table">
        <tbody>
          <tr><td>Trades</td><td>{metrics.trades}</td></tr>
          <tr><td>Win rate</td><td>{fmt(metrics.winRatePct)}%</td></tr>
          <tr><td>Profit factor</td><td>{fmt(metrics.profitFactor)}</td></tr>
          <tr><td>Net profit</td><td className={metrics.netProfit >= 0 ? 'up' : 'down'}>{fmt(metrics.netProfit)}</td></tr>
          <tr><td>Expectancy / trade</td><td>{fmt(metrics.expectancy, 4)}</td></tr>
          <tr><td>Max drawdown</td><td>{fmt(metrics.maxDrawdownPct)}%</td></tr>
          <tr><td>Sharpe (per trade)</td><td>{fmt(metrics.sharpe, 3)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

export default function Backtests() {
  const [strategies, setStrategies] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [strategyName, setStrategyName] = useState('');
  const [symbolId, setSymbolId] = useState(null);
  const [timeframe, setTimeframe] = useState('H1');
  // Not 100. At a 1% risk budget of one dollar, the minimum lot on every
  // instrument here risks several percent, so the sizer refuses every single
  // setup and the run reports "0 trades" as though the strategy never fired.
  // That one default was responsible for most backtests appearing to fail.
  const [balance, setBalance] = useState(10000);
  const [riskPct, setRiskPct] = useState(1);
  // Blank means "ask the broker", per symbol. A single number cannot serve a
  // sweep: 0.0002 is about right for EURUSD and is effectively zero against
  // BTCUSD's twelve dollars, so one spread across a multi-symbol run silently
  // flatters whichever instruments are priced in the larger units - which
  // here is every one that matters. Measured: BTCUSD reads PF 0.85 on the
  // forced 0.0002 and 0.78 on its own spread.
  const [spread, setSpread] = useState('');
  // Zero, because this account pays the spread and nothing else. At $7/lot
  // the same BTCUSD sweep drops from 0.78 to 0.62 - a cost that is not being
  // charged should not be deciding which strategies pass.
  const [commission, setCommission] = useState(0);
  const [result, setResult] = useState(null);
  const [sweepResult, setSweepResult] = useState(null);
  const [sweepAllSymbols, setSweepAllSymbols] = useState(false);
  // A year by default. The 50-trade minimum is the threshold most runs fail,
  // and on an H4 chart fifty out-of-sample trades simply needs more history
  // than a couple of thousand bars can hold.
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState('');
  const [progress, setProgress] = useState(null);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.strategies().then((rows) => {
      setStrategies(rows);
      setStrategyName((current) => current || rows[0]?.name || '');
    }).catch((e) => setError(e.message));

    api.symbols().then((rows) => {
      setSymbols(rows);
      setSymbolId((current) => current ?? rows.find((r) => r.enabled)?.id ?? rows[0]?.id ?? null);
    }).catch((e) => setError(e.message));

    api.backtests().then(setRuns).catch((e) => setError(e.message));

    // Start from the real account size when the broker is reachable, so the
    // run measures what this account would actually have done.
    api.bridgeAccount()
      .then((a) => { if (a?.balance > 0) setBalance(Math.round(a.balance)); })
      .catch(() => {});
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        strategyName,
        symbolId,
        timeframe,
        options: {
          startingBalance: Number(balance),
          riskPctPerTrade: Number(riskPct),
          // Omitted rather than zeroed: the engine reads each symbol's own
          // spread from the broker when the caller does not insist.
          spreadPrice: spread === '' ? undefined : Number(spread),
          commissionPerLot: Number(commission),
          from: from || undefined,
          to: to || undefined
        }
      };
      setResult(await api.runBacktest(payload));
      setRuns(await api.backtests());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Every strategy against every timeframe for one symbol.
   *
   * Running one combination at a time invites picking the best of sixty and
   * calling it an edge, so this reports the whole grid - failures included.
   * A timeframe with no stored history is backfilled rather than skipped.
   */
  async function runSweep() {
    setBusy(true);
    setError(null);
    setSweepResult(null);
    try {
      const targets = sweepAllSymbols
        ? symbols.filter((s) => s.enabled || s.watched).map((s) => s.id)
        : [symbolId];

      setProgress(`running ${targets.length * TIMEFRAMES.length * strategies.length} combinations — this can take a few minutes`);

      const payload = {
        symbolIds: targets,
        timeframes: TIMEFRAMES,
        options: {
          startingBalance: Number(balance),
          riskPctPerTrade: Number(riskPct),
          // Per symbol from the broker unless overridden. Forcing one number
          // across a sweep is what made every BTCUSD result optimistic.
          spreadPrice: spread === '' ? undefined : Number(spread),
          commissionPerLot: Number(commission),
          from: from || undefined,
          to: to || undefined
        }
      };
      setSweepResult(await api.sweepBacktests(payload));
      setProgress(null);
      setRuns(await api.backtests());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Backtests</h3>
        <span>Validate before any capital moves</span>
      </div>

      <div className="toolbar">
        <select value={strategyName} onChange={(e) => setStrategyName(e.target.value)}>
          {strategies.map((s) => (
            <option key={s.id} value={s.name}>{s.name} v{s.version} · {s.status}</option>
          ))}
        </select>

        <SymbolSelect symbols={symbols} value={symbolId} onChange={setSymbolId} />

        <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
          {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
        </select>

        <label className="field">balance
          <input type="number" value={balance} onChange={(e) => setBalance(e.target.value)} />
        </label>
        <label className="field">risk %
          <input type="number" step="0.1" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} />
        </label>
        <label className="field" title="Leave blank to use each symbol's own spread from the broker. One number cannot serve a sweep: 0.0002 is right for EURUSD and effectively zero against BTCUSD's twelve dollars.">
          spread <small className="muted">(blank = broker)</small>
          <input
            type="number" step="0.00001" placeholder="broker"
            value={spread} onChange={(e) => setSpread(e.target.value)}
          />
        </label>
        <label className="field">comm/lot
          <input type="number" step="0.5" value={commission} onChange={(e) => setCommission(e.target.value)} />
        </label>

        <label className="field">from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">to
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>

        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={sweepAllSymbols}
            onChange={(e) => setSweepAllSymbols(e.target.checked)}
          />
          <span><strong>sweep every watched symbol</strong></span>
        </label>

        <button disabled={busy || !strategyName || !symbolId} onClick={run}>
          {busy ? 'Running…' : 'Run backtest'}
        </button>

        <button disabled={busy || !symbolId} onClick={runSweep}>
          {busy ? 'Sweeping…' : 'Sweep all strategies × all timeframes'}
        </button>
      </div>

      {progress && <p className="muted">{progress}</p>}

      <p className="muted">
        <strong>Why runs fail on &quot;only N trades&quot;:</strong> the verdict is judged on
        out-of-sample data only, which is the last 30% of the chosen window, and it demands 50
        trades there before it will call anything an edge. A strategy taking one trade a week needs
        roughly seven years of history to clear that on H4 — so the date range above matters more
        than any parameter. Widen it, or lower the minimum in the backtest thresholds if you accept
        a weaker claim.
      </p>

      <p className="muted">
        Dates restrict where trades may be TAKEN, not what the indicators may see — a 200-bar EMA
        still warms up from the bars before your start date, so the same bar produces the same value
        it would have live. A timeframe with no stored candles is backfilled from the broker rather
        than reported as a failure.
      </p>

      {error && <p className="error">{error}</p>}

      {result && (
        <>
          <div className={result.passed ? 'verdict pass' : 'verdict fail'}>
            <strong>{result.passed ? 'PASSED' : 'FAILED'}</strong>
            <span>
              {result.passed
                ? 'Out-of-sample results clear every threshold. Eligible for demo.'
                : 'Judged on out-of-sample data only:'}
            </span>
            {!result.passed && (
              <ul>{result.failures.map((f) => <li key={f}>{f}</li>)}</ul>
            )}
          </div>

          {result.skips?.diagnosis && (
            <p className="error">
              <strong>Why there were no trades: </strong>{result.skips.diagnosis.detail}
            </p>
          )}
          {!result.skips?.diagnosis && result.skips?.outOfSample > 0 && (
            <p className="muted">
              {result.skips.outOfSample} out-of-sample setups were skipped because they could not
              be sized at this balance and risk. The trades below are the ones that could.
            </p>
          )}

          <div className="metrics-grid">
            <MetricsTable title="In-sample (first 70%)" metrics={result.walkForward.inSample} />
            <MetricsTable title="Out-of-sample (last 30%)" metrics={result.walkForward.outOfSample} />
            <MetricsTable title="Full period" metrics={result.metrics} />
          </div>

          <h4>Equity curve — full period</h4>
          <EquityCurve equity={result.metrics.equityCurve} />
        </>
      )}

      {sweepResult && (
        <>
          <div className={sweepResult.passed > 0 ? 'verdict pass' : 'verdict fail'}>
            <strong>{sweepResult.passed} of {sweepResult.combinations} passed</strong>
            <span>
              {sweepResult.failed} failed the thresholds, {sweepResult.errored} could not run.
              Judged on out-of-sample data only.
            </span>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th><th>Strategy</th><th>TF</th><th>Trades</th><th>PF</th><th>Net</th>
                <th>Max DD</th><th>Bars</th><th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {[...sweepResult.results]
                .sort((a, b) => (b.ok && b.passed ? 1 : 0) - (a.ok && a.passed ? 1 : 0)
                  || ((b.outOfSample?.profitFactor ?? 0) - (a.outOfSample?.profitFactor ?? 0)))
                .map((r) => (
                  <tr key={`${r.symbolId}-${r.strategyName}-${r.timeframe}`}>
                    <td>{symbols.find((s) => s.id === r.symbolId)?.broker_symbol ?? r.symbolId}</td>
                    <td>{r.strategyName}</td>
                    <td>{r.timeframe}</td>
                    <td>{r.ok ? r.outOfSample.trades : '—'}</td>
                    <td>{r.ok ? fmt(r.outOfSample.profitFactor) : '—'}</td>
                    <td className={r.ok && r.outOfSample.netProfit >= 0 ? 'up' : 'down'}>
                      {r.ok ? fmt(r.outOfSample.netProfit) : '—'}
                    </td>
                    <td>{r.ok ? `${fmt(r.outOfSample.maxDrawdownPct, 1)}%` : '—'}</td>
                    <td className="muted">{r.bars ?? '—'}</td>
                    <td
                      className={r.ok && r.passed ? 'up' : 'down'}
                      title={r.ok
                        ? [...(r.failures || []), r.skips?.diagnosis?.detail].filter(Boolean).join('; ')
                        : r.error}
                    >
                      {r.ok ? (r.passed ? 'PASS' : 'fail') : 'error'}
                      {r.ok && r.skips?.diagnosis && <small className="muted"> unsizable</small>}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}

      <h4>Recent runs</h4>
      <table className="table">
        <thead>
          <tr><th>#</th><th>Strategy</th><th>Symbol</th><th>TF</th><th>Verdict</th></tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.strategy_name}</td>
              <td>{r.broker_symbol}</td>
              <td>{r.timeframe}</td>
              <td className={r.passed ? 'up' : 'down'}>{r.passed ? 'pass' : 'fail'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
