const { sendAlert } = require('./notifier');

/**
 * The events worth waking someone for.
 *
 * Each helper swallows its own failures. The trading paths that call these
 * must not care whether a message was delivered.
 *
 * Every message is written to be actionable from a phone without opening the
 * dashboard. The earlier version said "Filled BUY 1 XAUUSD on demo (ticket
 * 555)" - which gives no strategy, no levels, no risk, and no way to judge
 * whether to intervene, so the only response available was to go and look.
 */

async function safely(send, text, logger) {
  try {
    await send(text);
  } catch (error) {
    logger.error(`alert failed: ${error.message}`);
  }
}

/**
 * Format a price to the instrument's own precision.
 *
 * Rendering EURUSD at two decimals gives 1.16 for every price it will ever
 * have, which tells the reader nothing.
 */
function px(value, digits) {
  if (value === null || value === undefined || value === '') return null;
  return Number(value).toFixed(Number.isInteger(digits) ? digits : 2);
}

function rMultiple(entry, sl, tp) {
  if (!entry || !sl || !tp) return null;
  const risk = Math.abs(Number(entry) - Number(sl));
  if (!(risk > 0)) return null;
  return (Math.abs(Number(tp) - Number(entry)) / risk).toFixed(2);
}

function levelLine({ entry, sl, tp, digits }) {
  const e = px(entry, digits);
  if (!e) return null;
  const parts = [`entry ${e}`];
  const s = px(sl, digits);
  const t = px(tp, digits);
  if (s) parts.push(`stop ${s}`);
  if (t) parts.push(`target ${t}`);
  return parts.join('  |  ');
}

async function alertKillSwitch({ mode, reason, send = sendAlert, logger = console }) {
  await safely(
    send,
    `KILL SWITCH tripped on ${mode}\n${reason}\nTrading is halted until you reset it in Risk.`,
    logger
  );
}

/**
 * A fill, with enough context to judge it without opening anything.
 */
async function alertOrderFilled({
  symbol, side, lot, ticket, mode,
  strategy, timeframe, entry, sl, tp, digits, riskAmount, balance, reason, holdBars,
  send = sendAlert, logger = console
}) {
  const arrow = side === 'BUY' ? '▲' : '▼';
  const lines = [`${arrow} FILLED ${side} ${lot} ${symbol}${timeframe ? ` ${timeframe}` : ''}`];

  if (strategy) lines.push(`strategy: ${strategy}`);

  const levels = levelLine({ entry, sl, tp, digits });
  if (levels) lines.push(levels);

  // Risk in money AND as a percentage. The percentage is what actually
  // matters and is the figure nobody computes in their head at speed.
  if (Number(riskAmount) > 0) {
    const pct = Number(balance) > 0
      ? ` (${((Number(riskAmount) / Number(balance)) * 100).toFixed(2)}% of ${Math.round(Number(balance))})`
      : '';
    lines.push(`risking ${Number(riskAmount).toFixed(2)}${pct}`);
  }

  const rr = rMultiple(entry, sl, tp);
  if (rr) lines.push(`reward:risk ${rr}R`);

  // A scalp leaves on a clock as well as on price, and that changes how you
  // read a position that is still open twenty minutes later.
  if (holdBars) lines.push(`scalp: closes after ${holdBars} bars whatever price does`);
  if (reason) lines.push(`why: ${reason}`);

  lines.push(`${mode} account, ticket ${ticket}`);
  await safely(send, lines.join('\n'), logger);
}

async function alertOrderFailed({
  symbol, reason, mode, side, lot, strategy, timeframe, retcode, attempt, maxAttempts,
  send = sendAlert, logger = console
}) {
  const head = `REJECTED ${side || ''} ${lot ?? ''} ${symbol}${timeframe ? ` ${timeframe}` : ''}`;
  const lines = [head.replace(/\s+/g, ' ').trim()];

  if (strategy) lines.push(`strategy: ${strategy}`);
  lines.push(`broker said: ${reason}${retcode ? ` (retcode ${retcode})` : ''}`);

  // Whether this will be tried again matters: one rejection is a bad moment,
  // a final one means the signal has been abandoned.
  if (attempt && maxAttempts) {
    lines.push(attempt >= maxAttempts
      ? `attempt ${attempt} of ${maxAttempts} - giving up on this signal`
      : `attempt ${attempt} of ${maxAttempts} - will retry`);
  }

  lines.push(`${mode} account`);
  await safely(send, lines.join('\n'), logger);
}

/**
 * A position closing.
 *
 * Nothing reported these before, so the first news of a losing trade was the
 * next time someone opened the dashboard.
 */
async function alertTradeClosed({
  symbol, side, lot, ticket, mode, pnl, entry, exit, digits,
  strategy, timeframe, heldMinutes, exitReason, dayPnl,
  send = sendAlert, logger = console
}) {
  const won = Number(pnl) >= 0;
  const lines = [
    `${won ? 'WIN' : 'LOSS'} ${side} ${lot} ${symbol}${timeframe ? ` ${timeframe}` : ''}` +
    `  ${won ? '+' : ''}${Number(pnl).toFixed(2)}`
  ];

  if (strategy) lines.push(`strategy: ${strategy}`);

  const e = px(entry, digits);
  const x = px(exit, digits);
  if (e && x) lines.push(`${e} -> ${x}`);

  if (exitReason) {
    const words = { SL: 'stop loss', TP: 'target hit', TIME: 'time stop', BROKER: 'closed at broker' };
    lines.push(`exit: ${words[exitReason] || exitReason}`);
  }

  if (Number.isFinite(Number(heldMinutes))) {
    const m = Math.round(Number(heldMinutes));
    lines.push(`held ${m < 60 ? `${m}m` : `${(m / 60).toFixed(1)}h`}`);
  }

  // The day's running total, so a single loss can be read in proportion.
  if (Number.isFinite(Number(dayPnl))) {
    lines.push(`today: ${Number(dayPnl) >= 0 ? '+' : ''}${Number(dayPnl).toFixed(2)}`);
  }

  lines.push(`${mode} account, ticket ${ticket}`);
  await safely(send, lines.join('\n'), logger);
}

/**
 * The day so far, sent once a position closes.
 *
 * A single close is unreadable on its own: -1,392 is a disaster or a rounding
 * error depending on what the other eleven trades did, and that context only
 * existed on a screen nobody was looking at. This is the running scoreboard,
 * so the number in the message above it can be read in proportion.
 *
 * Deliberately sent per RECONCILE CYCLE rather than per trade. Three
 * positions closing on the same tick would otherwise produce three identical
 * summaries, and a summary that repeats stops being read.
 */
async function alertDaySummary({
  mode, closedNow = 0, trades = [], openPositions = null,
  send = sendAlert, logger = console
}) {
  const net = trades.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  const wins = trades.filter((t) => Number(t.pnl) > 0);
  const losses = trades.filter((t) => Number(t.pnl) <= 0);
  const grossWin = wins.reduce((sum, t) => sum + Number(t.pnl), 0);
  const grossLoss = losses.reduce((sum, t) => sum + Number(t.pnl), 0);

  const lines = [
    `TODAY so far  ${net >= 0 ? '+' : ''}${net.toFixed(2)}`,
    `${trades.length} closed (${wins.length}W / ${losses.length}L)` +
      (closedNow > 1 ? `, ${closedNow} of them just now` : '')
  ];

  if (trades.length > 0) {
    lines.push(`won ${grossWin.toFixed(2)}  |  lost ${grossLoss.toFixed(2)}`);

    // Profit factor on the day. One number that says whether the winners are
    // actually paying for the losers, which the net alone hides on a day that
    // is barely positive off a handful of large swings.
    if (grossLoss < 0) {
      lines.push(`profit factor ${(grossWin / Math.abs(grossLoss)).toFixed(2)}`);
    }

    // Per strategy. When a day goes wrong it is almost never every strategy
    // at once, and this is what says which one to switch off.
    const byStrategy = new Map();
    for (const t of trades) {
      const key = t.strategy || 'unknown';
      const seen = byStrategy.get(key) || { pnl: 0, n: 0 };
      seen.pnl += Number(t.pnl || 0);
      seen.n += 1;
      byStrategy.set(key, seen);
    }
    const ranked = [...byStrategy.entries()].sort((a, b) => a[1].pnl - b[1].pnl);
    lines.push('by strategy:');
    for (const [name, s] of ranked) {
      lines.push(`  ${name} ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)} (${s.n})`);
    }

    const worst = ranked[0];
    const best = ranked[ranked.length - 1];
    if (worst && best && worst[0] !== best[0]) {
      lines.push(`best ${best[0]}, worst ${worst[0]}`);
    }
  }

  if (Number.isFinite(Number(openPositions))) {
    lines.push(`${openPositions} still open`);
  }

  lines.push(`${mode} account`);
  await safely(send, lines.join('\n'), logger);
}

/**
 * A combination entering or leaving service.
 *
 * Worth a message because it changes what the account will do next without
 * anyone touching it: a strategy that was not trading an hour ago starts, or
 * one that was stops. Both are the sort of thing you want to hear about
 * before you notice it in the trade list.
 */
async function alertLifecycle({
  stage, strategy, symbol, timeframe, detail, params = null,
  send = sendAlert, logger = console
}) {
  const heading = stage === 'enabled'
    ? `ENABLED ${strategy} on ${symbol} ${timeframe}`
    : `DEMOTED ${strategy} on ${symbol} ${timeframe}`;

  const lines = [heading];
  if (detail) lines.push(detail);

  // The numbers it will actually trade with. A promotion is evidence about a
  // specific parameter set, and naming them is what makes the claim checkable.
  if (params) {
    const shown = Object.entries(params)
      .filter(([k]) => /atr(Stop|Target)Multiple|maxHoldBars/.test(k))
      .map(([k, v]) => `${k.replace('atr', '').replace('Multiple', '').toLowerCase()} ${v}`)
      .join(', ');
    if (shown) lines.push(`parameters: ${shown}`);
  }

  lines.push(stage === 'enabled'
    ? 'it will trade this symbol and timeframe only'
    : 'back to research; it will not trade until it passes again');

  await safely(send, lines.join('\n'), logger);
}

async function alertDailyLossCap({ mode, realized, cap, send = sendAlert, logger = console }) {
  await safely(
    send,
    `DAILY LOSS CAP reached on ${mode}\n` +
    `realized ${Number(realized).toFixed(2)} against a cap of ${Number(cap).toFixed(2)}\n` +
    'No further trades today.',
    logger
  );
}

/**
 * A tradeable setup the scanner found.
 *
 * Worded so it can never be mistaken for a fill. The scanner does not trade -
 * it reports - and a message that reads like an execution would send someone
 * to their broker looking for a position that is not there.
 */
async function alertOpportunity({
  symbol, side, timeframe, strategy, score, lot, riskAmount, levels, mode, digits,
  scoreComponents, evidence,
  send = sendAlert, logger = console
}) {
  const arrow = side === 'BUY' ? '▲' : '▼';
  const lines = [
    `${arrow} SETUP - NOT TRADED ${side} ${symbol} ${timeframe}`,
    `strategy: ${strategy}  |  score ${score}/100`
  ];

  const line = levelLine({ entry: levels?.entry, sl: levels?.sl, tp: levels?.tp, digits });
  if (line) lines.push(line);

  const rr = rMultiple(levels?.entry, levels?.sl, levels?.tp);
  if (rr) lines.push(`reward:risk ${rr}R`);

  lines.push(`would be ${lot} lots risking ${Number(riskAmount || 0).toFixed(2)} on ${mode}`);

  // Whether this exact combination has ever passed a walk-forward test. A
  // score of 79 on an untested pairing means something quite different from
  // the same score on a validated one, and the number alone hides that.
  if (evidence) {
    lines.push(evidence.passed
      ? 'backtest: this symbol/timeframe has passed out of sample'
      : `backtest: ${evidence.runs} run(s), none passed out of sample`);
  } else {
    lines.push('backtest: this combination has never been tested');
  }

  if (Array.isArray(scoreComponents) && scoreComponents.length > 0) {
    lines.push(scoreComponents
      .map((c) => `${c.name} ${Math.round(c.weight * c.ratio)}/${c.weight}`)
      .join(', '));
  }

  await safely(send, lines.join('\n'), logger);
}

module.exports = {
  alertKillSwitch,
  alertOrderFilled,
  alertOrderFailed,
  alertTradeClosed,
  alertDaySummary,
  alertLifecycle,
  alertDailyLossCap,
  alertOpportunity
};
