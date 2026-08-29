const fs = require('node:fs/promises');

/**
 * Keeps an unattended run alive.
 *
 * Reconnection is driven from here rather than from inside the bridge on
 * purpose. mt5.initialize() holds the Python GIL for the whole attempt - about
 * 70 seconds when it fails - so a retry inside a request handler would freeze
 * every other route. The scheduler tick is already non-overlapping, which
 * makes it the one safe place to pay that cost.
 */

const LOW_DISK_GB = Number(process.env.LOW_DISK_ALERT_GB || 5);

async function ensureBridgeConnected({ bridge, state, alerts, logger = console }) {
  let health;
  try {
    health = await bridge.health();
  } catch (error) {
    health = { ok: false, message: error.message };
  }

  if (health.ok) {
    if (state.bridgeDown) {
      state.bridgeDown = false;
      logger.log('bridge recovered');
      alerts.alertBridgeRecovered({}).catch(() => {});
    }
    return { connected: true, reconnected: false };
  }

  const reason = health.message || health.error || 'unknown';
  if (!state.bridgeDown) {
    state.bridgeDown = true;
    logger.error(`bridge down: ${reason}`);
    alerts.alertBridgeDown({ reason }).catch(() => {});
  }

  // Explicit retry. Blocking, which is why it lives on the tick.
  try {
    const result = await bridge.reconnect();
    if (result && result.connected) {
      state.bridgeDown = false;
      logger.log('bridge reconnected');
      alerts.alertBridgeRecovered({}).catch(() => {});
      return { connected: true, reconnected: true };
    }
  } catch (error) {
    logger.error(`reconnect attempt failed: ${error.message}`);
  }

  return { connected: false, reconnected: false };
}

async function checkDisk({ path = process.cwd(), state, alerts, thresholdGb = LOW_DISK_GB, logger = console }) {
  try {
    const stats = await fs.statfs(path);
    const freeGb = (stats.bsize * stats.bavail) / 1024 ** 3;

    if (freeGb < thresholdGb) {
      // Alert once per crossing, not every minute for a fortnight.
      if (!state.lowDisk) {
        state.lowDisk = true;
        logger.error(`low disk: ${freeGb.toFixed(1)} GB free`);
        alerts.alertLowDisk({ freeGb, thresholdGb }).catch(() => {});
      }
    } else {
      state.lowDisk = false;
    }
    return { freeGb };
  } catch (error) {
    logger.error(`disk check failed: ${error.message}`);
    return { freeGb: null };
  }
}

module.exports = { ensureBridgeConnected, checkDisk, LOW_DISK_GB };
