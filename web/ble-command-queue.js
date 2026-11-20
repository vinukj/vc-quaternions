/* Serialize browser BLE operations and recover from transient GATT busy errors. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BleCommandQueue = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const DEFAULT_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 3000];
  const DEFAULT_SETTLE_MS = 60;

  function isTransientGattCollision(error) {
    return /gatt operation already in progress/i.test(String(error && error.message || error));
  }

  function create(options = {}) {
    const getCharacteristic = options.getCharacteristic || (() => null);
    const getReadCharacteristic = options.getReadCharacteristic || getCharacteristic;
    const isConnected = options.isConnected || (() => false);
    const onError = options.onError || (() => {});
    const retryDelays = Array.isArray(options.retryDelays)
      ? options.retryDelays.map(delay => Math.max(0, Number(delay) || 0))
      : DEFAULT_RETRY_DELAYS_MS;
    const settleMs = Number.isFinite(options.settleMs)
      ? Math.max(0, options.settleMs) : DEFAULT_SETTLE_MS;
    const wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const lockManager = options.lockManager || (typeof navigator !== 'undefined' ? navigator.locks : null);
    const lockName = options.lockName || 'powerplai-ble-command-write';
    let queue = Promise.resolve();

    function enqueue(getTarget, operation) {
      const characteristic = getTarget();
      if (!characteristic || !isConnected()) return Promise.resolve(false);
      const execute = () => lockManager && typeof lockManager.request === 'function'
        ? lockManager.request(lockName, { mode: 'exclusive' }, () => operation(characteristic, getTarget))
        : operation(characteristic, getTarget);
      const result = queue.then(execute, execute);
      queue = result.catch(() => false);
      return result;
    }

    async function perform(characteristic, operation, getTarget = getCharacteristic) {
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        if (!isConnected() || getTarget() !== characteristic) return false;
        try {
          const result = await operation(characteristic);
          if (settleMs > 0) await wait(settleMs);
          return result === undefined ? true : result;
        } catch (error) {
          if (!isTransientGattCollision(error) || attempt >= retryDelays.length) {
            try { onError(error); } catch (_) {}
            return false;
          }
          await wait(retryDelays[attempt]);
        }
      }
      return false;
    }

    async function write(characteristic, payload, getTarget = getCharacteristic) {
      return perform(characteristic, async target => {
        const properties = target.properties || {};
        if (properties.writeWithoutResponse && target.writeValueWithoutResponse) {
          await target.writeValueWithoutResponse(payload);
        } else if (properties.write && target.writeValueWithResponse) {
          await target.writeValueWithResponse(payload);
        } else if (target.writeValue) {
          // Legacy Web Bluetooth fallback for older characteristic objects.
          await target.writeValue(payload);
        } else if (target.writeValueWithResponse) {
          await target.writeValueWithResponse(payload);
        } else {
          throw new Error('BLE command characteristic does not support writes.');
        }
        return true;
      }, getTarget);
    }

    async function read(characteristic, getTarget = getCharacteristic) {
      return perform(characteristic, async target => {
        const value = await target.readValue();
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      }, getTarget);
    }

    function send(command) {
      return writeBytes(new Uint8Array([command]));
    }

    function writeBytes(payload) {
      const bytes = payload instanceof Uint8Array ? payload.slice() : new Uint8Array(payload);
      return enqueue(getCharacteristic, (characteristic, getTarget) => write(characteristic, bytes, getTarget));
    }

    function readBytes() {
      return enqueue(getCharacteristic, (characteristic, getTarget) => read(characteristic, getTarget));
    }

    function readState() {
      return enqueue(getReadCharacteristic, (characteristic, getTarget) => read(characteristic, getTarget));
    }

    function writeAndRead(payload) {
      const bytes = payload instanceof Uint8Array ? payload.slice() : new Uint8Array(payload);
      return enqueue(getCharacteristic, async (characteristic, getWriteTarget) => {
        if (!await write(characteristic, bytes, getWriteTarget)) return false;
        const stateCharacteristic = getReadCharacteristic();
        if (!stateCharacteristic || !isConnected()) return false;
        return read(stateCharacteristic, getReadCharacteristic);
      });
    }

    return { send, writeBytes, readBytes, readState, writeAndRead };
  }

  return { create, isTransientGattCollision, DEFAULT_SETTLE_MS };
});
