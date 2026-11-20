/* Owns config acknowledgement and the explicit per-connection stance setup. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BleSessionSetup = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const CLEAR_GUARD = 0x04;
  const TAKE_GUARD = 0x03;

  function normalize(pose) {
    if (!pose || ![pose.w, pose.x, pose.y, pose.z].every(Number.isFinite)) return null;
    const length = Math.hypot(pose.w, pose.x, pose.y, pose.z);
    if (length < 1e-8) return null;
    return { w: pose.w / length, x: pose.x / length, y: pose.y / length, z: pose.z / length };
  }

  function samePose(left, right, toleranceDegrees = 0.5) {
    const a = normalize(left);
    const b = normalize(right);
    if (!a || !b) return false;
    const dot = Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z);
    return 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI <= toleranceDegrees;
  }

  function create(options = {}) {
    const writer = options.commandWriter;
    const isConnected = options.isConnected || (() => false);
    const getConfig = options.getConfig || (() => ({}));
    const makeTracker = options.createStabilityTracker;
    const decode = options.decodeState;
    const encode = options.encodeConfig;
    const configMatches = options.configMatches;
    const calibrationTimeoutMs = Number.isFinite(options.calibrationTimeoutMs)
      ? Math.max(1000, options.calibrationTimeoutMs) : 30000;
    if (!writer || !makeTracker || !decode || !encode || !configMatches) {
      throw new TypeError('BLE session setup requires a command writer and device-config codecs.');
    }

    let session = 0;
    let configRevision = 0;
    let sequence = 0;
    let configReady = false;
    let acknowledgedConfig = null;
    let stanceReference = null;
    let calibration = null;

    function current(token, revision) {
      return isConnected() && token === session && (revision === undefined || revision === configRevision);
    }

    function cancelCalibration() {
      if (!calibration) return false;
      const pending = calibration;
      calibration = null;
      pending.cancelled = true;
      if (pending.timer !== null) clearTimeout(pending.timer);
      if (pending.resolve) pending.resolve(null);
      return true;
    }

    function resetSession() {
      session++;
      configRevision++;
      cancelCalibration();
      configReady = false;
      acknowledgedConfig = null;
      stanceReference = null;
      return session;
    }

    async function syncConfig(config) {
      if (!isConnected()) return false;
      const token = session;
      const revision = ++configRevision;
      const previousStance = stanceReference;
      const nextSequence = sequence = (sequence + 1) & 0xff;
      configReady = false;
      if (calibration) {
        cancelCalibration();
        stanceReference = null;
        void writer.send(CLEAR_GUARD);
      }

      const frame = encode(nextSequence, config);
      const bytes = await writer.writeAndRead(frame);
      if (!current(token, revision)) return false;
      if (!bytes) throw new Error('ESP32 did not return a game-config acknowledgement.');
      const state = decode(bytes);
      if (!configMatches(state, nextSequence, config)) {
        throw new Error('ESP32 game-config acknowledgement did not match the selected settings.');
      }

      if (previousStance && (!state.guardActive || !samePose(previousStance, state.guard))) {
        stanceReference = null;
      }
      configReady = true;
      acknowledgedConfig = { sequence: nextSequence, ...config };
      return { state, stanceReference };
    }

    async function calibrateStance(onProgress = () => {}) {
      if (!isConnected() || !configReady || calibration) {
        throw new Error('Connect and confirm the game settings before taking stance.');
      }
      const token = session;
      const active = { token, cancelled: false, tracker: null, resolve: null, timer: null, onProgress };
      calibration = active;
      stanceReference = null;
      try {
        if (!await writer.send(CLEAR_GUARD) || !current(token)) {
          throw new Error('Could not clear the previous stance. Check the BLE connection and try again.');
        }
        const clearedBytes = await writer.readState();
        if (!current(token)) return false;
        if (!clearedBytes) throw new Error('Could not verify that the previous stance was cleared.');
        const cleared = decode(clearedBytes);
        if (!configMatches(cleared, acknowledgedConfig.sequence, getConfig()) || cleared.guardActive) {
          throw new Error('The ESP32 did not confirm a cleared stance and current game settings.');
        }

        active.tracker = makeTracker({ durationMs: 3000, maxDeviationDegrees: 8, maxSampleGapMs: 500 });
        const stablePose = await new Promise(resolve => {
          active.resolve = resolve;
          active.timer = setTimeout(() => resolve(null), calibrationTimeoutMs);
        });
        if (!current(token) || active.cancelled) return false;
        if (!stablePose) throw new Error('Stance was not stable for 3 seconds. Hold still and try again.');

        if (!await writer.send(TAKE_GUARD) || !current(token)) {
          throw new Error('Could not set the verified stance on the ESP32.');
        }
        const stateBytes = await writer.readState();
        if (!current(token)) return false;
        if (!stateBytes) throw new Error('Could not read back the saved ESP32 stance.');
        const state = decode(stateBytes);
        const reference = normalize(state.guard);
        if (!configMatches(state, acknowledgedConfig.sequence, getConfig()) || !state.guardActive ||
            !reference || !samePose(stablePose, reference, 12)) {
          throw new Error('The ESP32 stance readback did not match the stable pose. Please take stance again.');
        }
        stanceReference = reference;
        return reference;
      } catch (error) {
        if (current(token)) stanceReference = null;
        throw error;
      } finally {
        if (active.timer !== null) clearTimeout(active.timer);
        if (calibration === active) calibration = null;
      }
    }

    function observeStanceSample(pose, timestamp) {
      if (!calibration || !calibration.tracker || calibration.cancelled) return null;
      const result = calibration.tracker.observe(pose, timestamp);
      calibration.onProgress(result);
      if (result.stable && calibration.resolve) calibration.resolve(result.pose);
      return result;
    }

    async function cancelStance(clearOnDevice = true) {
      const hadCalibration = cancelCalibration();
      if (!hadCalibration && !stanceReference) return false;
      stanceReference = null;
      if (clearOnDevice && isConnected()) await writer.send(CLEAR_GUARD);
      return true;
    }

    function invalidateStance() {
      stanceReference = null;
      cancelCalibration();
    }

    return {
      resetSession,
      syncConfig,
      calibrateStance,
      observeStanceSample,
      cancelStance,
      invalidateStance,
      isReady: () => Boolean(isConnected() && configReady && stanceReference),
      get configReady() { return configReady; },
      get stanceReference() { return stanceReference; },
      get isCalibrating() { return Boolean(calibration); },
      get acknowledgedConfig() { return acknowledgedConfig && { ...acknowledgedConfig }; },
    };
  }

  return { create };
});
