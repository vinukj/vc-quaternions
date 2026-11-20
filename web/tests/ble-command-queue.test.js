const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../ble-command-queue.js');

test('serializes writes and retries transient GATT operation collisions', async () => {
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const commands = [];
  const waits = [];
  let collisionsRemaining = 5;
  const characteristic = {
    async writeValueWithResponse(bytes) {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      const command = bytes[0];
      commands.push(command);
      await Promise.resolve();
      activeWrites--;
      if (command === 1 && collisionsRemaining > 0) {
        collisionsRemaining--;
        const error = new Error('GATT operation already in progress.');
        error.name = 'NetworkError';
        throw error;
      }
    },
  };
  const queue = create({
    getCharacteristic: () => characteristic,
    isConnected: () => true,
    wait: async delay => { waits.push(delay); },
  });

  const results = await Promise.all([queue.send(1), queue.send(2)]);

  assert.deepEqual(results, [true, true]);
  assert.deepEqual(commands, [1, 1, 1, 1, 1, 1, 2]);
  assert.deepEqual(waits, [100, 250, 500, 1000, 2000, 60, 60],
    'transient collisions use bounded backoff and successful commands receive the settling interval');
  assert.equal(maxActiveWrites, 1);
});

test('does not retry a permanent write error and allows the next queued write', async () => {
  const errors = [];
  let calls = 0;
  const characteristic = {
    async writeValueWithResponse() {
      calls++;
      throw new Error('Insufficient authentication');
    },
  };
  const queue = create({
    getCharacteristic: () => characteristic,
    isConnected: () => true,
    onError: error => errors.push(error.message),
    wait: async () => {},
  });

  assert.equal(await queue.send(1), false);
  assert.equal(await queue.send(2), false);
  assert.equal(calls, 2, 'permanent failures are attempted once per command');
  assert.deepEqual(errors, ['Insufficient authentication', 'Insufficient authentication']);
});

test('settles between successful characteristic writes to avoid back-to-back GATT collisions', async () => {
  const commands = [];
  const waits = [];
  const characteristic = {
    async writeValueWithResponse(bytes) { commands.push(bytes[0]); },
  };
  const queue = create({
    getCharacteristic: () => characteristic,
    isConnected: () => true,
    settleMs: 60,
    wait: async delay => { waits.push(delay); },
  });

  assert.deepEqual(await Promise.all([queue.send(0x08), queue.send(0x04), queue.send(0x03)]), [true, true, true]);
  assert.deepEqual(commands, [0x08, 0x04, 0x03]);
  assert.deepEqual(waits, [60, 60, 60], 'each completed BLE command gets a settling interval before the next');
});

test('coordinates command writes across UI tabs with the shared Web Locks manager', async () => {
  const lockTails = new Map();
  const lockManager = {
    request(name, _options, callback) {
      const prior = lockTails.get(name) || Promise.resolve();
      const current = prior.then(callback, callback);
      lockTails.set(name, current.catch(() => {}));
      return current;
    },
  };
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const characteristic = {
    async writeValueWithResponse() {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise(resolve => setImmediate(resolve));
      activeWrites--;
    },
  };
  const createTabQueue = () => create({
    getCharacteristic: () => characteristic,
    isConnected: () => true,
    lockManager,
    settleMs: 0,
  });
  const firstTab = createTabQueue();
  const secondTab = createTabQueue();

  assert.deepEqual(await Promise.all([firstTab.send(0x04), secondTab.send(0x03)]), [true, true]);
  assert.equal(maxActiveWrites, 1, 'two tabs sharing one BLE device cannot overlap command writes');
});

test('serializes device-state reads with config and command writes', async () => {
  let active = 0;
  let maximum = 0;
  const order = [];
  const enter = async name => {
    active++;
    maximum = Math.max(maximum, active);
    order.push(`${name}:start`);
    await new Promise(resolve => setImmediate(resolve));
    order.push(`${name}:end`);
    active--;
  };
  const command = {
    async writeValueWithResponse(bytes) { await enter(`write-${bytes[0]}`); },
  };
  const state = {
    async readValue() {
      await enter('read');
      return new DataView(Uint8Array.from([0xa1, 1]).buffer);
    },
  };
  const queue = create({
    getCharacteristic: () => command,
    getReadCharacteristic: () => state,
    isConnected: () => true,
    settleMs: 0,
  });

  const [written, bytes] = await Promise.all([
    queue.writeBytes(Uint8Array.from([0xa1, 1, 9, 0, 3, 10, 13, 2])),
    queue.readState(),
  ]);

  assert.equal(written, true);
  assert.deepEqual([...bytes], [0xa1, 1]);
  assert.equal(maximum, 1, 'a state read must not overlap any command/config write');
  assert.deepEqual(order, ['write-161:start', 'write-161:end', 'read:start', 'read:end']);
});
