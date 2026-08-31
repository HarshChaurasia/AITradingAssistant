import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * The strategy lab: search parameters, then find out whether the winner
 * survives data the search never saw.
 *
 * The screen is arranged around one idea that is easy to lose: every number
 * left of the holdout column has been selected FOR. A search that scores four
 * hundred candidates and keeps the best will always produce an impressive
 * optimise figure - that is what "best of four hundred" means, not what an
 * edge means. Only the holdout was never chosen on, so it is the column the
 * verdict comes from and the one the layout leads to.
 */

const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

function pf(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '∞';
  return n.toFixed(2);
}

function toneFor(value, threshold = 1.3) {
  if (value === null || value === undefined) return 'muted';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'muted';
  if (n >= threshold) return 'up';
  if (n >= 1) return '';
  return 'down';
}

export default function Lab() {
  const [data, setData] = useState(null);
  const [symbols, setSymbols] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [chosenSymbols, setChosenSymbols] = useState([]);
  const [chosenTimeframes, setChosenTimeframes] = useState(['M15', 'M30', 'H1', 'H4']);
  const [iterations, setIterations] = useState(5);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [onlyPromotable, setOnlyPromotable] = useState(false);

  const load = useCallback(async () => {
    setData(await api.labStudies(onlyPromotable ? '?promotable=true' : ''));
  }, [onlyPromotable]);

  useEffect(() => {
    api.symbols().then((rows) => {
      setSymbols(rows);
      setChosenSymbols(rows.filter((s) => s.enabled).map((s) => s.id));
    }).catch((e) => setError(e.message));
    api.strategies().then(setStrategies).catch(() => {});
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    // A grid study runs for minutes, so the page polls rather than waiting on
    // a request that would time out somewhere in the middle of it.
    const timer = setInterval(() => load().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [load]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const from = new Date();
      from.setFullYear(from.getFullYear() - 1);
      await api.startLabStudy({
        symbolIds: chosenSymbols,
        timeframes: chosenTimeframes,
        iterations,
        options: {
          from: from.toISOString().slice(0, 10),
          startingBalance: 133765,
          riskPctPerTrade: 1,
          // Spread comes from each symbol's own broker figure. Commission is
          // zero because this account pays the spread and nothing else - at
          // $7/lot the pooled profit factor fell from 0.78 to 0.62, which
          // decided pass or fail on its own.
          commissionPerLot: 0
        }
      });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function promote(id) {
    setError(null);
    try {
      await api.promoteStudy(id);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function revoke(id) {
    setError(null);
    try {
      await api.revokePromotion(id, 'revoked from the lab');
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (!data) return <section className="panel"><p className="muted">Loading studies…</p></section>;

  const { job, studies, promotions } = data;
  const running = job?.running;
  const p = job?.progress;
  const pct = p?.total ? Math.round((p.done / p.total) * 100) : 0;

  const totalTrials = studies.reduce((n, s) => n + Number(s.trials || 0), 0);
  const promotable = studies.filter((s) => s.promotable).length;

  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <h3>Run a study</h3>
          <span>every enabled strategy, over one year of history</span>
        </div>

        <div className="toolbar">
          <label className="field">iterations
            <select value={iterations} onChange={(e) => setIterations(Number(e.target.value))}>
              {[1, 3, 5, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <button disabled={busy || running || chosenSymbols.length === 0} onClick={run}>
            {running ? 'Studying…' : 'Run study'}
          </button>
          {running && (
            <button onClick={() => api.cancelLabStudy().catch(() => {})}>Cancel</button>
          )}
        </div>

        {/* The same symbol x timeframe grid the scoping screens use, so the
            shape of a choice is the same wherever it is made. */}
        <table className="table scope-grid">
          <thead>
            <tr><th>Study</th>{TIMEFRAMES.map((tf) => <th key={tf}>{tf}</th>)}</tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>timeframes</strong></td>
              {TIMEFRAMES.map((tf) => (
                <td key={tf}>
                  <input
                    type="checkbox"
                    disabled={running}
                    checked={chosenTimeframes.includes(tf)}
                    onChange={() => setChosenTimeframes((current) => (
                      current.includes(tf) ? current.filter((x) => x !== tf) : [...current, tf]
                    ))}
                  />
                </td>
              ))}
            </tr>
          </tbody>
        </table>

        <div className="toolbar">
          {symbols.filter((sym) => sym.enabled || sym.watched).map((sym) => (
            <label key={sym.id} className="setting-toggle">
              <input
                type="checkbox"
                disabled={running}
                checked={chosenSymbols.includes(sym.id)}
                onChange={() => setChosenSymbols((current) => (
                  current.includes(sym.id)
                    ? current.filter((x) => x !== sym.id)
                    : [...current, sym.id]
                ))}
              />
              <span>{sym.broker_symbol}</span>
            </label>
          ))}
        </div>

        {error && <p className="error">{error}</p>}

        {running && p && (
          <div className="scan-progress">
            <div className="scan-progress-bar"><span style={{ width: `${pct}%` }} /></div>
            <span className="muted">
              {p.done} of {p.total} — {p.cell}
              {p.trials ? ` · ${p.trials} parameter sets scored` : ''}
            </span>
          </div>
        )}

        {job?.last && !running && <p className="muted">{job.last.note}</p>}

        <p className="muted">
          The search sees only the first half of the history. The winner is then scored{' '}
          <strong>once</strong> on the next quarter and <strong>once</strong> on the last quarter,
          which nothing was ever chosen on. Promotion needs both. Without that third window a search
          over hundreds of candidates finds one that clears any threshold by luck and reports it as
          an edge — measured here, macd-trend on BTCUSD M15 reads 1.17 → 1.33 → <strong>0.76</strong>.
        </p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Promoted combinations</h3>
          <span>{promotions.length} allowed to trade</span>
        </div>

        {promotions.length === 0 ? (
          <p className="empty">
            Nothing is promoted. With enforcement on, no strategy may trade until a study clears
            both windows.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Strategy</th><th>Symbol</th><th>TF</th>
                <th>Validate</th><th>Holdout</th><th>Trials</th><th>Parameters</th><th />
              </tr>
            </thead>
            <tbody>
              {promotions.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.strategy_name}</strong></td>
                  <td>{row.symbol}</td>
                  <td>{row.timeframe}</td>
                  <td className={toneFor(row.validate_pf)}>{pf(row.validate_pf)}</td>
                  <td className={toneFor(row.holdout_pf)}>{pf(row.holdout_pf)}</td>
                  <td className="muted">{row.trials}</td>
                  <td className="muted">
                    {Object.entries(row.params || {})
                      .filter(([k]) => /atr(Stop|Target)Multiple|maxHoldBars/.test(k))
                      .map(([k, v]) => `${k.replace('atr', '').replace('Multiple', '')} ${v}`)
                      .join(' · ') || '—'}
                  </td>
                  <td><button onClick={() => revoke(row.id)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="muted">
          Promotion is per <strong>combination</strong>, and the parameters are pinned with it.
          Measured over a year, smart-money reaches a profit factor of 1.40 on BTCUSD H1 and 0.43 on
          BTCUSD M5 — the same code on the same instrument, one an edge and one a way to pay the
          spread. The signal generator trades the promoted numbers, not the shipped defaults.
        </p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Studies</h3>
          <span>
            {studies.length} runs · {totalTrials.toLocaleString()} parameter sets scored ·{' '}
            {promotable} cleared both windows
          </span>
        </div>

        <div className="toolbar">
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={onlyPromotable}
              onChange={(e) => setOnlyPromotable(e.target.checked)}
            />
            <span>only what cleared both windows</span>
          </label>
          <span className="muted">{strategies.length} strategies registered</span>
        </div>

        {studies.length === 0 ? (
          <p className="empty">No studies yet. Run one above.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Strategy</th><th>Symbol</th><th>TF</th>
                <th title="Ranked on. Selected FOR, so it flatters by construction.">Optimise</th>
                <th title="Scored once, after the winner was chosen.">Validate</th>
                <th title="Scored once, ever. Nothing was chosen on it.">Holdout</th>
                <th title="How many parameter sets were scored. A pass after 4 and a pass after 400 are different claims.">Trials</th>
                <th title="Do the winner's neighbours work too? A spike is noise; a plateau is an effect.">Neighbours</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {studies.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.strategy_name}</strong></td>
                  <td>{s.symbol}</td>
                  <td>{s.timeframe}</td>
                  <td className="muted">{pf(s.optimise?.profitFactor)}</td>
                  <td className={toneFor(s.validate?.profitFactor)}>
                    {pf(s.validate?.profitFactor)}
                    <small className="muted"> ({s.validate?.trades ?? '—'})</small>
                  </td>
                  <td className={toneFor(s.holdout?.profitFactor)}>
                    {pf(s.holdout?.profitFactor)}
                    <small className="muted"> ({s.holdout?.trades ?? '—'})</small>
                  </td>
                  <td className="muted">{s.trials}</td>
                  <td className={s.robustness?.spike ? 'down' : 'muted'}>
                    {s.robustness?.median ? pf(s.robustness.median) : '—'}
                    {s.robustness?.spike && <small> spike</small>}
                  </td>
                  <td>
                    {s.promoted
                      ? <span className="badge">promoted</span>
                      : s.promotable
                        ? <button onClick={() => promote(s.id)}>Promote</button>
                        : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="muted">
          <strong>Optimise</strong> is what the search ranked on, so it is the best of however many
          candidates were tried and flatters by construction — read it as a floor on how well the
          strategy CAN be fitted, never as evidence. <strong>Neighbours</strong> is the median of the
          winner's nearest rivals: a plateau is an effect that happens to peak somewhere, while a
          winner far above everything adjacent to it is a spike in noise the market will not hand
          back.
        </p>
      </section>
    </>
  );
}
