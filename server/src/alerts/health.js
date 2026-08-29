const { sendAlert } = require('./notifier');

/**
 * Health events for an unattended run.
 *
 * The demo period is two weeks of nobody watching the screen. A silent
 * failure - the broker link dropping, the disk filling - is worse than a
 * loud one, because the dashboard keeps looking healthy while nothing trades.
 */

async function safely(send, text, logger) {
  try {
    await send(text);
  } catch (error) {
    logger.error(`alert failed: ${error.message}`);
  }
}

async function alertBridgeDown({ reason, send = sendAlert, logger = console }) {
  await safely(send, `MT5 BRIDGE DOWN: ${reason}. Trading has stopped; reconnection is being retried.`, logger);
}

async function alertBridgeRecovered({ send = sendAlert, logger = console }) {
  await safely(send, 'MT5 bridge reconnected. Trading has resumed.', logger);
}

async function alertLowDisk({ freeGb, thresholdGb, send = sendAlert, logger = console }) {
  await safely(
    send,
    `LOW DISK: ${freeGb.toFixed(1)} GB free, below the ${thresholdGb} GB threshold. ` +
    'Database writes will start failing if this runs out.',
    logger
  );
}

module.exports = { alertBridgeDown, alertBridgeRecovered, alertLowDisk };
