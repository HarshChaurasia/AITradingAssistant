const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureBridgeConnected, checkDisk } = require('../src/scheduler/health');

const silent = { log: () => {}, error: () => {} };

function alertSpy() {
  const fired = [];
  return {
    fired,
    alertBridgeDown: async (a) => { fired.push(['down', a.reason]); },
    alertBridgeRecovered: async () => { fired.push(['recovered']); },
    alertLowDisk: async (a) => { fired.push(['lowDisk', a.freeGb]); }
  };
}

test('a healthy bridge needs no reconnect and raises nothing', async () => {
  const state = {};
  const alerts = alertSpy();
  let reconnects = 0;

  const result = await ensureBridgeConnected({
    bridge: { health: async () => ({ ok: true }), reconnect: async () => { reconnects += 1; } },
    state, alerts, logger: silent
  });

  assert.equal(result.connected, true);
  assert.equal(reconnects, 0);
  assert.deepEqual(alerts.fired, []);
});

test('a down bridge alerts once and is reconnected', async () => {
  const state = {};
  const alerts = alertSpy();

  const result = await ensureBridgeConnected({
    bridge: {
      health: async () => ({ ok: false, message: 'IPC timeout' }),
      reconnect: async () => ({ connected: true, message: 'ok' })
    },
    state, alerts, logger: silent
  });

  assert.equal(result.connected, true);
  assert.equal(result.reconnected, true);
  assert.deepEqual(alerts.fired[0], ['down', 'IPC timeout']);
  assert.deepEqual(alerts.fired[1], ['recovered']);
});

test('a bridge that stays down does not alert every tick', async () => {
  const state = {};
  const alerts = alertSpy();
  const bridge = {
    health: async () => ({ ok: false, message: 'terminal closed' }),
    reconnect: async () => ({ connected: false })
  };

  for (let i = 0; i < 5; i += 1) {
    await ensureBridgeConnected({ bridge, state, alerts, logger: silent });
  }

  const downAlerts = alerts.fired.filter((f) => f[0] === 'down');
  assert.equal(downAlerts.length, 1, 'one alert per outage, not one per minute for a fortnight');
});

test('recovery after a sustained outage raises exactly one recovered alert', async () => {
  const state = {};
  const alerts = alertSpy();

  const down = { health: async () => ({ ok: false, message: 'down' }), reconnect: async () => ({ connected: false }) };
  await ensureBridgeConnected({ bridge: down, state, alerts, logger: silent });
  await ensureBridgeConnected({ bridge: down, state, alerts, logger: silent });

  const up = { health: async () => ({ ok: true }), reconnect: async () => ({ connected: true }) };
  await ensureBridgeConnected({ bridge: up, state, alerts, logger: silent });
  await ensureBridgeConnected({ bridge: up, state, alerts, logger: silent });

  assert.equal(alerts.fired.filter((f) => f[0] === 'recovered').length, 1);
});

test('a health call that throws is treated as down, not as a crash', async () => {
  const state = {};
  const alerts = alertSpy();

  const result = await ensureBridgeConnected({
    bridge: {
      health: async () => { throw new Error('ECONNREFUSED'); },
      reconnect: async () => ({ connected: false })
    },
    state, alerts, logger: silent
  });

  assert.equal(result.connected, false);
  assert.match(alerts.fired[0][1], /ECONNREFUSED/);
});

test('a reconnect that throws does not propagate', async () => {
  const state = {};
  const alerts = alertSpy();

  // A blocking reconnect can time out. That must not end the scheduler.
  const result = await ensureBridgeConnected({
    bridge: {
      health: async () => ({ ok: false, message: 'down' }),
      reconnect: async () => { throw new Error('timed out after 90000ms'); }
    },
    state, alerts, logger: silent
  });

  assert.equal(result.connected, false);
});

test('low disk alerts once per crossing and rearms after recovery', async () => {
  const state = {};
  const alerts = alertSpy();

  // statfs is stubbed by pointing at a path check we control via threshold.
  const huge = await checkDisk({ path: process.cwd(), state, alerts, thresholdGb: 0, logger: silent });
  assert.ok(huge.freeGb > 0, 'free space is readable');
  assert.deepEqual(alerts.fired, [], 'nothing fires above the threshold');

  // A threshold above any real free space forces the low condition.
  await checkDisk({ path: process.cwd(), state, alerts, thresholdGb: 1e9, logger: silent });
  await checkDisk({ path: process.cwd(), state, alerts, thresholdGb: 1e9, logger: silent });
  assert.equal(alerts.fired.filter((f) => f[0] === 'lowDisk').length, 1, 'one alert per crossing');

  // Back above the threshold, then below again: it must alert a second time.
  await checkDisk({ path: process.cwd(), state, alerts, thresholdGb: 0, logger: silent });
  await checkDisk({ path: process.cwd(), state, alerts, thresholdGb: 1e9, logger: silent });
  assert.equal(alerts.fired.filter((f) => f[0] === 'lowDisk').length, 2, 'it rearms after recovery');
});

test('an unreadable path does not throw', async () => {
  const state = {};
  const alerts = alertSpy();
  const result = await checkDisk({ path: 'Z:\\definitely\\not\\here', state, alerts, logger: silent });
  assert.equal(result.freeGb, null);
});
