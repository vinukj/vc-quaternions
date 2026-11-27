const test = require('node:test');
const assert = require('node:assert/strict');
const DeviceConfig = require('../device-config.js');
const { createStabilityTracker } = require('../stance-calibration.js');
const { create } = require('../ble-session-setup.js');

function createHarness(options = {}) {
  let connected = true;
  let guardActive = false;
  let guard = { w: 1, x: 0, y: 0, z: 0 };
  let shotState = options.initialShotState || 'ready';
  let settings = null;
  const commands = [];
  let sequence = 0;
  let stateReads = 0;
  let rejectConfig = false;
  let disconnectAfterConfigAck = false;
  let sampcnt = 1;
  let rejectSampcnt = false;

  function stateBytes() {
    const bytes = new Uint8Array(DeviceConfig.STATE_LENGTH);
    const view = new DataView(bytes.buffer);
    bytes[0] = DeviceConfig.MAGIC;
    bytes[1] = DeviceConfig.VERSION;
    bytes[2] = sequence;
    bytes[3] = (settings ? 1 : 0) | (guardActive ? 2 : 0);
    bytes[9] = (['ready', 'start_requested', 'in_progress', 'unknown'].indexOf(shotState) << 2) | ((sampcnt - 1) << 4);
    if (settings) {
      bytes[4] = DeviceConfig.DIFFICULTIES.indexOf(settings.difficulty);
      bytes[5] = settings.bowled_prob;
      bytes[6] = settings.edge_base_prob;
      view.setUint16(7, settings.capture_window_ms, true);
    }
    view.setFloat32(10, guard.w, true);
    view.setFloat32(14, guard.x, true);
    view.setFloat32(18, guard.y, true);
    view.setFloat32(22, guard.z, true);
    return bytes;
  }

  const writer = {
    async send(command) {
      commands.push(command);
      if (command === 0x04) {
        guardActive = false;
        if (options.clearReferenceRearmsShot !== false) shotState = 'ready';
      }
      if (command === 0x03) {
        guardActive = true;
        if (options.shotStateAfterTakeGuard) shotState = options.shotStateAfterTakeGuard;
      }
      return connected;
    },
    async readState() { stateReads++; return stateBytes(); },
    async writeBytes(payload) {
      const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
      if (bytes[0] === 0x0B) {
        if (rejectSampcnt) sampcnt = bytes[1] === 4 ? 1 : 4;
        else sampcnt = bytes[1];
      }
      return connected;
    },
    async writeAndRead(frame) {
      const nextSettings = {
        difficulty: DeviceConfig.DIFFICULTIES[frame[3]],
        bowled_prob: frame[4], edge_base_prob: frame[5],
        capture_window_ms: frame[6] | (frame[7] << 8),
      };
      const changed = settings && Object.keys(nextSettings).some(key => nextSettings[key] !== settings[key]);
      if (changed) {
        guardActive = false;
        guard = { w: 1, x: 0, y: 0, z: 0 };
      }
      settings = nextSettings;
      sequence = rejectConfig ? (frame[2] + 1) & 0xff : frame[2];
      const bytes = stateBytes();
      if (disconnectAfterConfigAck) connected = false;
      return bytes;
    },
  };
  const config = { difficulty: 'dry_pitch', bowled_prob: 3, edge_base_prob: 10, capture_window_ms: 525, sampcnt: 1 };
  const setup = create({
    commandWriter: writer,
    isConnected: () => connected,
    getConfig: () => config,
    encodeConfig: DeviceConfig.encode,
    decodeState: DeviceConfig.decode,
    configMatches: DeviceConfig.matches,
    createStabilityTracker: options.createStabilityTracker || (() => ({
      observe: (_pose, timestamp) => ({ stable: timestamp >= 3000, pose: { w: 1, x: 0, y: 0, z: 0 }, remainingMs: Math.max(0, 3000 - timestamp) }),
    })),
    getSampleSequence: options.getSampleSequence || (() => 0),
    waitForFreshSample: options.waitForFreshSample || (async () => true),
  });

  return {
    setup, config, commands,
    get stateReads() { return stateReads; },
    setConnected(value) { connected = value; },
    setGuard(value, pose = guard) { guardActive = value; guard = pose; },
    setShotState(value) { shotState = value; },
    setRejectConfig(value) { rejectConfig = value; },
    setRejectSampcnt(value) { rejectSampcnt = value; },
    setSampcnt(value) { sampcnt = value; },
    disconnectAfterConfigAck(value) { disconnectAfterConfigAck = value; },
    stateBytes,
  };
}

async function captureReference(harness, kind) {
  const capture = kind === 'orientation'
    ? harness.setup.calibrateOrientation()
    : harness.setup.calibrateStance();
  await new Promise(resolve => setImmediate(resolve));
  harness.setup.observeCalibrationSample({ w: 1, x: 0, y: 0, z: 0 }, 0);
  harness.setup.observeCalibrationSample({ w: 1, x: 0, y: 0, z: 0 }, 3000);
  return capture;
}

test('START readiness requires config ACK, bat orientation, and verified stance', async () => {
  const harness = createHarness();
  assert.equal(harness.setup.isReady(), false);
  await harness.setup.syncConfig(harness.config);
  await harness.setup.syncSampcnt(harness.config.sampcnt);
  assert.equal(harness.setup.configReady, true);
  assert.equal(harness.setup.isReady(), false, 'an acknowledged config alone is not a session stance');

  await assert.rejects(harness.setup.calibrateStance(), /bat orientation/);
  const orientation = await captureReference(harness, 'orientation');
  assert.deepEqual(orientation, { w: 1, x: 0, y: 0, z: 0 });
  assert.equal(harness.setup.isReady(), false, 'orientation alone does not enable START');
  const stance = await captureReference(harness, 'stance');

  assert.deepEqual(stance, { w: 1, x: 0, y: 0, z: 0 });
  assert.deepEqual(harness.setup.orientationReference, orientation);
  assert.equal(harness.setup.isReady(), true);
  assert.deepEqual(harness.commands, [0x04, 0x04, 0x03], 'orientation clears stale guard; stance clears then stores its guard');
});

test('orientation and stance setup re-arm and verify a stale firmware shot state', async () => {
  const harness = createHarness({ initialShotState: 'in_progress' });
  await harness.setup.syncConfig(harness.config);
  await harness.setup.syncSampcnt(harness.config.sampcnt);

  await captureReference(harness, 'orientation');
  const stance = await captureReference(harness, 'stance');

  assert.deepEqual(stance, { w: 1, x: 0, y: 0, z: 0 });
  assert.equal(DeviceConfig.decode(harness.stateBytes()).shotState, 'ready');
  assert.equal(harness.setup.isReady(), true);
});

test('browser setup refuses START if firmware does not re-arm after clearing the guard', async () => {
  const harness = createHarness({
    initialShotState: 'in_progress',
    clearReferenceRearmsShot: false,
  });
  await harness.setup.syncConfig(harness.config);

  await assert.rejects(
    harness.setup.calibrateOrientation(),
    /ready shot state/,
  );
  assert.equal(harness.setup.orientationReference, null);
  assert.equal(harness.setup.isReady(), false);
});

test('stance readback rejects a device that left READY while saving the guard', async () => {
  const harness = createHarness({ shotStateAfterTakeGuard: 'in_progress' });
  await harness.setup.syncConfig(harness.config);
  await captureReference(harness, 'orientation');
  const capture = harness.setup.calibrateStance();
  await new Promise(resolve => setImmediate(resolve));
  harness.setup.observeCalibrationSample({ w: 1, x: 0, y: 0, z: 0 }, 0);
  harness.setup.observeCalibrationSample({ w: 1, x: 0, y: 0, z: 0 }, 3000);

  await assert.rejects(capture, /device is not ready/);
  assert.equal(harness.setup.stanceReference, null);
  assert.equal(harness.setup.isReady(), false);
});

test('disconnect resets config and stance readiness for the next BLE session', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  await harness.setup.syncSampcnt(harness.config.sampcnt);
  await captureReference(harness, 'orientation');
  await captureReference(harness, 'stance');
  assert.equal(harness.setup.isReady(), true);

  harness.setConnected(false);
  harness.setup.resetSession();
  assert.equal(harness.setup.configReady, false);
  assert.equal(harness.setup.stanceReference, null);
  assert.equal(harness.setup.orientationReference, null);
  assert.equal(harness.setup.isReady(), false);
});

test('an unchanged acknowledged config keeps the verified stance for the session', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  await harness.setup.syncSampcnt(harness.config.sampcnt);
  await captureReference(harness, 'orientation');
  await captureReference(harness, 'stance');

  const result = await harness.setup.syncConfig({ ...harness.config });
  assert.equal(result.stanceReference.w, 1);
  assert.equal(result.orientationReference.w, 1);
  assert.equal(harness.setup.isReady(), true);
});

test('a changed config invalidates firmware and browser stance readiness', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  await harness.setup.syncSampcnt(harness.config.sampcnt);
  await captureReference(harness, 'orientation');
  await captureReference(harness, 'stance');

  const changed = { ...harness.config, capture_window_ms: 600 };
  const result = await harness.setup.syncConfig(changed);
  assert.equal(result.stanceReference, null);
  assert.deepEqual(result.orientationReference, { w: 1, x: 0, y: 0, z: 0 }, 'a game-setting change does not discard physical bat alignment');
  assert.equal(harness.setup.configReady, true);
  assert.equal(harness.setup.isReady(), false, 'the new settings are acknowledged but stance must be retaken');
});

test('a mismatched config readback never enables START', async () => {
  const harness = createHarness();
  harness.setRejectConfig(true);
  await assert.rejects(harness.setup.syncConfig(harness.config), /acknowledgement did not match/);
  assert.equal(harness.setup.configReady, false);
  assert.equal(harness.setup.isReady(), false);
});

test('a disconnect during config acknowledgement discards the stale response', async () => {
  const harness = createHarness();
  harness.disconnectAfterConfigAck(true);
  assert.equal(await harness.setup.syncConfig(harness.config), false);
  assert.equal(harness.setup.configReady, false);
  assert.equal(harness.setup.isReady(), false);
});

test('does not accept stance calibration before the current config is acknowledged', async () => {
  const harness = createHarness();
  await assert.rejects(harness.setup.calibrateStance(), /confirm the game settings/);
  assert.deepEqual(harness.commands, []);
});

test('retaking bat orientation clears the firmware guard and invalidates the old stance', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  await captureReference(harness, 'orientation');
  await captureReference(harness, 'stance');
  harness.setGuard(true);

  await captureReference(harness, 'orientation');

  assert.equal(harness.setup.stanceReference, null);
  assert.equal(harness.setup.isReady(), false);
  assert.deepEqual(harness.commands.slice(-1), [0x04]);
});

test('bat-orientation setup completes despite slow cumulative quaternion drift', async () => {
  const harness = createHarness({ createStabilityTracker });
  await harness.setup.syncConfig(harness.config);
  const capture = harness.setup.calibrateOrientation();
  await new Promise(resolve => setImmediate(resolve));
  for (let timestamp = 0; timestamp <= 3000; timestamp += 100) {
    const angle = timestamp * 0.004 * Math.PI / 180;
    harness.setup.observeCalibrationSample({ w: Math.cos(angle / 2), x: 0, y: Math.sin(angle / 2), z: 0 }, timestamp);
  }
  const orientation = await capture;
  assert.ok(orientation, 'orientation should finish after three seconds of low-rate drift');
  assert.ok(Math.abs(orientation.y) > 0, 'the saved reference is the normalized captured pose');
});

test('orientation stability starts only after a fresh sample follows guard readback', async () => {
  let releaseFreshSample;
  let trackerCreated = false;
  let harness;
  harness = createHarness({
    waitForFreshSample: async (afterSequence, isCurrent) => {
      assert.equal(afterSequence, 17);
      assert.deepEqual(harness.commands, [0x04]);
      assert.equal(harness.stateReads, 1, 'the guard-clear readback finishes before waiting for a fresh packet');
      await new Promise(resolve => { releaseFreshSample = resolve; });
      return isCurrent();
    },
    getSampleSequence: () => 17,
    createStabilityTracker: options => {
      trackerCreated = true;
      return createStabilityTracker(options);
    },
  });
  await harness.setup.syncConfig(harness.config);

  const capture = harness.setup.calibrateOrientation();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseFreshSample, 'function', 'calibration waits for a post-readback sample');
    assert.equal(trackerCreated, false, 'the 3-second stability clock cannot begin on stale data');

    releaseFreshSample();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(trackerCreated, true, 'the stability tracker starts once the stream proves fresh');
    for (let timestamp = 0; timestamp <= 3000; timestamp += 100) {
      harness.setup.observeCalibrationSample({ w: 1, x: 0, y: 0, z: 0 }, timestamp);
    }
    assert.deepEqual(await capture, { w: 1, x: 0, y: 0, z: 0 });
  } finally {
    releaseFreshSample?.();
    await harness.setup.cancelSetupCalibration(false);
  }
});

test('the fresh packet that releases the calibration gate seeds the three-second hold', async () => {
  let releaseFreshSample;
  let harness;
  const progress = [];
  harness = createHarness({
    waitForFreshSample: async (_afterSequence, isCurrent) => {
      await new Promise(resolve => { releaseFreshSample = resolve; });
      return isCurrent();
    },
    createStabilityTracker,
  });
  await harness.setup.syncConfig(harness.config);
  const capture = harness.setup.calibrateOrientation(value => progress.push(value));

  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseFreshSample, 'function');

    // onNotify observes the packet before packetGate.notify() releases the waiter.
    harness.setup.observeCalibrationSample({ w: 1, x: 0, y: 0, z: 0 }, 0);
    releaseFreshSample();
    await new Promise(resolve => setImmediate(resolve));
    for (let timestamp = 100; timestamp <= 3000; timestamp += 100) {
      harness.setup.observeCalibrationSample({ w: 1, x: 0, y: 0, z: 0 }, timestamp);
    }

    assert.ok(progress.some(sample => sample.remainingMs === 2900),
      'the post-readback packet is retained as the start of the stability interval');
    assert.deepEqual(await capture, { w: 1, x: 0, y: 0, z: 0 });
  } finally {
    releaseFreshSample?.();
    await harness.setup.cancelSetupCalibration(false);
  }
});

test('START stays locked until the sampling cadence is read back and verified', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  await captureReference(harness, 'orientation');
  await captureReference(harness, 'stance');
  assert.equal(harness.setup.isReady(), false, 'a verified stance is not enough without a verified cadence');

  await harness.setup.syncSampcnt(harness.config.sampcnt);
  assert.equal(harness.setup.acknowledgedSampcnt, 1);
  assert.equal(harness.setup.isReady(), true);
});

test('accepts all four sampling-cadence divisors and verifies each readback', async () => {
  for (const sampcnt of [1, 2, 3, 4]) {
    const harness = createHarness();
    await harness.setup.syncConfig(harness.config);
    await harness.setup.syncSampcnt(sampcnt);
    assert.equal(harness.setup.acknowledgedSampcnt, sampcnt);
    assert.equal(DeviceConfig.decode(harness.stateBytes()).sampcnt, sampcnt);
  }
});

test('changing the sampling cadence invalidates the stance but keeps bat orientation', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  await harness.setup.syncSampcnt(1);
  await captureReference(harness, 'orientation');
  await captureReference(harness, 'stance');
  assert.equal(harness.setup.isReady(), true);

  const result = await harness.setup.syncSampcnt(4);

  assert.equal(result.stanceReference, null, 'a cadence change requires the batting stance to be retaken');
  assert.deepEqual(result.orientationReference, { w: 1, x: 0, y: 0, z: 0 },
    'the separate bat-orientation reference survives a cadence change');
  assert.equal(harness.setup.configReady, true);
  assert.equal(harness.setup.isReady(), false);
});

test('a cadence readback mismatch never enables START', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  harness.setRejectSampcnt(true);
  await assert.rejects(harness.setup.syncSampcnt(2), /cadence readback did not match/);
  assert.equal(harness.setup.acknowledgedSampcnt, null);
  assert.equal(harness.setup.isReady(), false);
});

test('an out-of-range sampling cadence is rejected before any BLE write', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  await assert.rejects(harness.setup.syncSampcnt(5), /unsupported sampling cadence/);
  assert.deepEqual(harness.commands, []);
});
