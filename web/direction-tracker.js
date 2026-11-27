/*
 * Rotation-controlled cursor for the live air-mouse view.
 *
 * Mount: the LCD faces the batter and sensor +X runs down the bat toward the
 * handle. Rotation around X is axial bat roll and ignored; Z and Y feed the
 * horizontal/vertical display projection. This is angular control, not
 * physical position tracking. Final direction signs need mounted-swing
 * calibration.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./bat-screen-frame.js') : root.BatScreenFrame);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DirectionTracker = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function (BatScreenFrame) {
  const DEFAULT_GAIN = 1.35;
  const DEFAULT_DEADZONE = 0.0035;
  const DEFAULT_MAX_POINTS = 180;
  const DEFAULT_ACCUMULATION_WINDOW_MS = 120;
  const MIN_MOVEMENT = 0.10;

  function normalize(q) {
    if (!q) return null;
    const length = Math.hypot(q.w, q.x, q.y, q.z);
    if (!Number.isFinite(length) || length < 1e-8) return null;
    return { w: q.w / length, x: q.x / length, y: q.y / length, z: q.z / length };
  }

  function conjugate(q) {
    return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
  }

  function multiply(a, b) {
    return {
      w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
      x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
      y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
      z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
    };
  }

  function directionFor(dx, dy) {
    const distance = Math.hypot(dx, dy);
    if (distance < MIN_MOVEMENT) return { label: 'No clear movement', distance };

    // Canvas coordinates: +x right, +y down. Eight equal direction sectors.
    const angle = Math.atan2(-dy, dx);
    const names = ['Right', 'Up-right', 'Up', 'Up-left', 'Left', 'Down-left', 'Down', 'Down-right'];
    const index = Math.round(angle / (Math.PI / 4) + 8) % 8;
    return { label: names[index], distance };
  }

  function trailSegments(points) {
    const moving = [];
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1];
      const to = points[index];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      if (Math.hypot(dx, dy) < 1e-4) continue;
      moving.push({ from, to, angle: Math.atan2(dy, dx) });
    }

    return moving.map((segment, index) => ({
      ...segment,
      opacity: moving.length === 1 ? 0.64 : 0.12 + 0.52 * index / (moving.length - 1),
    }));
  }

  function create(options = {}) {
    const gain = Number.isFinite(options.gain) ? options.gain : DEFAULT_GAIN;
    const deadzone = Number.isFinite(options.deadzone) ? options.deadzone : DEFAULT_DEADZONE;
    const maxPoints = Number.isInteger(options.maxPoints) ? Math.max(2, options.maxPoints) : DEFAULT_MAX_POINTS;
    const accumulationWindowMs = Number.isFinite(options.accumulationWindowMs)
      ? Math.max(0, options.accumulationWindowMs)
      : DEFAULT_ACCUMULATION_WINDOW_MS;
    const reference = normalize(options.referenceQuaternion) || { w: 1, x: 0, y: 0, z: 0 };
    let previous = null;
    let x = 0;
    let y = 0;
    let heading = 0;
    let pendingX = 0;
    let pendingZ = 0;
    let pendingSince = null;
    let points = [{ x: 0, y: 0 }];

    function clearPending() {
      pendingX = 0;
      pendingZ = 0;
      pendingSince = null;
    }

    function reset() {
      previous = null;
      x = 0;
      y = 0;
      heading = 0;
      clearPending();
      points = [{ x: 0, y: 0 }];
    }

    return {
      reset,
      add(quaternion, timestamp) {
        const relative = normalize(quaternion);
        if (!relative) return { x, y, dx: 0, dy: 0, moved: false, heading };
        const sampleTime = Number.isFinite(timestamp) ? timestamp : null;
        // Firmware sends q_current * inverse(q_guard), in the sensor's world
        // frame. Conjugate it into the captured guard frame so screen axes
        // stay aligned with the batter's starting stance.
        const current = normalize(multiply(multiply(conjugate(reference), relative), reference));
        if (!previous) {
          previous = current;
          clearPending();
          return { x, y, dx: 0, dy: 0, moved: false, heading };
        }
        
        // short-circuit if current == previous (with tolerance)
        if (Math.abs(current.w - previous.w) < 1e-10 &&
            Math.abs(current.x - previous.x) < 1e-10 &&
            Math.abs(current.y - previous.y) < 1e-10 &&
            Math.abs(current.z - previous.z) < 1e-10) {
          return { x, y, dx: 0, dy: 0, moved: false, heading };
        }

        // Only combine tiny rotations that arrive close together. A sustained
        // IMU bias must not eventually push the pointer across the deadzone.
        // Timestamps are optional so non-browser callers keep the prior API.
        if (pendingSince !== null && sampleTime !== null) {
          const elapsed = sampleTime - pendingSince;
          if (elapsed < 0 || elapsed > accumulationWindowMs) clearPending();
        } else if ((pendingX !== 0 || pendingZ !== 0) && pendingSince === null && sampleTime !== null) {
          pendingSince = sampleTime;
        }

        // q and -q represent the same orientation. Keep the shortest delta so
        // sign flips in the BLE float payload cannot produce cursor jumps.
        // Both orientations now use the guard/screen frame, so movement does
        // not rotate with the bat after yawing or pitching.
        let delta = normalize(multiply(current, conjugate(previous)));
        previous = current;
        if (!delta) return null;
        if (delta.w < 0) delta = { w: -delta.w, x: -delta.x, y: -delta.y, z: -delta.z };

        const vectorLength = Math.hypot(delta.x, delta.y, delta.z);
        if (vectorLength < 1e-10) {
          return { x, y, dx: 0, dy: 0, moved: false, heading };
        }

        const angle = 2 * Math.atan2(vectorLength, Math.max(0, delta.w));
        const angularVector = {
          x: angle * delta.x / vectorLength,
          y: angle * delta.y / vectorLength,
          z: angle * delta.z / vectorLength,
        };
        // A pure roll is about the bat's current long axis, not fixed X once
        // the bat has turned. Classify near-axis rotations as roll and ignore
        // them. Projecting the roll component out of every rotation is wrong:
        // after yawing, a real screen-vertical pitch also has an X-axis
        // component and projection would turn that pitch into diagonal motion.
        if (BatScreenFrame.isAxialRoll(angularVector, current)) {
          clearPending();
          return { x, y, dx: 0, dy: 0, moved: false, heading };
        }

        // Ignore axial roll around the bat's X axis. Project sensor-plane
        // rotation into the LCD-facing screen frame. Accumulate sub-deadzone samples so slow, deliberate
        // turns still move the pointer. Opposite-direction jitter cancels.
        const screen = BatScreenFrame.rotationToScreen(angularVector);
        // The shared transform includes the empirically calibrated horizontal
        // inversion for this LCD-facing mount.
        pendingX += screen.x;
        pendingZ += screen.y;
        if (pendingSince === null && sampleTime !== null) pendingSince = sampleTime;
        if (Math.hypot(pendingX, pendingZ) < deadzone) {
          return { x, y, dx: 0, dy: 0, moved: false, heading };
        }

        const dx = pendingX * gain;
        const dy = pendingZ * gain;
        clearPending();
        if (Math.hypot(dx, dy) < deadzone * gain) {
          return { x, y, dx: 0, dy: 0, moved: false, heading };
        }

        const oldX = x;
        const oldY = y;
        x = Math.max(-1, Math.min(1, x + dx));
        y = Math.max(-1, Math.min(1, y + dy));
        const actualDx = x - oldX;
        const actualDy = y - oldY;
        const moved = Math.hypot(actualDx, actualDy) > 1e-8;
        if (moved) {
          heading = Math.atan2(actualDy, actualDx);
          points.push({ x, y });
        }
        if (points.length > maxPoints) points.splice(1, points.length - maxPoints);
        return { x, y, dx: actualDx, dy: actualDy, moved, heading };
      },
      get x() { return x; },
      get y() { return y; },
      get heading() { return heading; },
      get points() { return points; },
      get livePoints() { return points; },
      get sampleCount() { return points.length; },
      result() { return directionFor(x, y); },
    };
  }

  return { create, directionFor, trailSegments, MIN_MOVEMENT };
});
