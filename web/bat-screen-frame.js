/* Coordinate transform for the LCD-facing, back-of-bat mounting orientation. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BatScreenFrame = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  // Mounting frame: LCD faces the batter and the board's +X axis runs down
  // toward the handle. X is therefore the bat's axial-roll channel, not a
  // field-heading channel. For the current 2-D motion projection, sensor Z
  // supplies horizontal direction and sensor Y supplies vertical direction.
  // With the batter facing the client, positive projected Z maps to screen
  // right (the batter's off-side); negative Z maps to screen left (leg-side).
  // Vertical follows the current LCD convention.
  function rotationToScreen(rotation) {
    return { x: rotation.z, y: -rotation.y };
  }

  function isAxialRoll(rotation, pose, minimumAlignment = 0.92) {
    const magnitude = Math.hypot(rotation.x, rotation.y, rotation.z);
    if (!Number.isFinite(magnitude) || magnitude < 1e-10 || !pose) return false;

    const { w, x, y, z } = pose;
    const axis = {
      x: w*w + x*x - y*y - z*z,
      y: 2 * (x*y + w*z),
      z: 2 * (x*z - w*y),
    };
    const alignment = Math.abs(rotation.x * axis.x + rotation.y * axis.y + rotation.z * axis.z) / magnitude;
    return alignment >= minimumAlignment;
  }

  return { rotationToScreen, isAxialRoll };
});
