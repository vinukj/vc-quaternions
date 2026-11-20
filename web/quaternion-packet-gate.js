/* Wait for fresh quaternion notifications around BLE command transitions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QuaternionPacketGate = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  function create() {
    let sequence = 0;
    const waiters = new Set();

    function finish(waiter, result) {
      if (waiter.done) return;
      waiter.done = true;
      clearTimeout(waiter.timeout);
      waiters.delete(waiter);
      waiter.resolve(result);
    }

    return {
      get sequence() { return sequence; },

      notify() {
        sequence++;
        for (const waiter of [...waiters]) {
          if (sequence >= waiter.target) finish(waiter, true);
        }
      },

      waitFor(count, timeoutMs, afterSequence = sequence) {
        if (!Number.isInteger(count) || count < 1) {
          return Promise.reject(new RangeError('count must be a positive integer'));
        }
        const target = afterSequence + count;
        if (sequence >= target) return Promise.resolve(true);

        return new Promise(resolve => {
          const waiter = { target, resolve, timeout: null, done: false };
          waiter.timeout = setTimeout(() => finish(waiter, false), timeoutMs);
          waiters.add(waiter);
        });
      },

      cancelWaiters() {
        for (const waiter of [...waiters]) finish(waiter, false);
      },
    };
  }

  return { create };
});
