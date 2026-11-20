/* Capture the current stance, then use it as the firmware's next-shot guard. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShotGuard = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const CLEAR_GUARD = 0x04;
  const TAKE_GUARD = 0x03;
  const PACKETS_PER_TRANSITION = 3;
  const PACKET_TIMEOUT_MS = 2500;

  async function capture(options = {}) {
    const sendCommand = options.sendCommand || (async () => false);
    const packetGate = options.packetGate;
    const getQuaternion = options.getQuaternion || (() => null);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PACKET_TIMEOUT_MS;
    if (!packetGate || typeof packetGate.waitFor !== 'function') {
      throw new Error('Sensor packet gate is unavailable.');
    }

    if (!await sendCommand(CLEAR_GUARD)) {
      throw new Error('BLE could not clear the previous firmware guard. Close any other PowerplAi tab connected to this bat, then press START to retry.');
    }
    const afterClear = packetGate.sequence;
    if (!await packetGate.waitFor(PACKETS_PER_TRANSITION, timeoutMs, afterClear)) {
      throw new Error('The sensor did not send fresh data after clearing the guard.');
    }

    const pose = getQuaternion();
    if (!pose || ![pose.w, pose.x, pose.y, pose.z].every(Number.isFinite) ||
        Math.hypot(pose.w, pose.x, pose.y, pose.z) < 1e-8) {
      throw new Error('No valid sensor pose is available for Take Guard.');
    }
    const referenceQuaternion = { w: pose.w, x: pose.x, y: pose.y, z: pose.z };

    if (!await sendCommand(TAKE_GUARD)) throw new Error('Could not set Take Guard.');
    const afterGuard = packetGate.sequence;
    if (!await packetGate.waitFor(PACKETS_PER_TRANSITION, timeoutMs, afterGuard)) {
      throw new Error('Take Guard was set, but fresh sensor data did not arrive.');
    }

    return referenceQuaternion;
  }

  return { capture, CLEAR_GUARD, TAKE_GUARD };
});
