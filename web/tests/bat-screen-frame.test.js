const test = require('node:test');
const assert = require('node:assert/strict');
const { rotationToScreen } = require('../bat-screen-frame.js');

test('positive sensor Z maps to screen-right, which is Point for a right-handed batter', () => {
  assert.deepEqual(rotationToScreen({ x: 0, y: 0, z: 1 }), { x: 1, y: -0 });
  assert.deepEqual(rotationToScreen({ x: 0, y: 0, z: -1 }), { x: -1, y: -0 });
});
