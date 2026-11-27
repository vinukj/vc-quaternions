const test = require('node:test');
const assert = require('node:assert/strict');
const DeviceConfig = require('../device-config.js');

test('encodes the versioned default game configuration as an eight-byte frame', () => {
  const frame = DeviceConfig.encode(17, {
    difficulty: 'dry_pitch', bowled_prob: 3, edge_base_prob: 10, capture_window_ms: 525,
  });
  assert.deepEqual([...frame], [0xa1, 1, 17, 0, 3, 10, 13, 2]);
});

test('decodes config acceptance and the exact firmware stance quaternion', () => {
  const bytes = new ArrayBuffer(DeviceConfig.STATE_LENGTH);
  const view = new DataView(bytes);
  view.setUint8(0, 0xa1);
  view.setUint8(1, 1);
  view.setUint8(2, 17);
  view.setUint8(3, 3);
  view.setUint8(4, 0);
  view.setUint8(5, 3);
  view.setUint8(6, 10);
  view.setUint16(7, 525, true);
  view.setUint8(9, 2 | (0 << 2));
  view.setFloat32(10, 1, true);
  const state = DeviceConfig.decode(view);
  assert.equal(DeviceConfig.matches(state, 17, {
    difficulty: 'dry_pitch', bowled_prob: 3, edge_base_prob: 10, capture_window_ms: 525,
  }), true);
  assert.equal(state.configAccepted, true);
  assert.equal(state.guardActive, true);
  assert.equal(state.imuResetStatus, 'complete');
  assert.equal(state.shotState, 'ready');
  assert.deepEqual(state.guard, { w: 1, x: 0, y: 0, z: 0 });
});

test('rejects impossible probabilities, unsupported sampling windows, and incomplete state', () => {
  assert.throws(() => DeviceConfig.encode(0, {
    difficulty: 'dry_pitch', bowled_prob: 80, edge_base_prob: 30, capture_window_ms: 525,
  }), /invalid game probabilities/);
  assert.throws(() => DeviceConfig.encode(0, {
    difficulty: 'dry_pitch', bowled_prob: 3, edge_base_prob: 10, capture_window_ms: 450,
  }), /unsupported capture window/);
  assert.throws(() => DeviceConfig.decode(new Uint8Array([0xa1, 1])), /unsupported or incomplete/);
});

test('decodes the sampling-cadence code from state byte 9 bits 4-5 for all four divisors', () => {
  for (const sampcnt of [1, 2, 3, 4]) {
    const bytes = new ArrayBuffer(DeviceConfig.STATE_LENGTH);
    const view = new DataView(bytes);
    view.setUint8(0, 0xa1);
    view.setUint8(1, 1);
    view.setUint8(9, (sampcnt - 1) << 4);
    assert.equal(DeviceConfig.decode(view).sampcnt, sampcnt);
  }
});

test('maps each sampcnt code to its BLE notify divisor and rate', () => {
  assert.equal(DeviceConfig.SAMPcnt_TO_SKIP[1], 4);
  assert.equal(DeviceConfig.SAMPcnt_TO_SKIP[4], 1);
  assert.equal(DeviceConfig.sampcntToHz(1), 50);
  assert.equal(DeviceConfig.sampcntToHz(3), 100);
  assert.equal(DeviceConfig.sampcntToHz(4), 200);
  assert.ok(Math.abs(DeviceConfig.sampcntToHz(2) - 200 / 3) < 1e-9);
});
