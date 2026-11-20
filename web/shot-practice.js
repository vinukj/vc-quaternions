/* Browser-owned countdown → configured capture window → analyze loop. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShotPractice = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  function create(options = {}) {
    const onState = options.onState || (() => {});
    const onPrepare = options.onPrepare || (async () => true);
    const analyze = options.analyze || (() => ({}));
    const onResult = options.onResult || (() => {});
    const getContext = options.getContext || (() => null);
    const now = options.now || (() => performance.now());
    const schedule = options.setTimeout || setTimeout;
    const cancelTimer = options.clearTimeout || clearTimeout;
    const countdownSeconds = Number.isInteger(options.countdownSeconds) ? options.countdownSeconds : 3;
    let captureMs = Number.isInteger(options.captureMs) && options.captureMs >= 350 && options.captureMs <= 1000
      ? options.captureMs : 1000;
    let activeCaptureMs = captureMs;
    let activeContext = null;
    let lastSampleCount = 0;
    let lastCaptureMs = 0;
    let lastSampleSpanMs = 0;
    let state = 'ready';
    let timer = null;
    let generation = 0;
    let samples = [];
    let remaining = countdownSeconds;
    let preparationReady = false;
    let countdownComplete = false;
    let captureStartedAt = null;
    let captureDeadline = null;

    function update(nextState, detail = {}) {
      state = nextState;
      onState(state, detail);
    }

    function contextSnapshot() {
      return activeContext && typeof activeContext === 'object' ? { ...activeContext } : activeContext;
    }

    function scheduleAtDeadline(callback, delay) {
      timer = schedule(callback, delay);
    }

    function beginCapture(token) {
      if (token !== generation) return;
      timer = null;
      samples = [];
      captureStartedAt = now();
      captureDeadline = captureStartedAt + activeCaptureMs;
      update('capturing', { remainingMs: activeCaptureMs, captureMs: activeCaptureMs, context: contextSnapshot() });
      scheduleAtDeadline(() => { void finishCapture(token); }, activeCaptureMs);
    }

    function countdownTick(token) {
      if (token !== generation) return;
      if (remaining <= 1) {
        remaining = 0;
        countdownComplete = true;
        if (preparationReady) beginCapture(token);
        else {
          timer = null;
          update('preparing');
        }
        return;
      }
      remaining--;
      update('countdown', { remaining });
      scheduleAtDeadline(() => countdownTick(token), 1000);
    }

    async function finishCapture(token) {
      if (token !== generation) return;
      timer = null;
      const capturedSamples = samples.map(sample => ({ ...sample }));
      lastSampleCount = capturedSamples.length;
      lastCaptureMs = activeCaptureMs;
      const timestamps = capturedSamples.map(sample => sample.t);
      lastSampleSpanMs = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
      const captureDetail = {
        sampleCount: lastSampleCount,
        captureMs: lastCaptureMs,
        sampleSpanMs: lastSampleSpanMs,
        context: contextSnapshot(),
      };
      update('analyzing', captureDetail);
      try {
        const result = analyze(capturedSamples.slice());
        onResult(result, capturedSamples, captureDetail);
      } catch (error) {
        if (token !== generation) return;
        update('error', { message: error.message || String(error) });
        return;
      }
      if (token !== generation) return;
      update('ready');
    }

    async function prepareCycle(token) {
      try {
        const prepared = await onPrepare();
        if (token !== generation) return;
        if (prepared === false) throw new Error('Could not prepare the bat for capture.');
        preparationReady = true;
        if (countdownComplete && state === 'preparing') beginCapture(token);
      } catch (error) {
        if (token !== generation) return;
        if (timer !== null) cancelTimer(timer);
        timer = null;
        update('error', { message: error.message || String(error) });
      }
    }

    return {
      get state() { return state; },
      get samples() { return samples.slice(); },
      get lastSampleCount() { return lastSampleCount; },
      get lastCaptureMs() { return lastCaptureMs; },
      get lastSampleSpanMs() { return lastSampleSpanMs; },
      setCaptureMs(milliseconds) {
        if (!Number.isInteger(milliseconds) || milliseconds < 350 || milliseconds > 1000) return false;
        captureMs = milliseconds;
        return true;
      },
      async start() {
        if (state !== 'ready' && state !== 'error') return false;
        const token = ++generation;
        samples = [];
        remaining = countdownSeconds;
        activeCaptureMs = captureMs;
        activeContext = getContext();
        preparationReady = false;
        countdownComplete = false;
        captureStartedAt = null;
        captureDeadline = null;
        // Stance is calibrated explicitly before START. Stream preparation
        // runs in the background; capture opens after the countdown and once
        // fresh sensor data is available.
        update('countdown', { remaining });
        scheduleAtDeadline(() => countdownTick(token), 1000);
        void prepareCycle(token);
        return true;
      },
      addSample(sample) {
        if (state !== 'capturing' || !sample || !Number.isFinite(sample.t)) return false;
        if (![sample.w, sample.x, sample.y, sample.z].every(Number.isFinite)) return false;
        if (sample.t < captureStartedAt || sample.t >= captureDeadline) return false;
        samples.push({ w: sample.w, x: sample.x, y: sample.y, z: sample.z, t: sample.t });
        return true;
      },
      cancel() {
        generation++;
        if (timer !== null) cancelTimer(timer);
        timer = null;
        samples = [];
        captureStartedAt = null;
        captureDeadline = null;
        update('ready');
      },
    };
  }

  return { create };
});
