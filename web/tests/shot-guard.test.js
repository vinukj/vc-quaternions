const test = require('node:test');
const assert = require('node:assert/strict');
const { capture, CLEAR_GUARD, TAKE_GUARD } = require('../shot-guard.js');

function fakePacketGate() {
  let sequence = 0;
  return {
    get sequence() { return sequence; },
    async waitFor(count) {
      sequence += count;
      return true;
    },
  };
}

test('Take Guard snapshots the current pose and waits for fresh packets at both transitions', async () => {
  const commands = [];
  const waits = [];
  const packetGate = {
    sequence: 0,
    async waitFor(count, timeout, after) {
      waits.push({ count, timeout, after });
      this.sequence += count;
      return true;
    },
  };
  let pose = { w: 0.9, x: 0.1, y: 0.2, z: 0.3 };
  const reference = await capture({
    packetGate,
    sendCommand: async command => { commands.push(command); return true; },
    getQuaternion: () => pose,
  });

  assert.deepEqual(commands, [CLEAR_GUARD, TAKE_GUARD]);
  assert.deepEqual(reference, pose);
  assert.notEqual(reference, pose, 'the baseline is copied, not aliased to mutable sensor state');
  assert.deepEqual(waits.map(wait => wait.count), [3, 3]);
  assert.ok(waits.every(wait => wait.timeout === 2500));
});

test('the next shot uses a newly captured post-shot stance, not the old reference', async () => {
  const packetGate = fakePacketGate();
  const commands = [];
  let pose = { w: 1, x: 0, y: 0, z: 0 };
  const options = {
    packetGate,
    sendCommand: async command => { commands.push(command); return true; },
    getQuaternion: () => pose,
  };

  const firstGuard = await capture(options);
  pose = { w: 0.7071068, x: 0, y: 0.7071068, z: 0 };
  const nextShotGuard = await capture(options);

  assert.deepEqual(firstGuard, { w: 1, x: 0, y: 0, z: 0 });
  assert.deepEqual(nextShotGuard, pose);
  assert.notDeepEqual(nextShotGuard, firstGuard);
  assert.deepEqual(commands, [CLEAR_GUARD, TAKE_GUARD, CLEAR_GUARD, TAKE_GUARD]);
});

test('fails safely when clearing the guard does not produce fresh sensor data', async () => {
  await assert.rejects(capture({
    packetGate: { sequence: 0, waitFor: async () => false },
    sendCommand: async () => true,
    getQuaternion: () => ({ w: 1, x: 0, y: 0, z: 0 }),
  }), /fresh data after clearing/);
});

test('explains how to recover when the BLE guard-clear write fails', async () => {
  await assert.rejects(capture({
    packetGate: fakePacketGate(),
    sendCommand: async () => false,
  }), /Close any other PowerplAi tab connected to this bat, then press START to retry/);
});

test('does not set the guard when the current pose is invalid', async () => {
  const commands = [];
  await assert.rejects(capture({
    packetGate: fakePacketGate(),
    sendCommand: async command => { commands.push(command); return true; },
    getQuaternion: () => ({ w: 0, x: 0, y: 0, z: 0 }),
  }), /valid sensor pose/);
  assert.deepEqual(commands, [CLEAR_GUARD]);
});
