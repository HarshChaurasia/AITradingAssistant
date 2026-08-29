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

module.exports = { alertKillSwitch, alertOrderFilled, alertOrderFailed, alertDailyLossCap };
