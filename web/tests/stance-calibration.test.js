const test = require('node:test');
const assert = require('node:assert/strict');
const { createStabilityTracker } = require('../stance-calibration.js');

function feedStableSamples(tracker, start, end, pose = { w: 1, x: 0, y: 0, z: 0 }, step = 100) {
  let result;
  for (let timestamp = start; timestamp <= end; timestamp += step) result = tracker.observe(pose, timestamp);
  return result;
}

test('stance is accepted only after three seconds of continuous stable samples', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxMovementRateDegreesPerSecond: 12 });
  const pose = { w: 1, x: 0, y: 0, z: 0 };

  assert.equal(tracker.observe(pose, 0).stable, false);
  assert.equal(feedStableSamples(tracker, 100, 2900).remainingMs, 100);
  assert.equal(tracker.observe(pose, 3000).stable, true);
});

test('small quaternion sign flips do not count as stance movement', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxMovementRateDegreesPerSecond: 12 });
  tracker.observe({ w: 1, x: 0, y: 0, z: 0 }, 0);
  const flipped = tracker.observe({ w: -1, x: 0, y: 0, z: 0 }, 100);
  assert.equal(flipped.moved, false);
  assert.equal(feedStableSamples(tracker, 200, 3000, { w: -1, x: 0, y: 0, z: 0 }).stable, true);
});

test('moving beyond the stance envelope restarts the full three-second hold', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxMovementRateDegreesPerSecond: 12 });
  const pose = { w: 1, x: 0, y: 0, z: 0 };
  const movedPose = { w: Math.cos(Math.PI / 12), x: 0, y: Math.sin(Math.PI / 12), z: 0 };
  tracker.observe(pose, 0);
  feedStableSamples(tracker, 100, 1900, pose);
  const moved = tracker.observe(movedPose, 2000);
  assert.equal(moved.stable, false);
  assert.equal(moved.moved, true);
  assert.equal(moved.remainingMs, 3000);
  assert.equal(feedStableSamples(tracker, 2100, 4900, movedPose).remainingMs, 200,
    'smoothed movement may restart the timer briefly after the bat settles');
  assert.equal(feedStableSamples(tracker, 5000, 5000, movedPose).remainingMs, 100);
  assert.equal(tracker.observe(movedPose, 5100).stable, true);
});

test('slow cumulative IMU yaw drift does not restart a physically stable hold forever', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxMovementRateDegreesPerSecond: 12 });
  let result;
  for (let timestamp = 0; timestamp <= 3000; timestamp += 100) {
    const angle = timestamp * 0.004 * Math.PI / 180;
    result = tracker.observe({ w: Math.cos(angle / 2), x: 0, y: Math.sin(angle / 2), z: 0 }, timestamp);
  }
  assert.equal(result.moved, false);
  assert.equal(result.stable, true);
});

test('50 Hz quaternion jitter does not keep restarting the hold timer', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxMovementRateDegreesPerSecond: 12 });
  const jitter = [0, 0.7, -0.5, 0.6, -0.7, 0.4, -0.3, 0.5];
  let result;
  for (let timestamp = 0, i = 0; timestamp <= 3000; timestamp += 20, i++) {
    const angle = jitter[i % jitter.length] * Math.PI / 180;
    result = tracker.observe({ w: Math.cos(angle / 2), x: 0, y: Math.sin(angle / 2), z: 0 }, timestamp);
  }
  assert.equal(result.stable, true);
  assert.equal(result.remainingMs, 0);
});

test('sustained 20 degree-per-second motion restarts the hold at 50 Hz', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxMovementRateDegreesPerSecond: 12 });
  let sawMovement = false;
  for (let timestamp = 0; timestamp <= 1000; timestamp += 20) {
    const angle = timestamp * 0.02 * Math.PI / 180;
    const result = tracker.observe({ w: Math.cos(angle / 2), x: 0, y: Math.sin(angle / 2), z: 0 }, timestamp);
    sawMovement ||= result.moved;
  }
  assert.equal(sawMovement, true);
});

test('a long sensor gap restarts the continuous-hold timer', () => {
  const tracker = createStabilityTracker({ durationMs: 3000, maxMovementRateDegreesPerSecond: 12, maxSampleGapMs: 500 });
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
  const tracker = createStabilityTracker({ durationMs: 3000, maxMovementRateDegreesPerSecond: 12 });
  assert.equal(tracker.observe({ w: 0, x: 0, y: 0, z: 0 }, 0).valid, false);
  assert.equal(tracker.observe({ w: 1, x: 0, y: 0, z: 0 }, 100).stable, false);
  assert.equal(feedStableSamples(tracker, 200, 2900).stable, false);
});
