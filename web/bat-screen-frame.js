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

  return { rotationToScreen };
});
