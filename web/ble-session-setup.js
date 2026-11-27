/* Owns config acknowledgement and per-connection orientation/stance setup. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BleSessionSetup = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const CLEAR_GUARD = 0x04;
  const TAKE_GUARD = 0x03;
  const SAMPCNT_COMMAND = 0x0B;

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
    const getSampleSequence = options.getSampleSequence || (() => 0);
    const waitForFreshSample = options.waitForFreshSample || (async () => true);
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
    let acknowledgedSampcnt = null;
    let stanceReference = null;
    let orientationReference = null;
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
      acknowledgedSampcnt = null;
      stanceReference = null;
      orientationReference = null;
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
        const wasTakingStance = calibration.kind === 'stance';
        cancelCalibration();
        if (wasTakingStance) {
          stanceReference = null;
          if (!await writer.send(CLEAR_GUARD)) throw new Error('Could not clear the previous stance before changing game settings.');
        }
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
      return { state, stanceReference, orientationReference };
    }

    async function syncSampcnt(sampcnt) {
      if (!isConnected()) return false;
      if (![1, 2, 3, 4].includes(sampcnt)) throw new RangeError('unsupported sampling cadence');
      if (!configReady || !acknowledgedConfig) {
        throw new Error('Confirm the game settings before setting the sampling cadence.');
      }
      const token = session;
      const previousSampcnt = acknowledgedSampcnt;
      const previousStance = stanceReference;
      const cadenceChanged = previousSampcnt !== null && previousSampcnt !== sampcnt;
      configReady = false;
      if (calibration) {
        const wasTakingStance = calibration.kind === 'stance';
        cancelCalibration();
        if (wasTakingStance) {
          stanceReference = null;
          if (!await writer.send(CLEAR_GUARD)) throw new Error('Could not clear the previous stance before changing the sampling cadence.');
        }
      }

      if (!await writer.writeBytes(new Uint8Array([SAMPCNT_COMMAND, sampcnt]))) {
        throw new Error('Could not send the sampling-cadence command to the ESP32.');
      }
      if (!current(token)) return false;
      const bytes = await writer.readState();
      if (!current(token)) return false;
      if (!bytes) throw new Error('ESP32 did not return a sampling-cadence acknowledgement.');
      const state = decode(bytes);
      if (state.sampcnt !== sampcnt) {
        throw new Error('ESP32 sampling-cadence readback did not match the selected rate.');
      }
      if (!configMatches(state, acknowledgedConfig.sequence, getConfig())) {
        throw new Error('ESP32 game-config acknowledgement changed while setting the sampling cadence.');
      }

      if (cadenceChanged || (previousStance && (!state.guardActive || !samePose(previousStance, state.guard)))) {
        stanceReference = null;
      }
      acknowledgedSampcnt = sampcnt;
      configReady = true;
      return { state, stanceReference, orientationReference };
    }

    function startCalibration(kind, onProgress) {
      const active = {
        kind, token: session, cancelled: false, tracker: null, resolve: null, timer: null, onProgress,
        pendingSamples: [], collectingFreshSamples: false,
      };
      calibration = active;
      return active;
    }

    function waitForStablePose(active) {
      active.tracker = makeTracker({ durationMs: 3000, maxMovementRateDegreesPerSecond: 12, maxSampleGapMs: 500 });
      return new Promise(resolve => {
        active.resolve = resolve;
        active.timer = setTimeout(() => resolve(null), calibrationTimeoutMs);
        active.collectingFreshSamples = false;
        for (const sample of active.pendingSamples) observeWithTracker(active, sample.pose, sample.timestamp);
        active.pendingSamples = [];
      });
    }

    function calibrationIsCurrent(active) {
      return isConnected() && active.token === session && calibration === active && !active.cancelled;
    }

    async function waitForCalibrationSample(active) {
      active.pendingSamples = [];
      active.collectingFreshSamples = true;
      const afterSequence = getSampleSequence();
      const ready = await waitForFreshSample(afterSequence, () => calibrationIsCurrent(active));
      if (!calibrationIsCurrent(active)) {
        active.collectingFreshSamples = false;
        active.pendingSamples = [];
        return false;
      }
      if (!ready) {
        active.collectingFreshSamples = false;
        active.pendingSamples = [];
        throw new Error('No fresh quaternion data arrived after verifying ESP32 setup. Check the BLE sensor stream and try again.');
      }
      return true;
    }

    function observeWithTracker(active, pose, timestamp) {
      const result = active.tracker.observe(pose, timestamp);
      active.onProgress(result);
      if (result.stable && active.resolve) active.resolve(result.pose);
      return result;
    }

    async function calibrateOrientation(onProgress = () => {}) {
      if (!isConnected() || !configReady || calibration) {
        throw new Error('Connect and confirm the game settings before capturing bat orientation.');
      }
      const active = startCalibration('orientation', onProgress);
      stanceReference = null;
      orientationReference = null;
      try {
        if (!await writer.send(CLEAR_GUARD) || !calibrationIsCurrent(active)) {
          throw new Error('Could not clear the previous stance before capturing bat orientation.');
        }
        const clearedBytes = await writer.readState();
        if (!calibrationIsCurrent(active)) return false;
        if (!clearedBytes) throw new Error('Could not verify that the previous stance was cleared.');
        const cleared = decode(clearedBytes);
        if (!configMatches(cleared, acknowledgedConfig.sequence, getConfig()) || cleared.guardActive ||
            cleared.shotState !== 'ready') {
          throw new Error('The ESP32 did not confirm the current game settings, a cleared stance, and a ready shot state.');
        }

        if (!await waitForCalibrationSample(active)) return false;
        const stablePose = await waitForStablePose(active);
        if (!calibrationIsCurrent(active)) return false;
        if (!stablePose) throw new Error('Bat orientation was not stable for 3 seconds. Place the bat in the reference position and try again.');
        orientationReference = normalize(stablePose);
        return orientationReference;
      } catch (error) {
        if (calibrationIsCurrent(active)) orientationReference = null;
        throw error;
      } finally {
        if (active.timer !== null) clearTimeout(active.timer);
        if (calibration === active) calibration = null;
      }
    }

    async function calibrateStance(onProgress = () => {}) {
      if (!isConnected() || !configReady || calibration) {
        throw new Error('Connect and confirm the game settings before taking stance.');
      }
      if (!orientationReference) throw new Error('Capture bat orientation before taking stance.');
      const active = startCalibration('stance', onProgress);
      stanceReference = null;
      try {
        if (!await writer.send(CLEAR_GUARD) || !calibrationIsCurrent(active)) {
          throw new Error('Could not clear the previous stance. Check the BLE connection and try again.');
        }
        const clearedBytes = await writer.readState();
        if (!calibrationIsCurrent(active)) return false;
        if (!clearedBytes) throw new Error('Could not verify that the previous stance was cleared.');
        const cleared = decode(clearedBytes);
        if (!configMatches(cleared, acknowledgedConfig.sequence, getConfig()) || cleared.guardActive ||
            cleared.shotState !== 'ready') {
          throw new Error('The ESP32 did not confirm a cleared stance, current game settings, and a ready shot state.');
        }

        if (!await waitForCalibrationSample(active)) return false;
        const stablePose = await waitForStablePose(active);
        if (!calibrationIsCurrent(active)) return false;
        if (!stablePose) throw new Error('Stance was not stable for 3 seconds. Hold still and try again.');

        if (!await writer.send(TAKE_GUARD) || !calibrationIsCurrent(active)) {
          throw new Error('Could not set the verified stance on the ESP32.');
        }
        const stateBytes = await writer.readState();
        if (!calibrationIsCurrent(active)) return false;
        if (!stateBytes) throw new Error('Could not read back the saved ESP32 stance.');
        const state = decode(stateBytes);
        const reference = normalize(state.guard);
        if (!configMatches(state, acknowledgedConfig.sequence, getConfig()) || !state.guardActive ||
            state.shotState !== 'ready' ||
            !reference || !samePose(stablePose, reference, 12)) {
          throw new Error('The ESP32 stance readback did not match the stable pose or the device is not ready. Please take stance again.');
        }
        stanceReference = reference;
        return reference;
      } catch (error) {
        if (calibrationIsCurrent(active)) stanceReference = null;
        throw error;
      } finally {
        if (active.timer !== null) clearTimeout(active.timer);
        if (calibration === active) calibration = null;
      }
    }

    function observeCalibrationSample(pose, timestamp) {
      if (!calibration || calibration.cancelled) return null;
      if (!calibration.tracker) {
        if (calibration.collectingFreshSamples) calibration.pendingSamples.push({ pose, timestamp });
        return null;
      }
      return observeWithTracker(calibration, pose, timestamp);
    }

    async function cancelSetupCalibration(clearOnDevice = true) {
      const active = calibration;
      const hadCalibration = cancelCalibration();
      if (!hadCalibration && !stanceReference) return false;
      if (active && active.kind === 'orientation') orientationReference = null;
      stanceReference = null;
      if (clearOnDevice && isConnected() && !await writer.send(CLEAR_GUARD)) {
        throw new Error('Could not clear the ESP32 stance. Check the BLE connection and retry setup.');
      }
      return true;
    }

    function invalidateStance() {
      stanceReference = null;
      orientationReference = null;
      cancelCalibration();
    }

    return {
      resetSession,
      syncConfig,
      syncSampcnt,
      calibrateOrientation,
      calibrateStance,
      observeCalibrationSample,
      cancelSetupCalibration,
      invalidateStance,
      isReady: () => Boolean(isConnected() && configReady && acknowledgedSampcnt !== null && stanceReference && orientationReference),
      get configReady() { return configReady; },
      get acknowledgedSampcnt() { return acknowledgedSampcnt; },
      get stanceReference() { return stanceReference; },
      get orientationReference() { return orientationReference; },
      get calibrationKind() { return calibration && calibration.kind; },
      get isCalibrating() { return Boolean(calibration); },
      get acknowledgedConfig() { return acknowledgedConfig && { ...acknowledgedConfig }; },
    };
  }

  return { create };
});
