const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../stream-recovery.js');

test('manual readiness starts a stream that has never delivered a packet', async () => {
  let connected = true;
  let lastPacketTime = 0;
  let sequence = 0;
  let starts = 0;
  const recovery = create({
    isConnected: () => connected,
    getLastPacketTime: () => lastPacketTime,
    sendStartCommand: async () => { starts++; return true; },
    getSequence: () => sequence,
    waitForPacket: async (_count, _timeout, after) => {
      assert.equal(after, sequence);
      sequence++;
      lastPacketTime = 25;
      return true;
    },
  });

  assert.equal(await recovery.ensureFreshPacket(25, 1500), true);
  assert.equal(starts, 1);
});

test('manual readiness fails clearly when restarting still yields no packet', async () => {
  let starts = 0;
  const recovery = create({
    isConnected: () => true,
    getLastPacketTime: () => 0,
    sendStartCommand: async () => { starts++; return true; },
    getSequence: () => 0,
    waitForPacket: async () => false,
  });

  assert.equal(await recovery.ensureFreshPacket(25, 1500), false);
  assert.equal(starts, 1);
  assert.equal(recovery.pending, false);
  assert.equal(recovery.attempts, 1);
});

test('manual readiness reuses a recent stream without restarting it', async () => {
  let starts = 0;
  const recovery = create({
    isConnected: () => true,
    getLastPacketTime: () => 900,
    sendStartCommand: async () => { starts++; return true; },
  });

  assert.equal(await recovery.ensureFreshPacket(1000, 1500), true);
  assert.equal(starts, 0);
});

test('calibration can require a packet newer than a BLE-command checkpoint', async () => {
  let sequence = 4;
  let starts = 0;
  const recovery = create({
    isConnected: () => true,
    getLastPacketTime: () => 99,
    sendStartCommand: async () => { starts++; return true; },
    getSequence: () => sequence,
    waitForPacket: async (_count, _timeout, after) => {
      assert.equal(after, 4);
      if (starts) sequence++;
      return starts > 0;
    },
  });

  assert.equal(await recovery.ensureFreshPacket(100, 1500, 4), true);
  assert.equal(starts, 1, 'a recent pre-command packet cannot satisfy post-command calibration readiness');
});
