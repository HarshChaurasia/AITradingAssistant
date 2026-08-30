const { sendAlert } = require('./notifier');

/**
 * The events worth waking someone for.
 *
 * Each helper swallows its own failures. The trading paths that call these
 * must not care whether a message was delivered.
 */

async function safely(send, text, logger) {
  try {
    await send(text);
  } catch (error) {
    logger.error(`alert failed: ${error.message}`);
  }
}

async function alertKillSwitch({ mode, reason, send = sendAlert, logger = console }) {
  await safely(send, `KILL SWITCH tripped on ${mode}: ${reason}. Trading is halted until you reset it.`, logger);
}

async function alertOrderFilled({ symbol, side, lot, ticket, mode, send = sendAlert, logger = console }) {
  await safely(send, `Filled ${side} ${lot} ${symbol} on ${mode} (ticket ${ticket}).`, logger);
}

async function alertOrderFailed({ symbol, reason, mode, send = sendAlert, logger = console }) {
  await safely(send, `Order REJECTED for ${symbol} on ${mode}: ${reason}`, logger);
}

async function alertDailyLossCap({ mode, realized, cap, send = sendAlert, logger = console }) {
  await safely(send, `Daily loss cap reached on ${mode}: realized ${realized} against a cap of ${cap}. No further trades today.`, logger);
}

/**
 * A tradeable setup the scanner found.
 *
 * Worded so it can never be mistaken for a fill. The scanner does not trade -
 * it reports - and a message that reads like an execution would send someone
 * to their broker looking for a position that is not there.
 */
async function alertOpportunity({
  symbol, side, timeframe, strategy, score, lot, riskAmount, levels, mode,
  send = sendAlert, logger = console
}) {
  const entry = levels?.entry !== undefined ? ` entry ${levels.entry}` : '';
  const stop = levels?.sl !== undefined ? ` stop ${levels.sl}` : '';
  const target = levels?.tp !== undefined && levels.tp !== null ? ` target ${levels.tp}` : '';
  await safely(
    send,
    `SETUP (not traded) ${side} ${symbol} ${timeframe} · ${strategy} · score ${score}/100
` +
    `${lot} lots risking ${Number(riskAmount || 0).toFixed(2)} on ${mode}.${entry}${stop}${target}`,
    logger
  );
}

module.exports = {
  alertKillSwitch, alertOrderFilled, alertOrderFailed, alertDailyLossCap, alertOpportunity
};
