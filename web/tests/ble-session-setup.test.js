const test = require('node:test');
const assert = require('node:assert/strict');
const DeviceConfig = require('../device-config.js');
const { create } = require('../ble-session-setup.js');

function createHarness() {
  let connected = true;
  let guardActive = false;
  let guard = { w: 1, x: 0, y: 0, z: 0 };
  let settings = null;
  const commands = [];
  let sequence = 0;
  let rejectConfig = false;
  let disconnectAfterConfigAck = false;

  function stateBytes() {
    const bytes = new Uint8Array(DeviceConfig.STATE_LENGTH);
    const view = new DataView(bytes.buffer);
    bytes[0] = DeviceConfig.MAGIC;
    bytes[1] = DeviceConfig.VERSION;
    bytes[2] = sequence;
    bytes[3] = (settings ? 1 : 0) | (guardActive ? 2 : 0);
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
      if (command === 0x04) guardActive = false;
      if (command === 0x03) guardActive = true;
      return connected;
    },
    async readState() { return stateBytes(); },
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
  const config = { difficulty: 'dry_pitch', bowled_prob: 3, edge_base_prob: 10, capture_window_ms: 525 };
  const setup = create({
    commandWriter: writer,
    isConnected: () => connected,
    getConfig: () => config,
    encodeConfig: DeviceConfig.encode,
    decodeState: DeviceConfig.decode,
    configMatches: DeviceConfig.matches,
    createStabilityTracker: () => ({
      observe: (_pose, timestamp) => ({ stable: timestamp >= 3000, pose: { w: 1, x: 0, y: 0, z: 0 }, remainingMs: Math.max(0, 3000 - timestamp) }),
    }),
  });

  return {
    setup, config, commands,
    setConnected(value) { connected = value; },
    setGuard(value, pose = guard) { guardActive = value; guard = pose; },
    setRejectConfig(value) { rejectConfig = value; },
    disconnectAfterConfigAck(value) { disconnectAfterConfigAck = value; },
    stateBytes,
  };
}

test('START readiness requires an exact device config acknowledgement and a verified stance', async () => {
  const harness = createHarness();
  assert.equal(harness.setup.isReady(), false);
  await harness.setup.syncConfig(harness.config);
  assert.equal(harness.setup.configReady, true);
  assert.equal(harness.setup.isReady(), false, 'an acknowledged config alone is not a session stance');

  const calibration = harness.setup.calibrateStance();
  await new Promise(resolve => setImmediate(resolve));
  harness.setup.observeStanceSample({ w: 1, x: 0, y: 0, z: 0 }, 0);
  harness.setup.observeStanceSample({ w: 1, x: 0, y: 0, z: 0 }, 3000);
  const stance = await calibration;

  assert.deepEqual(stance, { w: 1, x: 0, y: 0, z: 0 });
  assert.equal(harness.setup.isReady(), true);
  assert.deepEqual(harness.commands.slice(0, 2), [0x04, 0x03], 'old guard is cleared before stance is stored');
});

test('disconnect resets config and stance readiness for the next BLE session', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  const calibration = harness.setup.calibrateStance();
  await new Promise(resolve => setImmediate(resolve));
  harness.setup.observeStanceSample({ w: 1, x: 0, y: 0, z: 0 }, 0);
  harness.setup.observeStanceSample({ w: 1, x: 0, y: 0, z: 0 }, 3000);
  await calibration;
  assert.equal(harness.setup.isReady(), true);

  harness.setConnected(false);
  harness.setup.resetSession();
  assert.equal(harness.setup.configReady, false);
  assert.equal(harness.setup.stanceReference, null);
  assert.equal(harness.setup.isReady(), false);
});

test('an unchanged acknowledged config keeps the verified stance for the session', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  const calibration = harness.setup.calibrateStance();
  await new Promise(resolve => setImmediate(resolve));
  harness.setup.observeStanceSample({ w: 1, x: 0, y: 0, z: 0 }, 0);
  harness.setup.observeStanceSample({ w: 1, x: 0, y: 0, z: 0 }, 3000);
  await calibration;

  const result = await harness.setup.syncConfig({ ...harness.config });
  assert.equal(result.stanceReference.w, 1);
  assert.equal(harness.setup.isReady(), true);
});

test('a changed config invalidates firmware and browser stance readiness', async () => {
  const harness = createHarness();
  await harness.setup.syncConfig(harness.config);
  const calibration = harness.setup.calibrateStance();
  await new Promise(resolve => setImmediate(resolve));
  harness.setup.observeStanceSample({ w: 1, x: 0, y: 0, z: 0 }, 0);
  harness.setup.observeStanceSample({ w: 1, x: 0, y: 0, z: 0 }, 3000);
  await calibration;

  const changed = { ...harness.config, capture_window_ms: 600 };
  const result = await harness.setup.syncConfig(changed);
  assert.equal(result.stanceReference, null);
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
