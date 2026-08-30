const { query } = require('../db/pool');
const { getCandles } = require('../market/candles');

/**
 * Grading the trades we did not take.
 *
 * A rejected signal is only ever a hypothesis: the risk engine said no, and
 * nobody found out whether it was right. This replays each one against the
 * candles that arrived afterwards and records the answer, so the rejection
 * reasons that keep costing money become visible instead of invisible.
 *
 * Two rules keep this honest:
 *
 * 1. The replay uses the SAME pessimistic rule as the backtest engine - if a
 *    bar spans both the stop and the target, the stop wins. Assuming the good
 *    fill would turn every volatile bar into a fictional winner.
 * 2. It only reads bars strictly AFTER the signal's bar. That bar had already
 *    closed when the decision was made; including it would grade the decision
 *    against information it did not have.
 */

/**
 * MySQL DATETIME columns arrive as Date objects, not strings.
 *
 * Slicing one as a string yields "Fri Mar 01 2026 05:0", which parses to NaN
 * and quietly filters away every future candle - so every signal graded as
 * no_data and the whole screen looked broken while reporting no error.
 */
function toEpoch(value) {
  if (value instanceof Date) return value.getTime();
  return new Date(`${String(value).slice(0, 19).replace(' ', 'T')}Z`).getTime();
}

function toMysqlDateTime(value) {
  const iso = value instanceof Date ? value.toISOString() : String(value);
  return iso.slice(0, 19).replace('T', ' ');
}

// How far forward to look before calling a setup unresolved. Twenty bars of
// the signal's own timeframe: long enough for a swing trade to work out, short
// enough that "it eventually recovered" is not counted as a win.
const DEFAULT_HORIZON_BARS = 20;

/**
 * Walk forward from a signal until the stop or the target is hit.
 *
 * Returns 'no_data' rather than guessing when too few bars exist yet: a
 * verdict issued before the market has answered is worse than no verdict.
 */
function replay({ signal, futureCandles, horizonBars = DEFAULT_HORIZON_BARS }) {
  const entry = Number(signal.entry);
  const sl = Number(signal.sl);
  const tp = signal.tp === null || signal.tp === undefined ? null : Number(signal.tp);
  const long = signal.side === 'BUY';

  if (futureCandles.length === 0) {
    return { outcome: 'no_data', barsExamined: 0, resolvedAt: null, priceMove: null, rMultiple: null };
  }

  const risk = Math.abs(entry - sl);
  const window = futureCandles.slice(0, horizonBars);

  for (let i = 0; i < window.length; i += 1) {
    const bar = window[i];
    const high = Number(bar.high);
    const low = Number(bar.low);

    const hitStop = long ? low <= sl : high >= sl;
    const hitTarget = tp === null ? false : (long ? high >= tp : low <= tp);

    // Pessimistic ordering: a bar that spans both is recorded as the stop.
    if (hitStop) {
      const move = long ? sl - entry : entry - sl;
      return {
        outcome: 'sl',
        barsExamined: i + 1,
        resolvedAt: bar.open_time,
        priceMove: move,
        rMultiple: risk > 0 ? Number((move / risk).toFixed(4)) : null
      };
    }
    if (hitTarget) {
      const move = long ? tp - entry : entry - tp;
      return {
        outcome: 'tp',
        barsExamined: i + 1,
        resolvedAt: bar.open_time,
        priceMove: move,
        rMultiple: risk > 0 ? Number((move / risk).toFixed(4)) : null
      };
    }
  }

  const lastBar = window.at(-1);
  const close = Number(lastBar.close);
  const move = long ? close - entry : entry - close;
  const rMultiple = risk > 0 ? Number((move / risk).toFixed(4)) : null;

  // Not enough history yet is a different statement from "it never resolved",
  // and conflating them would let today's signals pollute the accuracy figure.
  if (window.length < horizonBars) {
    return { outcome: 'no_data', barsExamined: window.length, resolvedAt: null, priceMove: move, rMultiple };
  }

  return {
    outcome: 'open',
    barsExamined: window.length,
    resolvedAt: lastBar.open_time,
    priceMove: move,
    rMultiple
  };
}

function verdictFor(result) {
  if (result.outcome === 'tp') return 'costly';
  if (result.outcome === 'sl') return 'correct';
  // Drifted without committing, or too early to say. Either way the market has
  // not answered, and inventing a grade here would corrupt the accuracy stat.
  return 'undecided';
}

function detailFor(result) {
  const r = Math.abs(result.rMultiple ?? 0);
  if (result.outcome === 'tp') {
    return `target reached ${result.barsExamined} bars later - refusing this cost ${r}R`;
  }
  if (result.outcome === 'sl') {
    return `stop hit ${result.barsExamined} bars later - refusing this saved ${r}R`;
  }
  if (result.outcome === 'open') {
    return `neither level reached within ${result.barsExamined} bars`;
  }
  return `only ${result.barsExamined} bars have closed since - too early to judge`;
}

/**
 * Grade every refused signal that has not been graded yet.
 *
 * A signal already carrying a resolved outcome is left alone: the market does
 * not change its mind about a bar that closed last week, and re-grading would
 * only burn queries. Ones still marked no_data are retried, because more
 * candles arrive every hour.
 */
async function evaluateMissedSignals({
  modes = ['demo', 'live'],
  horizonBars = DEFAULT_HORIZON_BARS,
  limit = 200
} = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 1000);
  const placeholders = modes.map(() => '?').join(',');

  const rows = await query(
    `SELECT sig.*, sym.broker_symbol, sym.digits, st.name AS strategy_name
       FROM signals sig
       JOIN symbols sym    ON sym.id = sig.symbol_id
       JOIN strategies st  ON st.id = sig.strategy_id
       LEFT JOIN signal_outcomes o ON o.signal_id = sig.id
      WHERE sig.mode IN (${placeholders})
        AND sig.status IN ('rejected', 'expired')
        AND (o.id IS NULL OR o.outcome = 'no_data')
      ORDER BY sig.bar_time DESC
      LIMIT ${safeLimit}`,
    modes
  );

  let graded = 0;
  let pending = 0;

  for (const signal of rows) {
    const candles = await getCandles({
      symbolId: signal.symbol_id,
      timeframe: signal.timeframe,
      limit: 1000
    });

    const barTime = toEpoch(signal.bar_time);
    const future = candles.filter((c) => new Date(c.open_time).getTime() > barTime);

    const result = replay({ signal, futureCandles: future, horizonBars });
    if (result.outcome === 'no_data') pending += 1; else graded += 1;

    await query(
      `INSERT INTO signal_outcomes
         (signal_id, evaluated_at, resolved_at, bars_examined, outcome, price_move, r_multiple, verdict, detail)
       VALUES (?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         evaluated_at = UTC_TIMESTAMP(), resolved_at = VALUES(resolved_at),
         bars_examined = VALUES(bars_examined), outcome = VALUES(outcome),
         price_move = VALUES(price_move), r_multiple = VALUES(r_multiple),
         verdict = VALUES(verdict), detail = VALUES(detail)`,
      [
        signal.id,
        result.resolvedAt ? toMysqlDateTime(result.resolvedAt) : null,
        result.barsExamined,
        result.outcome,
        result.priceMove,
        result.rMultiple,
        verdictFor(result),
        detailFor(result)
      ]
    );
  }

  return { examined: rows.length, graded, pending, horizonBars };
}

/**
 * The missed-signals view: what was refused, why, and what happened next.
 */
async function listMissedSignals({ mode = 'demo', verdict = null, limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const params = [mode];
  let filter = '';
  if (verdict) {
    filter = 'AND o.verdict = ?';
    params.push(verdict);
  }

  const rows = await query(
    `SELECT sig.id, sig.timeframe, sig.side, sig.entry, sig.sl, sig.tp, sig.bar_time,
            sig.status, sig.reason, sig.decision,
            sym.broker_symbol, sym.digits, st.name AS strategy_name,
            o.outcome, o.verdict, o.r_multiple, o.bars_examined, o.detail, o.resolved_at
       FROM signals sig
       JOIN symbols sym   ON sym.id = sig.symbol_id
       JOIN strategies st ON st.id = sig.strategy_id
       JOIN signal_outcomes o ON o.signal_id = sig.id
      WHERE sig.mode = ? ${filter}
      ORDER BY sig.bar_time DESC
      LIMIT ${safeLimit}`,
    params
  );

  return rows.map((r) => ({
    signalId: r.id,
    symbol: r.broker_symbol,
    digits: r.digits,
    strategy: r.strategy_name,
    timeframe: r.timeframe,
    side: r.side,
    entry: Number(r.entry),
    sl: Number(r.sl),
    tp: r.tp === null ? null : Number(r.tp),
    barTime: r.bar_time,
    status: r.status,
    // The first denial reason is the one that actually stopped it. Every gate
    // is evaluated, but this is the one worth tuning.
    blockedBy: r.decision?.denialReasons?.[0] || r.reason || null,
    outcome: r.outcome,
    verdict: r.verdict,
    rMultiple: r.r_multiple === null ? null : Number(r.r_multiple),
    barsExamined: r.bars_examined,
    detail: r.detail,
    resolvedAt: r.resolved_at
  }));
}

/**
 * Which rejection reasons are costing money.
 *
 * This is the whole point of the exercise. A gate that refuses ten setups and
 * saves nine of them is working; one that refuses ten and saves two is a gate
 * whose threshold needs looking at.
 */
async function missedSummary({ mode = 'demo' } = {}) {
  const rows = await listMissedSignals({ mode, limit: 500 });

  const buckets = new Map();
  for (const row of rows) {
    const key = row.blockedBy || 'unknown';
    const bucket = buckets.get(key)
      || { reason: key, total: 0, costly: 0, correct: 0, undecided: 0, netR: 0 };
    bucket.total += 1;
    bucket[row.verdict] += 1;
    if (row.rMultiple !== null && row.verdict !== 'undecided') bucket.netR += row.rMultiple;
    buckets.set(key, bucket);
  }

  const byReason = [...buckets.values()]
    .map((b) => ({
      ...b,
      netR: Number(b.netR.toFixed(2)),
      // Of the decided cases, how often was refusing the right call?
      accuracyPct: (b.costly + b.correct) > 0
        ? Number(((b.correct / (b.costly + b.correct)) * 100).toFixed(1))
        : null
    }))
    // Worst first: the reason that cost the most is the one to look at.
    .sort((a, b) => a.netR - b.netR);

  const correct = rows.filter((r) => r.verdict === 'correct').length;
  const costly = rows.filter((r) => r.verdict === 'costly').length;
  const decided = correct + costly;

  return {
    mode,
    total: rows.length,
    decided,
    costly,
    correct,
    undecided: rows.filter((r) => r.verdict === 'undecided').length,
    accuracyPct: decided ? Number(((correct / decided) * 100).toFixed(1)) : null,
    byReason
  };
}

module.exports = {
  replay,
  evaluateMissedSignals,
  listMissedSignals,
  missedSummary,
  DEFAULT_HORIZON_BARS
};
