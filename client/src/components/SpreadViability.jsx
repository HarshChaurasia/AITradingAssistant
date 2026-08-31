import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * How much room the spread leaves to trade an instrument.
 *
 * This lives with the instruments rather than with the strategies, because
 * that is what it is about. Median bar range divided by the broker's spread is
 * a fact about EURUSD on M5; it says the same thing whichever strategy asks,
 * and it was only ever on the scalping screen because scalping happened to be
 * the first thing that cared.
 *
 * It answers a question no backtest can, because a backtest that fails here
 * fails for a reason no parameter can fix: on EURUSD M1 the spread is two and
 * a half times the entire median bar, so the strategy is being asked to
 * out-trade its own costs. Knowing that before running a study saves the
 * study.
 */

const VERDICT_TONE = { viable: 'up', marginal: 'muted', 'not viable': 'down' };

export default function SpreadViability() {
  const [viability, setViability] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.scalpViability().then(setViability).catch((e) => setError(e.message));
  }, []);

  if (error) return <section className="panel"><p className="error">{error}</p></section>;
  if (!viability) {
    return <section className="panel"><p className="muted">Measuring spread against bar range…</p></section>;
  }

  const timeframes = [...new Set(viability.rows.map((r) => r.timeframe))];
  const symbols = [...new Set(viability.rows.map((r) => r.symbol))];
  const cell = (symbol, timeframe) =>
    viability.rows.find((r) => r.symbol === symbol && r.timeframe === timeframe);

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Room to trade</h3>
        <span>median bar range ÷ spread</span>
      </div>

      <p className="muted">
        If the round trip costs most of the move being aimed at, there is nothing left to win and no
        parameter set fixes it. Measured from your broker&apos;s own spread and your stored candles,
        so this is this account rather than a general claim.
      </p>

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
        <span className="down">red</span> — most of any move is the spread itself. A red cell is a
        reason not to study that combination at all.
      </p>
    </section>
  );
}
