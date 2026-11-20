const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../quaternion-packet-gate.js');

test('guard startup waits for a fresh packet run after the command completes', async () => {
  const gate = create();
  gate.notify(); // Last packet observed before the guard command.
  const afterGuardCommand = gate.sequence;
  const ready = gate.waitFor(3, 1000, afterGuardCommand);

  gate.notify(); // A delayed pre-guard notification may still be in flight.
  assert.equal(await Promise.race([ready, Promise.resolve('still-waiting')]), 'still-waiting');

  gate.notify();
  assert.equal(await Promise.race([ready, Promise.resolve('still-waiting')]), 'still-waiting');

  gate.notify();
  assert.equal(await ready, true);
});

test('a timed-out packet wait is cancelled and disconnect resolves pending waits', async () => {
  const gate = create();
  assert.equal(await gate.waitFor(1, 1), false);

  const pending = gate.waitFor(1, 1000);
  gate.cancelWaiters();
  assert.equal(await pending, false);
});
