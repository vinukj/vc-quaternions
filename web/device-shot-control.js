/* Coordinates latched ESP32 touch requests with the browser-owned shot cycle. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeviceShotControl = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const COMMAND_SHOT_BUSY = 0x08;
  const COMMAND_SHOT_READY = 0x09;

  function create(options = {}) {
    const isConnected = options.isConnected || (() => false);
    const isReady = options.isReady || (() => true);
    const getState = options.getState || (() => 'ready');
    const sendCommand = options.sendCommand || (async () => false);
    const startCycle = options.startCycle || (async () => false);
    const now = options.now || (() => performance.now());
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
        try {
          // The LCD touch is the shot cue. Start the browser cycle at once so
          // its 3-2-1 is not delayed behind a BLE write acknowledgement.
          const started = await Promise.resolve().then(startCycle);
          if (!started) return false;
          // A failed LCD acknowledgement must not suppress the browser timer.
          // Firmware repeats the touch request until this write succeeds.
          busyAckPending = true;
          // Retry throttling applies within one held request only. A fresh
          // START after READY is a new cycle and needs its own immediate ACK.
          lastBusyAckAttempt = -Infinity;
          void retryBusyAck();
          return true;
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
        return sendCommand(COMMAND_SHOT_READY);
      },
      get inFlight() { return inFlight; },
    };
  }

  return { create, COMMAND_SHOT_BUSY, COMMAND_SHOT_READY };
});
