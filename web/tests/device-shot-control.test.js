const test = require('node:test');
const assert = require('node:assert/strict');
const { create, COMMAND_SHOT_BUSY, COMMAND_SHOT_READY } = require('../device-shot-control.js');

test('a connected device request locks the LCD before starting one browser shot cycle', async () => {
  const commands = [];
  let starts = 0;
  let state = 'ready';
  const control = create({
    isConnected: () => true,
    getState: () => state,
    sendCommand: async command => { commands.push(command); return true; },
    startCycle: async () => { starts++; state = 'preparing'; return true; },
  });

  assert.equal(await control.requestStart(), true);
  assert.deepEqual(commands, [COMMAND_SHOT_BUSY]);
  assert.equal(starts, 1);
  assert.equal(await control.requestStart(), false, 'a repeated notification cannot start a second cycle');
  assert.equal(starts, 1);

  state = 'ready';
  assert.equal(await control.markReady(), true);
  assert.deepEqual(commands, [COMMAND_SHOT_BUSY, COMMAND_SHOT_READY]);
});

test('does not start when disconnected or while a shot is already in progress', async () => {
  let connected = false;
  let state = 'ready';
  let starts = 0;
  const commands = [];
  const control = create({
    isConnected: () => connected,
    getState: () => state,
    sendCommand: async command => { commands.push(command); return true; },
    startCycle: async () => { starts++; return true; },
  });

  assert.equal(await control.requestStart(), false);
  connected = true;
  state = 'capturing';
  assert.equal(await control.requestStart(), false);
  assert.equal(starts, 0);
  assert.deepEqual(commands, [], 'a rejected duplicate must not write stale state to the LCD');
});

test('blocks both browser and LCD start until config and stance are acknowledged', async () => {
  let ready = false;
  let starts = 0;
  let commands = 0;
  const control = create({
    isConnected: () => true,
    isReady: () => ready,
    getState: () => 'ready',
    sendCommand: async () => { commands++; return true; },
    startCycle: async () => { starts++; return true; },
  });

  assert.equal(await control.requestStart(), false);
  assert.equal(await control.requestDeviceStart(), false);
  assert.equal(starts, 0);
  assert.equal(commands, 0, 'a rejected LCD touch must not receive a BUSY acknowledgement');

  ready = true;
  assert.equal(await control.requestStart(), true);
  assert.equal(starts, 1);
});

test('a failed busy acknowledgement does not block START and is retried from repeated device requests', async () => {
  let time = 1000;
  let commandAttempts = 0;
  let starts = 0;
  let state = 'ready';
  const control = create({
    isConnected: () => true,
    getState: () => state,
    now: () => time,
    sendCommand: async () => ++commandAttempts > 1,
    startCycle: async () => { starts++; state = 'countdown'; return true; },
  });

  assert.equal(await control.requestStart(), true, 'browser countdown starts without waiting on LCD acknowledgement');
  assert.equal(starts, 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(commandAttempts, 1);
  assert.equal(await control.requestStart(), false, 'repeated touch flags never start a second cycle');
  assert.equal(commandAttempts, 1, 'ack retries are rate-limited');
  time += 300;
  assert.equal(await control.requestStart(), false, 'active-cycle duplicate only retries the LCD acknowledgement');
  assert.equal(commandAttempts, 2);
  assert.equal(starts, 1);
});

test('LCD start returns while the busy acknowledgement is still pending', async () => {
  let resolveBusy;
  let starts = 0;
  const control = create({
    isConnected: () => true,
    getState: () => 'ready',
    sendCommand: async () => new Promise(resolve => { resolveBusy = resolve; }),
    startCycle: async () => { starts++; return true; },
  });

  const request = control.requestStart();
  assert.equal(await request, true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(starts, 1, 'the web countdown starts while the BLE status write is pending');
  assert.equal(typeof resolveBusy, 'function');
  resolveBusy(true);
});

test('repeated asserted device START notifications create one cycle until the flag clears', async () => {
  let state = 'ready';
  let starts = 0;
  const commands = [];
  const control = create({
    isConnected: () => true,
    getState: () => state,
    sendCommand: async command => { commands.push(command); return true; },
    startCycle: async () => { starts++; state = 'countdown'; return true; },
  });

  assert.equal(await control.requestDeviceStart(), true);
  for (let index = 0; index < 30; index++) {
    assert.equal(await control.requestDeviceStart(), false);
  }
  assert.equal(starts, 1, 'a held START flag is one event, not one event per BLE packet');

  state = 'ready';
  assert.equal(await control.requestDeviceStart(), false,
    'a stale high flag cannot start another cycle after the first capture finishes');
  assert.equal(starts, 1);

  control.releaseDeviceStart();
  assert.equal(await control.requestDeviceStart(), true, 'a fresh low-to-high transition permits the next shot');
  assert.equal(starts, 2);
  assert.deepEqual(commands, [COMMAND_SHOT_BUSY, COMMAND_SHOT_BUSY],
    'each accepted cycle gets an immediate LCD busy acknowledgement');
});

test('low START packets during an active shot do not re-arm a bouncing touch request', async () => {
  let state = 'ready';
  let starts = 0;
  const control = create({
    isConnected: () => true,
    getState: () => state,
    sendCommand: async () => true,
    startCycle: async () => { starts++; state = 'countdown'; return true; },
  });

  assert.equal(await control.requestDeviceStart(), true);
  state = 'capturing';
  for (let index = 0; index < 20; index++) control.releaseDeviceStart();
  assert.equal(await control.requestDeviceStart(), false,
    'a second high edge during the capture is ignored despite intervening low packets');
  assert.equal(starts, 1);

  state = 'ready';
  assert.equal(await control.requestDeviceStart(), false,
    'the old high level remains latched until a release is observed after completion');
  control.releaseDeviceStart();
  assert.equal(await control.requestDeviceStart(), true, 'a post-cycle release allows the next physical press');
  assert.equal(starts, 2);
});

test('a low START level during capture cannot re-arm the latch before the shot returns ready', async () => {
  let state = 'ready';
  let starts = 0;
  const control = create({
    isConnected: () => true,
    getState: () => state,
    sendCommand: async () => true,
    startCycle: async () => { starts++; state = 'countdown'; return true; },
  });

  assert.equal(await control.requestDeviceStart(), true);
  state = 'capturing';
  for (let index = 0; index < 20; index++) control.releaseDeviceStart();

  state = 'ready';
  assert.equal(await control.requestDeviceStart(), false,
    'a stale high level at shot completion must not create a second history entry');
  assert.equal(starts, 1);

  control.releaseDeviceStart();
  assert.equal(await control.requestDeviceStart(), true,
    'a low level observed after READY permits the next intentional touch');
  assert.equal(starts, 2);
});
