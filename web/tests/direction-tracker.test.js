const test = require('node:test');
const assert = require('node:assert/strict');
const { create, directionFor, trailSegments } = require('../direction-tracker.js');

function axisAngle(axis, degrees) {
  const half = degrees * Math.PI / 360;
  const sine = Math.sin(half);
  return { w: Math.cos(half), x: axis.x*sine, y: axis.y*sine, z: axis.z*sine };
}

function multiply(a, b) {
  return {
    w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
    x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
    y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
    z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
  };
}

function conjugate(q) {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

function firmwareRelative(localOrientation, guardOrientation) {
  // q_current * inverse(q_guard), as emitted by the firmware.
  return multiply(multiply(guardOrientation, localOrientation), conjugate(guardOrientation));
}

test('the first sample calibrates the pointer at screen center', () => {
  const tracker = create();
  const result = tracker.add(axisAngle({ x: 0, y: 0, z: 1 }, 60));
  assert.deepEqual(result, { x: 0, y: 0, dx: 0, dy: 0, moved: false, heading: 0 });
  assert.deepEqual(tracker.points, [{ x: 0, y: 0 }]);
});

test('LCD-facing bat mount maps batter-right motion to screen-right and ignores bat-axis X roll', () => {
  const right = create();
  right.add({ w: 1, x: 0, y: 0, z: 0 });
  const rightward = right.add(axisAngle({ x: 0, y: 0, z: 1 }, 12));
  assert.ok(rightward.x > 0);
  assert.equal(directionFor(rightward.dx, rightward.dy).label, 'Right');

  const left = create();
  left.add({ w: 1, x: 0, y: 0, z: 0 });
  const leftward = left.add(axisAngle({ x: 0, y: 0, z: 1 }, -12));
  assert.ok(leftward.x < 0);
  assert.equal(directionFor(leftward.dx, leftward.dy).label, 'Left');

  const roll = create();
  roll.add({ w: 1, x: 0, y: 0, z: 0 });
  assert.equal(roll.add(axisAngle({ x: 1, y: 0, z: 0 }, 30)).moved, false);
});

test('cross-bat axis Y tilt moves the arrow in the corrected mounting frame', () => {
  const down = create();
  down.add({ w: 1, x: 0, y: 0, z: 0 });
  const downResult = down.add(axisAngle({ x: 0, y: 1, z: 0 }, 12));
  assert.ok(downResult.y < 0);
  assert.equal(directionFor(downResult.dx, downResult.dy).label, 'Up');

  const up = create();
  up.add({ w: 1, x: 0, y: 0, z: 0 });
  const upResult = up.add(axisAngle({ x: 0, y: 1, z: 0 }, -12));
  assert.ok(upResult.y > 0);
  assert.equal(directionFor(upResult.dx, upResult.dy).label, 'Down');
});

test('screen directions stay aligned after the bat is turned', () => {
  const tracker = create();
  tracker.add({ w: 1, x: 0, y: 0, z: 0 });
  tracker.add(axisAngle({ x: 1, y: 0, z: 0 }, 45));

  // Pitch around the guarded screen's Y axis after yawing. The incremental
  // change should remain vertical instead of rotating with the bat's body.
  const pitched = multiply(
    axisAngle({ x: 0, y: 1, z: 0 }, -10),
    axisAngle({ x: 1, y: 0, z: 0 }, 45),
  );
  const movement = tracker.add(pitched);
  assert.ok(Math.abs(movement.dx) < 1e-8);
  assert.ok(movement.dy > 0);
  assert.equal(directionFor(movement.dx, movement.dy).label, 'Down');
});

test('screen directions stay aligned when the guard pose is not identity', () => {
  const guard = axisAngle({ x: 1, y: 2, z: -1 }, 73);
  const tracker = create({ referenceQuaternion: guard });
  tracker.add({ w: 1, x: 0, y: 0, z: 0 });

  const rightTurn = axisAngle({ x: 0, y: 0, z: 1 }, 12);
  const movement = tracker.add(firmwareRelative(rightTurn, guard));
  assert.ok(movement.dx > 0, 'positive Z rotation maps to screen-right for this LCD-facing mount');
  assert.equal(directionFor(movement.dx, movement.dy).label, 'Right');
});

test('pitch stays screen-vertical and bat-axis roll is ignored after turning', () => {
  const guard = axisAngle({ x: -2, y: 1, z: 3 }, 109);
  const tracker = create({ referenceQuaternion: guard });
  const initial = axisAngle({ x: 1, y: 0, z: 0 }, 45);
  tracker.add(firmwareRelative(initial, guard));

  const turnedPitch = multiply(axisAngle({ x: 0, y: 1, z: 0 }, -10), initial);
  const pitchMovement = tracker.add(firmwareRelative(turnedPitch, guard));
  assert.ok(Math.abs(pitchMovement.dx) < 1e-8);
  assert.ok(pitchMovement.dy > 0, '+y is screen-down, matching the Down label below');
  assert.equal(directionFor(pitchMovement.dx, pitchMovement.dy).label, 'Down');

  const turnedRoll = multiply(turnedPitch, axisAngle({ x: 1, y: 0, z: 0 }, 25));
  const rollMovement = tracker.add(firmwareRelative(turnedRoll, guard));
  assert.ok(Math.abs(rollMovement.dx) < 1e-8);
  assert.ok(Math.abs(rollMovement.dy) < 1e-8);
});

test('a held orientation leaves the cursor still and a reverse turn steers back', () => {
  const tracker = create();
  tracker.add({ w: 1, x: 0, y: 0, z: 0 });
  const right = axisAngle({ x: 0, y: 0, z: 1 }, 20);
  tracker.add(right);
  const held = tracker.add(right);
  assert.equal(held.moved, false);
  assert.ok(tracker.x > 0, 'positive Z rotation moves screen-right for the documented LCD-facing mount');

  const returned = tracker.add({ w: 1, x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(returned.x) < 1e-8);
  assert.ok(Math.abs(returned.y) < 1e-8);
  assert.equal(tracker.points.length, 3);
});

test('equivalent negative quaternion signs do not create false motion', () => {
  const tracker = create();
  tracker.add({ w: 1, x: 0, y: 0, z: 0 });
  const result = tracker.add({ w: -1, x: 0, y: 0, z: 0 });
  assert.equal(result.moved, false);
  assert.deepEqual(tracker.points, [{ x: 0, y: 0 }]);
});

test('small movements and roll are ignored to keep the pointer steady', () => {
  const tracker = create();
  tracker.add({ w: 1, x: 0, y: 0, z: 0 });
  assert.equal(tracker.add(axisAngle({ x: 0, y: 0, z: 1 }, 0.1)).moved, false);
  assert.equal(tracker.add(axisAngle({ x: 1, y: 0, z: 0 }, 20)).moved, false);
  assert.deepEqual(tracker.points, [{ x: 0, y: 0 }]);
});

test('slow deliberate turns accumulate below the per-sample deadzone', () => {
  const tracker = create();
  tracker.add({ w: 1, x: 0, y: 0, z: 0 }, 0);

  for (let degrees = 0.1; degrees <= 1.0 + 1e-8; degrees += 0.1) {
    tracker.add(axisAngle({ x: 0, y: 0, z: 1 }, degrees), Math.round(degrees * 200));
  }

  assert.ok(tracker.x > 0, 'small same-direction positive-Z samples should eventually steer right');
  assert.ok(tracker.points.length > 1);
});

test('tiny persistent sensor bias expires instead of creeping the cursor', () => {
  const tracker = create();
  tracker.add({ w: 1, x: 0, y: 0, z: 0 }, 0);

  for (let sample = 1; sample <= 150; sample++) {
    tracker.add(axisAngle({ x: 0, y: 0, z: -1 }, sample * 0.02), sample * 20);
  }

  assert.equal(tracker.x, 0);
  assert.equal(tracker.y, 0);
  assert.deepEqual(tracker.points, [{ x: 0, y: 0 }]);
});

test('alternating sub-deadzone jitter cancels instead of creeping the pointer', () => {
  const tracker = create();
  tracker.add({ w: 1, x: 0, y: 0, z: 0 });

  for (let index = 0; index < 40; index++) {
    const angle = index % 2 === 0 ? 0.1 : 0;
    tracker.add(axisAngle({ x: 0, y: 0, z: -1 }, angle));
  }

  assert.equal(tracker.x, 0);
  assert.equal(tracker.y, 0);
  assert.deepEqual(tracker.points, [{ x: 0, y: 0 }]);
});

test('invalid samples are ignored without corrupting the previous orientation', () => {
  const tracker = create();
  tracker.add({ w: 1, x: 0, y: 0, z: 0 });
  assert.deepEqual(tracker.add({ w: NaN, x: 0, y: 0, z: 0 }), {
    x: tracker.x, y: tracker.y, dx: 0, dy: 0, moved: false, heading: tracker.heading,
  }, 'invalid samples return a no-movement result and leave the previous orientation intact');
  assert.ok(tracker.add(axisAngle({ x: 0, y: 0, z: 1 }, 10)).x > 0);
});

test('pointer position is bounded and trail storage stays bounded', () => {
  const tracker = create({ gain: 100, maxPoints: 5 });
  tracker.add({ w: 1, x: 0, y: 0, z: 0 });
  tracker.add(axisAngle({ x: 0, y: 0, z: 1 }, 180));
  assert.equal(tracker.x, 1, 'positive Z rotation clamps at the right edge in this mount frame');
  for (let i = 0; i < 10; i++) {
    tracker.add(axisAngle({ x: 0, y: 0, z: 1 }, i % 2 ? 179 : 180));
  }
  assert.equal(tracker.points.length, 5);
});

test('trail fades toward its origin and points in the most recent direction', () => {
  const segments = trailSegments([
    { x: 0, y: 0 },
    { x: 0.2, y: 0 },
    { x: 0.2, y: 0 },
    { x: 0.2, y: -0.2 },
  ]);

  assert.equal(segments.length, 2);
  assert.ok(segments[0].opacity < segments[1].opacity);
  assert.ok(Math.abs(segments.at(-1).angle + Math.PI / 2) < 1e-8);
  assert.deepEqual(segments.at(-1).to, { x: 0.2, y: -0.2 });
});

test('direction labels match screen coordinates', () => {
  assert.equal(directionFor(0.03, -0.02).label, 'No clear movement');
  assert.equal(directionFor(0.5, -0.5).label, 'Up-right');
  assert.deepEqual(trailSegments([{ x: 0, y: 0 }, { x: 0, y: 0 }]), []);
});
