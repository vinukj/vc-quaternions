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

  function createStabilityTracker(options = {}) {
    const durationMs = Number.isFinite(options.durationMs) ? Math.max(1, options.durationMs) : 3000;
    const maxDeviationDegrees = Number.isFinite(options.maxDeviationDegrees)
      ? Math.max(0, options.maxDeviationDegrees) : 8;
    const maxSampleGapMs = Number.isFinite(options.maxSampleGapMs) ? Math.max(1, options.maxSampleGapMs) : 500;
    let reference = null;
    let startedAt = null;
    let lastAt = null;

    function reset() {
      reference = null;
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
      if (reference === null || gap < 0 || gap > maxSampleGapMs) {
        reference = normalized;
        startedAt = timestamp;
        lastAt = timestamp;
        return { valid: true, stable: false, moved: gap > maxSampleGapMs, remainingMs: durationMs };
      }

      const moved = angleDegrees(reference, normalized) > maxDeviationDegrees;
      if (moved) {
        reference = normalized;
        startedAt = timestamp;
      }
      lastAt = timestamp;
      const elapsed = Math.max(0, timestamp - startedAt);
      return {
        valid: true,
        stable: !moved && elapsed >= durationMs,
        moved,
        remainingMs: Math.max(0, durationMs - elapsed),
        pose: normalized,
      };
    }

    return { observe, reset };
  }

  return { createStabilityTracker };
});
