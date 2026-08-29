require('./helpers/no-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createScheduler } = require('../src/scheduler');

function fakeBridge() {
  return { candles: async () => ({ server_utc_offset_seconds: 0, candles: [] }) };
}

test('runOnce reports what each phase did', async () => {
  const calls = [];
  const scheduler = createScheduler({
    bridge: fakeBridge(),
    syncCandlesFn: async () => { calls.push('sync'); return { received: 5, stored: 5 }; },
    listSymbolsFn: async () => [{ id: 1, broker_symbol: 'EURUSD' }],
    generateSignalsFn: async () => { calls.push('generate'); return { evaluated: 1, created: 1, skipped: 0 }; },
    expireStaleSignalsFn: async () => { calls.push('expire'); return 2; },
    executeFn: async () => { calls.push('execute'); return { attempted: 0, filled: 0, skipped: 0, failed: 0 }; },
    reconcileFn: async () => { calls.push('reconcile'); return { openAtBroker: 0, closed: 0, updated: 0, orphans: [] }; },
    ensureBridgeConnectedFn: async () => ({ connected: true, reconnected: false }),
    checkDiskFn: async () => ({ freeGb: 100 })
  });

  const result = await scheduler.runOnce();

  assert.deepEqual(calls, ['sync', 'generate', 'reconcile', 'expire'],
    'reconcile runs every tick; execution is off by default');
  assert.equal(result.symbolsSynced, 1);
  assert.equal(result.signals.created, 1);
  assert.equal(result.execution.disabled, true, 'execution is opt-in');
  assert.equal(result.expired, 2);
});

test('ticks never overlap', async () => {
  let active = 0;
  let maxActive = 0;

  const scheduler = createScheduler({
    bridge: fakeBridge(),
    intervalMs: 10,
    syncCandlesFn: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
      return { received: 0, stored: 0 };
    },
    listSymbolsFn: async () => [{ id: 1, broker_symbol: 'EURUSD' }],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0,
    executeFn: async () => ({ attempted: 0, filled: 0, skipped: 0, failed: 0 }),
    reconcileFn: async () => ({ openAtBroker: 0, closed: 0, updated: 0, orphans: [] }),
    ensureBridgeConnectedFn: async () => ({ connected: true, reconnected: false }),
    checkDiskFn: async () => ({ freeGb: 100 })
  });

  scheduler.start();
  await new Promise((r) => setTimeout(r, 200));
  scheduler.stop();

  assert.equal(maxActive, 1, 'a slow tick must not have another running behind it');
});

test('a failing tick is contained and the scheduler keeps running', async () => {
  let ticks = 0;
  const scheduler = createScheduler({
    bridge: fakeBridge(),
    intervalMs: 10,
    syncCandlesFn: async () => { ticks += 1; throw new Error('bridge is down'); },
    listSymbolsFn: async () => [{ id: 1, broker_symbol: 'EURUSD' }],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0,
    executeFn: async () => ({ attempted: 0, filled: 0, skipped: 0, failed: 0 }),
    reconcileFn: async () => ({ openAtBroker: 0, closed: 0, updated: 0, orphans: [] }),
    ensureBridgeConnectedFn: async () => ({ connected: true, reconnected: false }),
    checkDiskFn: async () => ({ freeGb: 100 }),
    // The failures here are deliberate; keep them out of the test output.
    logger: { error: () => {} }
  });

  scheduler.start();
  await new Promise((r) => setTimeout(r, 120));
  scheduler.stop();

  assert.ok(ticks >= 2, 'an error on one tick must not stop the schedule');
});

test('stop halts the schedule and isRunning reflects it', async () => {
  let ticks = 0;
  const scheduler = createScheduler({
    bridge: fakeBridge(),
    intervalMs: 10,
    syncCandlesFn: async () => { ticks += 1; return { received: 0, stored: 0 }; },
    listSymbolsFn: async () => [{ id: 1, broker_symbol: 'EURUSD' }],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0,
    executeFn: async () => ({ attempted: 0, filled: 0, skipped: 0, failed: 0 }),
    reconcileFn: async () => ({ openAtBroker: 0, closed: 0, updated: 0, orphans: [] }),
    ensureBridgeConnectedFn: async () => ({ connected: true, reconnected: false }),
    checkDiskFn: async () => ({ freeGb: 100 })
  });

  assert.equal(scheduler.isRunning(), false);
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);

  await new Promise((r) => setTimeout(r, 60));
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);

  const after = ticks;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ticks, after, 'no further ticks after stop');
});

test('start is idempotent', async () => {
  const scheduler = createScheduler({
    bridge: fakeBridge(),
    intervalMs: 10,
    syncCandlesFn: async () => ({ received: 0, stored: 0 }),
    listSymbolsFn: async () => [],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0,
    executeFn: async () => ({ attempted: 0, filled: 0, skipped: 0, failed: 0 }),
    reconcileFn: async () => ({ openAtBroker: 0, closed: 0, updated: 0, orphans: [] }),
    ensureBridgeConnectedFn: async () => ({ connected: true, reconnected: false }),
    checkDiskFn: async () => ({ freeGb: 100 })
  });

  scheduler.start();
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false, 'one stop is enough after two starts');
});

test('execution runs only when explicitly enabled', async () => {
  const calls = [];
  const base = {
    bridge: fakeBridge(),
    syncCandlesFn: async () => ({ received: 0, stored: 0 }),
    listSymbolsFn: async () => [],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0,
    executeFn: async () => { calls.push('execute'); return { attempted: 1, filled: 1, skipped: 0, failed: 0 }; },
    reconcileFn: async () => ({ openAtBroker: 0, closed: 0, updated: 0, orphans: [] }),
    ensureBridgeConnectedFn: async () => ({ connected: true, reconnected: false }),
    checkDiskFn: async () => ({ freeGb: 100 })
  };

  const off = createScheduler({ ...base, executionEnabled: false });
  const offResult = await off.runOnce();
  assert.deepEqual(calls, [], 'no order path is touched while execution is off');
  assert.equal(offResult.execution.disabled, true);

  const on = createScheduler({ ...base, executionEnabled: true });
  const onResult = await on.runOnce();
  assert.deepEqual(calls, ['execute']);
  assert.equal(onResult.execution.filled, 1);
});

test('a down broker link skips the cycle rather than trading blind', async () => {
  const touched = [];
  const scheduler = createScheduler({
    bridge: fakeBridge(),
    ensureBridgeConnectedFn: async () => ({ connected: false, reconnected: false }),
    checkDiskFn: async () => ({ freeGb: 100 }),
    syncCandlesFn: async () => { touched.push('sync'); return { received: 0, stored: 0 }; },
    listSymbolsFn: async () => { touched.push('symbols'); return []; },
    generateSignalsFn: async () => { touched.push('generate'); return { evaluated: 0, created: 0, skipped: 0 }; },
    expireStaleSignalsFn: async () => 0,
    executeFn: async () => { touched.push('execute'); return { attempted: 0, filled: 0, skipped: 0, failed: 0 }; },
    reconcileFn: async () => { touched.push('reconcile'); return { openAtBroker: 0, closed: 0, updated: 0, orphans: [] }; }
  });

  const result = await scheduler.runOnce();

  assert.equal(result.bridgeDown, true);
  assert.deepEqual(touched, [], 'nothing runs against a broker we cannot reach');
});

test('the tick reports free disk so an unattended run can be watched', async () => {
  const scheduler = createScheduler({
    bridge: fakeBridge(),
    ensureBridgeConnectedFn: async () => ({ connected: true, reconnected: false }),
    checkDiskFn: async () => ({ freeGb: 42.5 }),
    syncCandlesFn: async () => ({ received: 0, stored: 0 }),
    listSymbolsFn: async () => [],
    generateSignalsFn: async () => ({ evaluated: 0, created: 0, skipped: 0 }),
    expireStaleSignalsFn: async () => 0,
    executeFn: async () => ({ attempted: 0, filled: 0, skipped: 0, failed: 0 }),
    reconcileFn: async () => ({ openAtBroker: 0, closed: 0, updated: 0, orphans: [] })
  });

  const result = await scheduler.runOnce();
  assert.equal(result.diskFreeGb, 42.5);
  assert.equal(result.bridgeDown, false);
});
