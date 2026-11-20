/* Restarts a stalled notification stream without tearing down the BLE link. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StreamRecovery = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  function create(options = {}) {
    const isConnected = options.isConnected || (() => false);
    const getLastPacketTime = options.getLastPacketTime || (() => 0);
    const sendStartCommand = options.sendStartCommand || (async () => false);
    const getSequence = options.getSequence || (() => 0);
    const waitForPacket = options.waitForPacket || (async () => false);
    const onStatus = options.onStatus || (() => {});
    const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 4000;
    const packetTimeoutMs = Number.isFinite(options.packetTimeoutMs) ? options.packetTimeoutMs : 2500;
    const retryBaseMs = Number.isFinite(options.retryBaseMs) ? options.retryBaseMs : 1000;
    const retryMaxMs = Number.isFinite(options.retryMaxMs) ? options.retryMaxMs : 10000;
    let pending = false;
    let attempts = 0;
    let retryAfter = 0;
    let generation = 0;

    async function recover(now) {
      const token = generation;
      pending = true;
      onStatus('Sensor stream stalled · restarting notifications…', 'err');
      try {
        // Record the sequence before the command: a fast first notification
        // must count as recovery rather than being missed between awaits.
        const before = getSequence();
        if (!await sendStartCommand()) throw new Error('stream restart command failed');
        if (token !== generation || !isConnected()) return false;
        if (!await waitForPacket(1, packetTimeoutMs, before)) throw new Error('no fresh sensor packet');
        if (token !== generation || !isConnected()) return false;
        attempts = 0;
        retryAfter = 0;
        onStatus('Sensor stream recovered · BLE connection kept', 'ok');
        return true;
      } catch (error) {
        if (token !== generation) return false;
        attempts++;
        const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(attempts - 1, 8)));
        retryAfter = now + delay;
        onStatus(`Sensor stream still paused · retrying in ${Math.ceil(delay / 1000)}s`, 'err');
        return false;
      } finally {
        if (token === generation) pending = false;
      }
    }

    return {
      check(now) {
        if (!isConnected() || pending || now < retryAfter) return false;
        const lastPacket = getLastPacketTime();
        if (!lastPacket || now - lastPacket <= staleMs) return false;
        void recover(now);
        return true;
      },
      notePacket() {
        attempts = 0;
        retryAfter = 0;
      },
      reset() {
        generation++;
        pending = false;
        attempts = 0;
        retryAfter = 0;
      },
      get pending() { return pending; },
      get attempts() { return attempts; },
    };
  }

  return { create };
});
