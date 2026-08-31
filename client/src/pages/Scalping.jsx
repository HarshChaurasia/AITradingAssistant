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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setData(await api.strategyAnalytics('demo'));
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.scalpViability().then(setViability).catch((e) => setError(e.message));
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

  const scalps = data.strategies.filter((s) => s.kind === 'scalp');
  const timeframes = viability ? [...new Set(viability.rows.map((r) => r.timeframe))] : [];
  const symbols = viability ? [...new Set(viability.rows.map((r) => r.symbol))] : [];
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
                {symbols.map((symbol) => (
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
