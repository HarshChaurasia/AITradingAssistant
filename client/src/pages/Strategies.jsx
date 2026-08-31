import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * One screen for the whole loop.
 *
 *   research -> backtest -> enabled -> scanned -> signals -> orders -> monitored
 *      ^                                                                   |
 *      +---------------------- demoted -----------------------------------+
 *
 * This replaces four screens - Strategies, Scalping, Backtests and Strategy
 * Lab - that had grown into near-copies of each other. All four listed
 * strategies, all four could start a backtest, and three of them offered a
 * different way to narrow a strategy to a symbol and timeframe. Which one an
 * operator should use for a given question was not answerable, and the honest
 * fix was not four better screens but one, arranged in the order the work
 * actually happens.
 *
 * The stages are tabs rather than a long page because they answer different
 * questions on different days: research is where you spend an afternoon,
 * monitoring is where you spend thirty seconds.
 *
 * WHAT WENT, AND WHY
 *
 * Per-strategy enable/disable toggles. `strategies.enabled` is derived from
 * the lifecycle now - a control that is overwritten a second later is worse
 * than no control.
 *
 * Scope grids. `strategy_scopes` and `strategy_promotions` had ended up
 * narrowing the same thing by two different routes, and two mechanisms for
 * one job is how a strategy ends up trading somewhere nobody chose. A
 * promotion already names its symbol and timeframe, so that is the only
 * narrowing left.
 *
 * The scalp viability grid moved to Markets. Whether the spread leaves room
 * to trade an instrument is a property of the INSTRUMENT, not of a strategy,
 * and it sat here only because scalping happened to be the first thing that
 * cared about it.
 */

const STAGES = [
  { key: 'research', label: 'Research', hint: 'search parameters' },
  { key: 'backtest', label: 'Backtest', hint: 'confirm without searching' },
  { key: 'enabled', label: 'Enabled', hint: 'trading now' },
  { key: 'catalogue', label: 'All strategies', hint: 'the book' }
];

const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

function pf(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '∞';
  return n.toFixed(2);
}

function tone(value, threshold = 1.3) {
  if (value === null || value === undefined) return 'muted';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'muted';
  if (n >= threshold) return 'up';
  if (n >= 1) return '';
  return 'down';
}

export default function Strategies() {
  const [stage, setStage] = useState('enabled');
  const [data, setData] = useState(null);
  const [life, setLife] = useState({ counts: {}, promotions: [], events: [] });
  const [strategies, setStrategies] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [chosenSymbols, setChosenSymbols] = useState([]);
  const [chosenTimeframes, setChosenTimeframes] = useState(['M15', 'M30', 'H1', 'H4']);
  const [iterations, setIterations] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setData(await api.labStudies());
    setLife(await api.lifecycle());
  }, []);

  useEffect(() => {
    api.strategies().then(setStrategies).catch(() => {});
    api.symbols().then((rows) => {
      setSymbols(rows);
      setChosenSymbols(rows.filter((s) => s.enabled).map((s) => s.id));
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    // A study runs for minutes, so this polls rather than holding a request
    // open for the whole thing.
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

  if (!data) return <section className="panel"><p className="muted">Loading…</p></section>;

  const { job, studies } = data;
  const pipeline = life.promotions || [];
  const counts = life.counts || {};
  const enabled = pipeline.filter((p) => p.stage === 'enabled' && !p.revoked_at);
  const awaiting = pipeline.filter((p) => p.stage === 'backtest' && !p.revoked_at);
  const demoted = pipeline.filter((p) => p.stage === 'demoted' || p.revoked_at);
  const running = job?.running;
  const p = job?.progress;
  const pct = p?.total ? Math.round((p.done / p.total) * 100) : 0;

  return (
    <>
      <div className="toolbar">
        {STAGES.map((s) => (
          <button
            key={s.key}
            className={stage === s.key ? 'nav active' : 'nav'}
            onClick={() => setStage(s.key)}
          >
            {s.label}
            {s.key === 'enabled' && enabled.length > 0 && ` (${enabled.length})`}
            {s.key === 'backtest' && awaiting.length > 0 && ` (${awaiting.length})`}
          </button>
        ))}
        <span className="muted">
          {STAGES.find((s) => s.key === stage)?.hint}
        </span>
      </div>

      {error && <p className="error">{error}</p>}

      {stage === 'research' && (
        <>
          <section className="panel">
            <div className="panel-header">
              <h3>Run a study</h3>
              <span>every registered strategy, one year of history</span>
            </div>

            <div className="toolbar">
              <label className="field">iterations
                <select
                  value={iterations}
                  disabled={running}
                  onChange={(e) => setIterations(Number(e.target.value))}
                >
                  {[1, 3, 5, 8].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <button
                disabled={busy || running || chosenSymbols.length === 0}
                onClick={() => act(async () => {
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
                      // The account pays the spread and nothing else. Charging
                      // a commission it does not pay failed combinations on a
                      // cost that was not real - measured, it took the pooled
                      // profit factor from 0.78 to 0.62.
                      commissionPerLot: 0
                    }
                  });
                })}
              >
                {running ? 'Studying…' : 'Run study'}
              </button>
              {running && (
                <button onClick={() => api.cancelLabStudy().catch(() => {})}>Cancel</button>
              )}
            </div>

            <div className="toolbar">
              {symbols.filter((s) => s.enabled || s.watched).map((sym) => (
                <label key={sym.id} className="setting-toggle">
                  <input
                    type="checkbox"
                    disabled={running}
                    checked={chosenSymbols.includes(sym.id)}
                    onChange={() => setChosenSymbols((cur) => (
                      cur.includes(sym.id) ? cur.filter((x) => x !== sym.id) : [...cur, sym.id]
                    ))}
                  />
                  <span>{sym.broker_symbol}</span>
                </label>
              ))}
              {TIMEFRAMES.map((tf) => (
                <label key={tf} className="setting-toggle">
                  <input
                    type="checkbox"
                    disabled={running}
                    checked={chosenTimeframes.includes(tf)}
                    onChange={() => setChosenTimeframes((cur) => (
                      cur.includes(tf) ? cur.filter((x) => x !== tf) : [...cur, tf]
                    ))}
                  />
                  <span>{tf}</span>
                </label>
              ))}
            </div>

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
              The search sees only the first half of the history. The winner is scored{' '}
              <strong>once</strong> on the next quarter and <strong>once</strong> on the last
              quarter, which nothing was ever chosen on — and both must pass. Without that third
              window, a search over hundreds of candidates finds one that clears any threshold by
              luck: measured here, macd-trend on BTCUSD M15 reads 1.17 → 1.33 → <strong>0.76</strong>.
            </p>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>Studies</h3>
              <span>
                {studies.length} runs ·{' '}
                {studies.reduce((n, s) => n + Number(s.trials || 0), 0).toLocaleString()} parameter
                sets scored
              </span>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Strategy</th><th>Symbol</th><th>TF</th>
                  <th title="Ranked on. Selected FOR, so it flatters by construction.">Optimise</th>
                  <th title="Scored once, after the winner was chosen.">Validate</th>
                  <th title="Scored once, ever. Nothing was chosen on it.">Holdout</th>
                  <th title="A pass after 4 candidates and a pass after 400 are different claims.">Trials</th>
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
                    <td className={tone(s.validate?.profitFactor)}>
                      {pf(s.validate?.profitFactor)}
                      <small className="muted"> ({s.validate?.trades ?? '—'})</small>
                    </td>
                    <td className={tone(s.holdout?.profitFactor)}>
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
                          ? <button disabled={busy} onClick={() => act(() => api.promoteStudy(s.id))}>Promote</button>
                          : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="muted">
              <strong>Optimise</strong> is what the search ranked on — the best of however many
              candidates were tried — so it flatters by construction and is a floor on how well a
              strategy CAN be fitted, never evidence that it works.
            </p>
          </section>
        </>
      )}

      {stage === 'backtest' && (
        <section className="panel">
          <div className="panel-header">
            <h3>Awaiting confirmation</h3>
            <span>{awaiting.length} waiting</span>
          </div>

          <div className="toolbar">
            <button disabled={busy || awaiting.length === 0} onClick={() => act(api.confirmPending)}>
              Confirm everything waiting
            </button>
          </div>

          {awaiting.length === 0 ? (
            <p className="empty">
              Nothing is waiting. A combination arrives here when a study clears both windows, and
              leaves it when the confirmation run either passes or fails.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Strategy</th><th>Symbol</th><th>TF</th><th>Validate</th><th>Holdout</th><th>Trials</th><th /></tr>
              </thead>
              <tbody>
                {awaiting.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.strategy_name}</strong></td>
                    <td>{row.symbol}</td>
                    <td>{row.timeframe}</td>
                    <td className={tone(row.validate_pf)}>{pf(row.validate_pf)}</td>
                    <td className={tone(row.holdout_pf)}>{pf(row.holdout_pf)}</td>
                    <td className="muted">{row.trials}</td>
                    <td>
                      <button disabled={busy} onClick={() => act(() => api.confirmCombination(row.id))}>
                        Confirm
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="muted">
            Confirmation is <strong>not</strong> a repeat of the study. The study searched — up to
            four hundred candidates — so its holdout was reached after heavy selection. This runs
            one fixed parameter set across the whole year with no search at all, which catches what
            the study structurally cannot: a winner that only worked in the quarter it landed on.
            It is judged on the full period, so it sees roughly four times the trades.
          </p>

          {demoted.length > 0 && (
            <>
              <div className="panel-header"><h3>Sent back</h3></div>
              <table className="table">
                <thead>
                  <tr><th>Strategy</th><th>Symbol</th><th>TF</th><th>Why</th></tr>
                </thead>
                <tbody>
                  {demoted.map((row) => (
                    <tr key={row.id}>
                      <td>{row.strategy_name}</td>
                      <td>{row.symbol}</td>
                      <td>{row.timeframe}</td>
                      <td className="muted">{row.demote_reason || row.revoked_note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {stage === 'enabled' && (
        <>
          <section className="panel">
            <div className="panel-header">
              <h3>Trading now</h3>
              <span>
                {enabled.length} combination{enabled.length === 1 ? '' : 's'} ·{' '}
                {counts.backtest || 0} awaiting · {counts.demoted || 0} demoted
              </span>
            </div>

            <div className="toolbar">
              <button disabled={busy} onClick={() => act(api.reviewLive)}>
                Review live results now
              </button>
            </div>

            {enabled.length === 0 ? (
              <p className="empty">
                Nothing is enabled, so no signal can be generated and no order placed. A strategy
                earns its place by passing a study and then a confirmation run, for one symbol and
                one timeframe at a time.
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Strategy</th><th>Symbol</th><th>TF</th>
                    <th>Validate</th><th>Holdout</th><th>Live</th><th>Parameters</th><th />
                  </tr>
                </thead>
                <tbody>
                  {enabled.map((row) => (
                    <tr key={row.id}>
                      <td><strong>{row.strategy_name}</strong></td>
                      <td>{row.symbol}</td>
                      <td>{row.timeframe}</td>
                      <td className={tone(row.validate_pf)}>{pf(row.validate_pf)}</td>
                      <td className={tone(row.holdout_pf)}>{pf(row.holdout_pf)}</td>
                      <td className={row.live_trades >= 20 ? tone(row.live_pf, 1) : 'muted'}>
                        {row.live_trades > 0
                          ? `${pf(row.live_pf)} over ${row.live_trades}`
                          : 'no closed trades yet'}
                      </td>
                      <td className="muted">
                        {Object.entries(row.params || {})
                          .filter(([k]) => /atr(Stop|Target)Multiple|maxHoldBars/.test(k))
                          .map(([k, v]) => `${k.replace('atr', '').replace('Multiple', '').toLowerCase()} ${v}`)
                          .join(' · ') || '—'}
                      </td>
                      <td>
                        <button disabled={busy} onClick={() => act(() => api.revokePromotion(row.id, 'revoked by hand'))}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <p className="muted">
              A strategy is enabled for a <strong>symbol and timeframe</strong>, never in general,
              and collects more as more studies pass. It is demoted automatically when its live
              profit factor falls below 1.0 over at least 20 closed trades — the trade minimum
              matters more than the threshold, because a genuine 55%-win strategy produces losing
              ten-trade runs regularly.
            </p>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>What happened</h3>
              <span>every stage change</span>
            </div>
            {(life.events || []).length === 0 ? (
              <p className="empty">No transitions recorded yet.</p>
            ) : (
              <ul className="risk-list">
                {life.events.map((e) => (
                  <li key={e.id}>
                    <strong className={e.to_stage === 'enabled' ? 'up' : e.to_stage === 'demoted' ? 'down' : ''}>
                      {e.to_stage}
                    </strong>{' '}
                    {e.strategy_name} {e.symbol} {e.timeframe}
                    <br />
                    <small className="muted">{e.reason}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {stage === 'catalogue' && (
        <section className="panel">
          <div className="panel-header">
            <h3>All strategies</h3>
            <span>{strategies.length} registered</span>
          </div>

          <table className="table">
            <thead>
              <tr><th>Strategy</th><th>Kind</th><th>Version</th><th>Trading</th><th>Studies</th></tr>
            </thead>
            <tbody>
              {strategies.map((s) => {
                const mine = pipeline.filter((row) => row.strategy_name === s.name);
                const live = mine.filter((row) => row.stage === 'enabled' && !row.revoked_at);
                const studied = studies.filter((row) => row.strategy_name === s.name).length;
                return (
                  <tr key={s.id}>
                    <td><strong>{s.name}</strong></td>
                    <td className="muted">{s.kind}</td>
                    <td className="muted">{s.version}</td>
                    <td className={live.length > 0 ? 'up' : 'muted'}>
                      {live.length > 0
                        ? live.map((row) => `${row.symbol} ${row.timeframe}`).join(', ')
                        : 'nowhere'}
                    </td>
                    <td className="muted">{studied}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="muted">
            There is no enable switch here on purpose. A strategy trades because a combination of
            it passed a study and a confirmation run; a toggle that the next lifecycle pass
            overwrites would be worse than no toggle. To stop one trading, revoke its combination
            under <strong>Enabled</strong>.
          </p>
        </section>
      )}
    </>
  );
}
