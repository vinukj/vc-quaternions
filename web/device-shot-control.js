/* Coordinates latched ESP32 touch requests with the browser-owned shot cycle. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeviceShotControl = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const COMMAND_SHOT_BUSY = 0x08;
  const COMMAND_SHOT_READY = 0x09;
  const COMMAND_SENSOR_RESET = 0x0a;

  function create(options = {}) {
    const isConnected = options.isConnected || (() => false);
    const isReady = options.isReady || (() => true);
    const getState = options.getState || (() => 'ready');
    const sendCommand = options.sendCommand || (async () => false);
    const readState = options.readState;
    const onResetEvent = options.onResetEvent || (() => {});
    const verifyReady = options.verifyReady;
    const wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const now = options.now || (() => performance.now());
    const resetTimeoutMs = Number.isFinite(options.resetTimeoutMs) ? options.resetTimeoutMs : 1500;
    const resetPollMs = Number.isFinite(options.resetPollMs) ? options.resetPollMs : 50;
    const startCycle = options.startCycle || (async () => false);
    const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : 300;
    let inFlight = false;
    let busyAckPending = false;
    let busyAckInFlight = false;
    let lastBusyAckAttempt = -Infinity;
    let deviceStartLatched = false;

    async function retryBusyAck() {
      if (!busyAckPending || busyAckInFlight || !isConnected()) return false;
      if (now() - lastBusyAckAttempt < retryMs) return false;
      busyAckInFlight = true;
      lastBusyAckAttempt = now();
      try {
        const acknowledged = await sendCommand(COMMAND_SHOT_BUSY);
        if (acknowledged) busyAckPending = false;
        return Boolean(acknowledged);
      } catch (_) {
        return false;
      } finally {
        busyAckInFlight = false;
      }
    }

    async function acknowledgeStart() {
      return retryBusyAck();
    }

    return {
      async requestStart() {
        if (!isConnected() || !isReady()) return false;
        const state = getState();
        if (inFlight || (state !== 'ready' && state !== 'error')) {
          // The device repeats its touch request until the LCD acknowledges
          // BUSY. Retry that write, but never launch a duplicate shot cycle.
          void retryBusyAck();
          return false;
        }
        inFlight = true;
        busyAckPending = true;
        lastBusyAckAttempt = -Infinity;
        try {
          // startCycle renders Preparing IMU first, then calls this to obtain
          // the firmware's 0x08 acknowledgement before requesting reset.
          const started = await Promise.resolve().then(() => startCycle(acknowledgeStart));
          if (!started) busyAckPending = false;
          return Boolean(started);
        } catch (error) {
          busyAckPending = false;
          throw error;
        } finally {
          inFlight = false;
        }
      },
      async requestDeviceStart() {
        if (!isConnected() || !isReady()) return false;
        if (deviceStartLatched) {
          // The START bit is a level held until the browser acknowledges it,
          // not a new press on every quaternion notification. Keep retrying
          // a failed BUSY write without creating another browser shot cycle.
          void retryBusyAck();
          return false;
        }
        deviceStartLatched = true;
        return this.requestStart();
      },
      releaseDeviceStart() {
        // The firmware drops the START flag as soon as it accepts BUSY, so
        // low packets are expected throughout the countdown and capture. Do
        // not let those packets re-arm a stale high level for shot completion.
        const state = getState();
        if (state === 'ready' || state === 'error') deviceStartLatched = false;
      },
      async markReady() {
        if (!isConnected()) return false;
        busyAckPending = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (await sendCommand(COMMAND_SHOT_READY) &&
              (!readState || !verifyReady || verifyReady(await readState()))) return true;
        }
        return false;
      },
      acknowledgeStart,
      async resetSensor() {
        if (!isConnected() || !readState) {
          onResetEvent('unavailable');
          return false;
        }
        onResetEvent('requesting', { command: COMMAND_SENSOR_RESET });
        let sent;
        try {
          sent = await sendCommand(COMMAND_SENSOR_RESET);
        } catch (error) {
          onResetEvent('write-failed', { error });
          throw error;
        }
        if (!sent) {
          onResetEvent('write-failed');
          return false;
        }
        onResetEvent('sent');
        const deadline = now() + resetTimeoutMs;
        while (isConnected() && now() <= deadline) {
          let state;
          try {
            state = await readState();
          } catch (error) {
            onResetEvent('read-failed', { error });
            throw error;
          }
          if (state?.imuResetStatus === 'complete') {
            onResetEvent('complete');
            return true;
          }
          if (state?.imuResetStatus === 'failed') {
            onResetEvent('failed');
            return false;
          }
          await wait(resetPollMs);
        }
        onResetEvent(isConnected() ? 'timeout' : 'disconnected');
        return false;
      },
      get inFlight() { return inFlight; },
    };
  }

  return { create, COMMAND_SHOT_BUSY, COMMAND_SHOT_READY, COMMAND_SENSOR_RESET };
});
