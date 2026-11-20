const test = require('node:test');
const assert = require('node:assert/strict');
const { createStabilityTracker } = require('../stance-calibration.js');

function feedStableSamples(tracker, start, end, pose = { w: 1, x: 0, y: 0, z: 0 }, step = 100) {
  let result;
  for (let timestamp = start; timestamp <= end; timestamp += step) result = tracker.observe(pose, timestamp);
  return result;
}

test('stance is accepted only after three seconds of continuous stable samples', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxDeviationDegrees: 8 });
  const pose = { w: 1, x: 0, y: 0, z: 0 };

  assert.equal(tracker.observe(pose, 0).stable, false);
  assert.equal(feedStableSamples(tracker, 100, 2900).remainingMs, 100);
  assert.equal(tracker.observe(pose, 3000).stable, true);
});

test('small quaternion sign flips do not count as stance movement', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxDeviationDegrees: 8 });
  tracker.observe({ w: 1, x: 0, y: 0, z: 0 }, 0);
  const flipped = tracker.observe({ w: -1, x: 0, y: 0, z: 0 }, 100);
  assert.equal(flipped.moved, false);
  assert.equal(feedStableSamples(tracker, 200, 3000, { w: -1, x: 0, y: 0, z: 0 }).stable, true);
});

test('moving beyond the stance envelope restarts the full three-second hold', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxDeviationDegrees: 8 });
  const pose = { w: 1, x: 0, y: 0, z: 0 };
  const movedPose = { w: Math.cos(Math.PI / 12), x: 0, y: Math.sin(Math.PI / 12), z: 0 };
  tracker.observe(pose, 0);
  feedStableSamples(tracker, 100, 1900, pose);
  const moved = tracker.observe(movedPose, 2000);
  assert.equal(moved.stable, false);
  assert.equal(moved.moved, true);
  assert.equal(moved.remainingMs, 3000);
  assert.equal(feedStableSamples(tracker, 2100, 4900, movedPose).remainingMs, 100);
  assert.equal(tracker.observe(movedPose, 5000).stable, true);
});

test('a long sensor gap restarts the continuous-hold timer', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxDeviationDegrees: 8, maxSampleGapMs: 500 });
  const pose = { w: 1, x: 0, y: 0, z: 0 };
  tracker.observe(pose, 0);
  feedStableSamples(tracker, 100, 2900, pose);
  const afterGap = tracker.observe(pose, 3500);
  assert.equal(afterGap.stable, false);
  assert.equal(afterGap.moved, true);
  assert.equal(afterGap.remainingMs, 3000);
  assert.equal(feedStableSamples(tracker, 3600, 6400, pose).remainingMs, 100);
  assert.equal(tracker.observe(pose, 6500).stable, true);
});

test('invalid quaternions do not establish or complete a stance', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxDeviationDegrees: 8 });
  assert.equal(tracker.observe({ w: 0, x: 0, y: 0, z: 0 }, 0).valid, false);
  assert.equal(tracker.observe({ w: 1, x: 0, y: 0, z: 0 }, 100).stable, false);
  assert.equal(feedStableSamples(tracker, 200, 2900).stable, false);
});
