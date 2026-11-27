const test = require('node:test');
const assert = require('node:assert/strict');
const { rotationToScreen, isAxialRoll } = require('../bat-screen-frame.js');

test('positive sensor Z maps to screen-right, which is Point for a right-handed batter', () => {
  assert.deepEqual(rotationToScreen({ x: 0, y: 0, z: 1 }), { x: 1, y: -0 });
  assert.deepEqual(rotationToScreen({ x: 0, y: 0, z: -1 }), { x: -1, y: -0 });
});

test('identifies roll around the bat axis in its current pose', () => {
  const turnedPose = { w: Math.SQRT1_2, x: 0, y: 0, z: Math.SQRT1_2 };
  assert.equal(isAxialRoll({ x: 0, y: 1, z: 0 }, turnedPose), true);
  assert.equal(isAxialRoll({ x: 0, y: 0, z: 1 }, turnedPose), false);
});
