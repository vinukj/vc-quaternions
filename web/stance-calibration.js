/* Accept a stance only after a continuous, orientation-stable hold. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StanceCalibration = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  function normalize(pose) {
    if (!pose || ![pose.w, pose.x, pose.y, pose.z].every(Number.isFinite)) return null;
    const magnitude = Math.hypot(pose.w, pose.x, pose.y, pose.z);
    if (magnitude < 1e-8) return null;
    return { w: pose.w / magnitude, x: pose.x / magnitude, y: pose.y / magnitude, z: pose.z / magnitude };
  }

  function angleDegrees(left, right) {
    const dot = Math.abs(left.w * right.w + left.x * right.x + left.y * right.y + left.z * right.z);
    return 2 * Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
  }

  function averagePoses(poses) {
    const reference = poses[0];
    const sum = { w: 0, x: 0, y: 0, z: 0 };
    for (const pose of poses) {
      const sign = reference.w * pose.w + reference.x * pose.x + reference.y * pose.y + reference.z * pose.z < 0 ? -1 : 1;
      sum.w += pose.w * sign;
      sum.x += pose.x * sign;
      sum.y += pose.y * sign;
      sum.z += pose.z * sign;
    }
    return normalize(sum);
  }

  function createStabilityTracker(options = {}) {
    const durationMs = Number.isFinite(options.durationMs) ? Math.max(1, options.durationMs) : 3000;
    // shortcut: movement under 12°/s is treated as IMU drift; upgrade when raw gyro samples are available.
    const maxMovementRateDegreesPerSecond = Number.isFinite(options.maxMovementRateDegreesPerSecond)
      ? Math.max(0, options.maxMovementRateDegreesPerSecond) : 12;
    const maxSampleGapMs = Number.isFinite(options.maxSampleGapMs) ? Math.max(1, options.maxSampleGapMs) : 500;
    // shortcut: 120 ms smoothing can hide sub-window movement; upgrade when raw gyro samples are available.
    const smoothingWindowMs = 120;
    const movementWindowMs = 100;
    let samples = [];
    let movementHistory = [];
    let startedAt = null;
    let lastAt = null;

    function reset() {
      samples = [];
      movementHistory = [];
      startedAt = null;
      lastAt = null;
    }

    function observe(pose, timestamp) {
      const normalized = normalize(pose);
      if (!normalized || !Number.isFinite(timestamp)) {
        reset();
        return { valid: false, stable: false, moved: false, remainingMs: durationMs };
      }

      const gap = lastAt === null ? 0 : timestamp - lastAt;
      if (samples.length === 0 || gap < 0 || gap > maxSampleGapMs) {
        samples = [{ pose: normalized, timestamp }];
        movementHistory = [{ pose: normalized, timestamp }];
        startedAt = timestamp;
        lastAt = timestamp;
        return { valid: true, stable: false, moved: gap > maxSampleGapMs, remainingMs: durationMs };
      }

      samples.push({ pose: normalized, timestamp });
      samples = samples.filter(sample => timestamp - sample.timestamp <= smoothingWindowMs);
      const smoothedPose = averagePoses(samples.map(sample => sample.pose));
      movementHistory.push({ pose: smoothedPose, timestamp });
      movementHistory = movementHistory.filter(sample => timestamp - sample.timestamp <= maxSampleGapMs + smoothingWindowMs);
      let comparison = null;
      for (let i = movementHistory.length - 2; i >= 0; i--) {
        if (timestamp - movementHistory[i].timestamp >= movementWindowMs) {
          comparison = movementHistory[i];
          break;
        }
      }
      const comparisonGap = comparison ? timestamp - comparison.timestamp : 0;
      const moved = comparisonGap > 0 && angleDegrees(comparison.pose, smoothedPose) * 1000 / comparisonGap > maxMovementRateDegreesPerSecond;
      if (moved) startedAt = timestamp;
      lastAt = timestamp;
      const elapsed = Math.max(0, timestamp - startedAt);
      return {
        valid: true,
        stable: !moved && elapsed >= durationMs,
        moved,
        remainingMs: Math.max(0, durationMs - elapsed),
        pose: moved ? normalized : smoothedPose,
      };
    }

    return { observe, reset };
  }

  return { createStabilityTracker };
});
