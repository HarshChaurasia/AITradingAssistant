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
  const [balance, setBalance] = useState(100);
  const [riskPct, setRiskPct] = useState(1);
  const [spread, setSpread] = useState(0.0002);
  const [commission, setCommission] = useState(7);
  const [result, setResult] = useState(null);
  const [sweepResult, setSweepResult] = useState(null);
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
          spreadPrice: Number(spread),
          commissionPerLot: Number(commission)
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
      const payload = {
        symbolId,
        timeframes: TIMEFRAMES,
        options: {
          startingBalance: Number(balance),
          riskPctPerTrade: Number(riskPct),
          spreadPrice: Number(spread),
          commissionPerLot: Number(commission)
        }
      };
      setSweepResult(await api.sweepBacktests(payload));
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
        <label className="field">spread
          <input type="number" step="0.00001" value={spread} onChange={(e) => setSpread(e.target.value)} />
        </label>
        <label className="field">comm/lot
          <input type="number" step="0.5" value={commission} onChange={(e) => setCommission(e.target.value)} />
        </label>

        <button disabled={busy || !strategyName || !symbolId} onClick={run}>
          {busy ? 'Running…' : 'Run backtest'}
        </button>

        <button disabled={busy || !symbolId} onClick={runSweep}>
          {busy ? 'Sweeping…' : 'Sweep all strategies × all timeframes'}
        </button>
      </div>

      <p className="muted">
        A timeframe with no stored candles is backfilled from the broker rather than reported as a
        failure — that is what &quot;no candles stored, backfill first&quot; used to mean. A sweep is
        sequential on purpose: firing six concurrent history requests at one MT5 terminal is how the
        bridge stops answering.
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
                <th>Strategy</th><th>TF</th><th>Trades</th><th>PF</th><th>Net</th>
                <th>Max DD</th><th>Bars</th><th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {[...sweepResult.results]
                .sort((a, b) => (b.ok && b.passed ? 1 : 0) - (a.ok && a.passed ? 1 : 0)
                  || ((b.outOfSample?.profitFactor ?? 0) - (a.outOfSample?.profitFactor ?? 0)))
                .map((r) => (
                  <tr key={`${r.strategyName}-${r.timeframe}`}>
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
                      title={r.ok ? (r.failures || []).join('; ') : r.error}
                    >
                      {r.ok ? (r.passed ? 'PASS' : 'fail') : 'error'}
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
