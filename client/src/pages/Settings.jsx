import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Everything an operator can change without a redeploy.
 *
 * The environment switches are shown read-only alongside them. Without that,
 * a toggle can read "auto-trade on" while EXECUTION_ENABLED=false quietly
 * stops every order, and there is nothing on screen to explain the silence.
 */

function Toggle({ label, hint, checked, onChange, disabled, danger }) {
  return (
    <label className={`setting-toggle ${danger ? 'danger' : ''}`}>
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        {hint && <small className="muted">{hint}</small>}
      </span>
    </label>
  );
}

function NumberField({ label, hint, value, onChange, step = 1, min, max }) {
  return (
    <label className="setting-field">
      <span><strong>{label}</strong>{hint && <small className="muted">{hint}</small>}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    </label>
  );
}

export default function Settings() {
  const [data, setData] = useState(null);
  const [ops, setOps] = useState(null);
  const [risk, setRisk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    api.settings()
      .then((s) => { setData(s); setOps(s.operations); setRisk(s.risk); })
      .catch((e) => setError(e.message));
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await api.saveSettings({ operations: ops, risk });
      setOps(result.operations);
      setRisk(result.risk);
      setSaved(`Saved at ${new Date().toLocaleTimeString()}. The scheduler picks this up on its next tick.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !ops) return <section className="panel"><p className="error">{error}</p></section>;
  if (!ops || !risk) return <section className="panel"><p className="muted">Loading…</p></section>;

  const env = data.environment;
  const timeframes = data.timeframes;
  const set = (patch) => setOps({ ...ops, ...patch });

  return (
    <>
      <div className="panel">
        <div className="panel-header">
          <h3>Automation</h3>
          <span>changes take effect on the next scheduler tick — no restart</span>
        </div>

        <Toggle
          label="Take trades automatically"
          hint="The moment a signal passes every risk gate, send the order. With this off, a signal waits in Signals for you to approve it — the execution path is identical either way."
          checked={ops.autoTradeEnabled}
          onChange={(v) => set({ autoTradeEnabled: v })}
        />

        <Toggle
          label="…on the LIVE account too"
          hint="A second, separate decision. The bridge's own MT5_ALLOW_LIVE guard still applies on top of this, so both must be on before a live order can leave the machine."
          checked={ops.autoTradeLive}
          disabled={!ops.autoTradeEnabled}
          danger
          onChange={(v) => set({ autoTradeLive: v })}
        />

        {ops.autoTradeEnabled && !env.executionEnabled && (
          <p className="error">
            Auto-trade is on, but <code>EXECUTION_ENABLED</code> is false in the environment, so no
            order can be sent. Set it in <code>server/.env</code> and restart, or nothing here will trade.
          </p>
        )}

        <div className="setting-field">
          <span>
            <strong>Traded timeframes</strong>
            <small className="muted">
              The timeframes the scheduler generates signals on. Several at once is how you find
              out which one this edge actually works on — but each is a separate stream of trades
              against the same account, so the concurrent-position limit and the daily loss cap
              below are what stop three timeframes becoming three times the risk.
            </small>
          </span>
          <div className="tf-group">
            {timeframes.map((tf) => (
              <button
                key={tf}
                className={ops.tradedTimeframes.includes(tf) ? 'tf active' : 'tf'}
                onClick={() => set({
                  tradedTimeframes: ops.tradedTimeframes.includes(tf)
                    ? ops.tradedTimeframes.filter((x) => x !== tf)
                    : [...ops.tradedTimeframes, tf]
                })}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {ops.tradedTimeframes.length === 0 && (
          <p className="error">
            No traded timeframe selected, so the scheduler will generate no signals at all. The
            last valid selection stays in force until you pick at least one.
          </p>
        )}

        <div className="setting-field">
          <span>
            <strong>Signal expiry</strong>
            <small className="muted">
              A signal is priced at its bar&apos;s close, so the longer it sits unexecuted the
              further price has drifted from the level the strategy actually judged.
              <strong> Proportional</strong> scales the window to the bar; a fixed number cannot be
              right for both an M15 signal and a D1 one.
            </small>
          </span>
          <select
            value={ops.signalExpiryMode}
            onChange={(e) => set({ signalExpiryMode: e.target.value })}
          >
            <option value="proportional">proportional to the bar</option>
            <option value="fixed">a fixed number of minutes</option>
          </select>
        </div>

        {ops.signalExpiryMode === 'proportional' ? (
          <>
            <NumberField
              label="Expiry as % of the bar"
              hint="10% of an H4 bar is 24 minutes; of an M15 bar, 90 seconds. Never longer than the bar itself — by then the next one has closed and the strategy has had a fresh say."
              value={ops.signalExpiryPct}
              min={1}
              max={100}
              onChange={(v) => set({ signalExpiryPct: v })}
            />
            <NumberField
              label="Minimum expiry (minutes)"
              hint="The floor. The scheduler ticks once a minute, so a signal that expires between ticks could never be acted on."
              value={ops.signalExpiryMinMinutes}
              min={2}
              max={1440}
              onChange={(v) => set({ signalExpiryMinMinutes: v })}
            />
            <div className="setting-field">
              <span>
                <strong>Resulting windows</strong>
                <small className="muted">what each traded timeframe works out to</small>
              </span>
              <span className="muted">
                {ops.tradedTimeframes.map((tf) => {
                  const bar = { M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 }[tf] || 60;
                  const minutes = Math.min(
                    Math.max(Math.ceil(bar * (ops.signalExpiryPct / 100)), ops.signalExpiryMinMinutes),
                    bar
                  );
                  return `${tf} ${minutes}m`;
                }).join(' · ') || '—'}
              </span>
            </div>
          </>
        ) : (
          <NumberField
            label="Signal expiry (minutes)"
            hint="The same window for every timeframe."
            value={ops.signalExpiryMinutes}
            min={5}
            max={10080}
            onChange={(v) => set({ signalExpiryMinutes: v })}
          />
        )}

        <NumberField
          label="Stale quote threshold (seconds)"
          hint="How long an instrument can go without a quote before it counts as shut. An open market ticks constantly — measured here, BTCUSD was 1 second stale on a Sunday while EURUSD was 38 hours stale — so the default of 600 sits far from both."
          value={ops.staleTickSeconds}
          step={60}
          min={60}
          max={86400}
          onChange={(v) => set({ staleTickSeconds: v })}
        />

        <NumberField
          label="Backfill bars"
          hint="How much history to pull when a backtest finds an empty candle store."
          value={ops.backfillBars}
          step={100}
          min={100}
          max={20000}
          onChange={(v) => set({ backfillBars: v })}
        />
      </div>

      <div className="panel">
        <div className="panel-header"><h3>Alerts</h3></div>

        <Toggle
          label="Telegram alert when the scanner finds a tradeable setup"
          hint="Worded so it can never be mistaken for a fill — the scanner reports, it does not trade."
          checked={ops.scannerAlertsEnabled}
          onChange={(v) => set({ scannerAlertsEnabled: v })}
        />

        <NumberField
          label="Alert cooldown (minutes)"
          hint="One message per setup per this long. Without it, a setup that persists for a whole session sends a message every scan."
          value={ops.alertCooldownMinutes}
          min={1}
          max={1440}
          onChange={(v) => set({ alertCooldownMinutes: v })}
        />
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>Risk limits</h3>
          <span>these decide what a mistake costs</span>
        </div>

        <NumberField
          label="Risk per trade (%)"
          hint="Of account equity, at the stop. Position size is derived from this and the stop distance — it is never chosen directly."
          value={risk.riskPctPerTrade}
          step={0.1}
          onChange={(v) => setRisk({ ...risk, riskPctPerTrade: v })}
        />
        <NumberField
          label="Daily loss cap (%)"
          hint="Realised losses in one UTC day. Reaching it halts new trades until tomorrow."
          value={risk.dailyLossCapPct}
          step={0.5}
          onChange={(v) => setRisk({ ...risk, dailyLossCapPct: v })}
        />
        <NumberField
          label="Max concurrent positions"
          hint="Across the whole account."
          value={risk.maxConcurrentPositions}
          onChange={(v) => setRisk({ ...risk, maxConcurrentPositions: v })}
        />
        <NumberField
          label="Max positions per symbol"
          hint="Six strategies across five timeframes read the same candles, so a real move fires most of them at once and they arrive as near-identical orders seconds apart. Without this, that is one idea expressed five times at five times the risk."
          value={risk.maxPositionsPerSymbol}
          onChange={(v) => setRisk({ ...risk, maxPositionsPerSymbol: v })}
        />
        <NumberField
          label="Max same-direction positions per symbol"
          hint="The one the account's history argues hardest for: of 50 closed trades, 29 arrived in bursts of three or more within ten minutes and lost 20,518 between them — 64% of everything lost. Each obeyed the 1% cap exactly; they simply were not independent bets. A hedge is not correlated exposure, so this counts direction, not instrument."
          value={risk.maxSameDirectionPerSymbol}
          onChange={(v) => setRisk({ ...risk, maxSameDirectionPerSymbol: v })}
        />
        <NumberField
          label="Consecutive loss limit"
          hint="Trips the kill switch after this many losers in a row."
          value={risk.consecutiveLossLimit}
          onChange={(v) => setRisk({ ...risk, consecutiveLossLimit: v })}
        />
        <NumberField
          label="News blackout (minutes)"
          hint="No new position within this window either side of a high-impact event."
          value={risk.newsBlackoutMinutes}
          onChange={(v) => setRisk({ ...risk, newsBlackoutMinutes: v })}
        />
        <NumberField
          label="Max notional (× equity)"
          hint="A correct 1% risk on a very tight stop can still imply an enormous position. This is the backstop."
          value={risk.maxNotionalMultiple}
          step={0.5}
          onChange={(v) => setRisk({ ...risk, maxNotionalMultiple: v })}
        />
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>Environment</h3>
          <span>read-only — these live in server/.env and need a restart</span>
        </div>
        <p className="muted">
          A dashboard that can place orders must not be able to flip its own master switches. These
          are shown so a toggle above that looks on but does nothing has a visible explanation.
        </p>
        <table className="table">
          <tbody>
            {Object.entries(env).map(([key, value]) => (
              <tr key={key}>
                <td>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</td>
                <td className={value === true ? 'up' : value === false ? 'down' : ''}>
                  {String(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="error">{error}</p>}
      {saved && <p className="scan-verdict go">{saved}</p>}

      <div className="toolbar">
        <button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>
      </div>
    </>
  );
}
