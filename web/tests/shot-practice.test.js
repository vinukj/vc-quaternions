const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../shot-practice.js');

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    get delays() { return [...timers.values()].map(timer => timer.at - now); },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].callback();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = Math.max(now, target);
      await Promise.resolve();
      await Promise.resolve();
    },
    elapseWithoutRunningTimers(milliseconds) { now += milliseconds; },
  };
}

async function settleStart(cycle, acknowledgeStart) {
  const accepted = await cycle.start(acknowledgeStart);
  for (let index = 0; index < 10; index++) await Promise.resolve();
  return accepted;
}

async function flushPromises() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

test('acknowledges shot start, resets and prepares IMU before starting 3-2-1', async () => {
  const clock = fakeClock();
  const events = [];
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onReset: async () => { events.push('reset'); return true; },
    onPrepare: async () => { events.push('stream-ready'); return true; },
    onState: (state, detail) => events.push(detail.remaining ? `${state}-${detail.remaining}` : state),
  });

  assert.equal(await settleStart(cycle, async () => { events.push('busy-ack'); return true; }), true);
  assert.equal(cycle.state, 'countdown');
  assert.deepEqual(events, ['preparing', 'busy-ack', 'resetting', 'reset', 'stream-preparing', 'stream-ready', 'countdown-3']);
  assert.deepEqual(clock.delays, [1000], 'the countdown starts only after reset and stream readiness');
});

test('holds countdown until START ack, IMU reset completion, and a fresh stream; captures configured window', async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const clock = fakeClock();
  const startAck = deferred();
  const reset = deferred();
  const freshStream = deferred();
  const events = [];
  let captureDetail;
  let resultCount = 0;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    captureMs: 400,
    onReset: () => { events.push('reset-requested'); return reset.promise; },
    onPrepare: () => { events.push('fresh-stream-requested'); return freshStream.promise; },
    onState: (state, detail) => {
      events.push(state);
      if (state === 'capturing') captureDetail = detail;
    },
    onResult: () => { resultCount++; },
  });

  assert.equal(await cycle.start(() => { events.push('start-ack-requested'); return startAck.promise; }), true);
  await flushPromises();
  assert.equal(cycle.state, 'preparing');
  assert.equal(events.includes('reset-requested'), false, 'reset waits for firmware START acknowledgement');
  assert.equal(events.includes('countdown'), false);

  startAck.resolve(true);
  await flushPromises();
  assert.equal(cycle.state, 'resetting');
  assert.equal(events.includes('fresh-stream-requested'), false);
  assert.equal(events.includes('countdown'), false, 'countdown cannot begin while reset is pending');

  reset.resolve(true);
  await flushPromises();
  assert.equal(cycle.state, 'stream-preparing');
  assert.equal(events.includes('countdown'), false, 'countdown waits for the first fresh post-reset sample');

  freshStream.resolve(true);
  await flushPromises();
  assert.equal(cycle.state, 'countdown');
  assert.equal(cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: clock.now() }), false,
    'countdown samples are excluded');
  await clock.advance(3000);
  assert.equal(cycle.state, 'capturing');
  assert.equal(captureDetail.captureMs, 400);
  assert.equal(cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: clock.now() }), true);
  await clock.advance(400);
  assert.equal(resultCount, 1);
  assert.equal(cycle.lastCaptureMs, 400);
  assert.ok(events.indexOf('reset-requested') < events.indexOf('fresh-stream-requested'));
  assert.ok(events.indexOf('fresh-stream-requested') < events.indexOf('countdown'));
});

test('shows 3-2-1 then captures one complete shot window without recapturing stance', async () => {
  const clock = fakeClock();
  const states = [];
  const results = [];
  let prepared = 0;
  let guardChanges = 0;
  const takeGuard = () => { guardChanges++; return true; };
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onPrepare: async () => { prepared++; return true; },
    onTakeGuard: takeGuard,
    analyze: samples => ({ count: samples.length }),
    onResult: result => results.push(result),
    onState: (state, detail) => states.push({ state, detail }),
  });
  // Stance setup belongs to BLE session setup; a shot cycle must never mutate it.

  assert.equal(await settleStart(cycle), true);
  assert.equal(cycle.state, 'countdown');
  assert.equal(prepared, 1, 'stream preparation follows the IMU reset and precedes the countdown');
  await clock.advance(3000);
  assert.equal(cycle.state, 'capturing');
  assert.equal(cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: clock.now() }), true);
  await clock.advance(1000);

  assert.equal(cycle.state, 'ready');
  assert.deepEqual(results, [{ count: 1 }]);
  assert.equal(guardChanges, 0);
  assert.deepEqual(states.map(item => item.state), [
    'preparing', 'resetting', 'stream-preparing', 'countdown', 'countdown', 'countdown', 'capturing', 'analyzing', 'ready',
  ]);
  assert.deepEqual(states.filter(item => item.state === 'countdown').map(item => item.detail.remaining), [3, 2, 1]);
});

test('waits for stream preparation after reset and before the countdown', async () => {
  const clock = fakeClock();
  let finishPrepare;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onPrepare: () => new Promise(resolve => { finishPrepare = resolve; }),
  });

  const started = cycle.start();
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(cycle.state, 'stream-preparing');
  finishPrepare(true);
  assert.equal(await started, true);
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(cycle.state, 'countdown');
  await clock.advance(3000);
  assert.equal(cycle.state, 'capturing');
  cycle.cancel();
});

test('waits for reset completion before stream preparation and countdown', async () => {
  const clock = fakeClock();
  const states = [];
  let finishReset;
  let resets = 0;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onReset: () => { resets++; return new Promise(resolve => { finishReset = resolve; }); },
    onState: state => states.push(state),
  });

  await settleStart(cycle);
  assert.equal(cycle.state, 'resetting');
  assert.equal(resets, 1, 'one IMU reset is requested per shot');
  assert.equal(states.includes('countdown'), false, 'countdown cannot begin before reset completion');

  finishReset(true);
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(cycle.state, 'countdown', 'countdown begins only after firmware confirms reset');
  await clock.advance(3000);
  assert.equal(cycle.state, 'capturing');
});

test('does not let a stale-stream preparation failure skip the per-shot reset', async () => {
  const clock = fakeClock();
  const events = [];
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onReset: async () => { events.push('reset'); return true; },
    onPrepare: async () => { events.push('prepare'); return false; },
    onState: state => events.push(state),
  });

  await settleStart(cycle);

  const resetIndex = events.indexOf('reset');
  const prepareIndex = events.indexOf('prepare');
  assert.notEqual(resetIndex, -1, 'stale-stream failure must not bypass the per-shot reset');
  assert.ok(resetIndex < prepareIndex,
    'the IMU reset must complete before stream readiness can fail');
  assert.equal(events.includes('error'), true, 'failed stream preparation remains visible');
  assert.equal(cycle.state, 'error');
});

test('returns to READY after one result and requests one reset before each shot countdown', async () => {
  const clock = fakeClock();
  const resets = [];
  const results = [];
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onReset: async () => { resets.push(clock.now()); return true; },
    onResult: (_result, _samples, detail) => results.push(detail),
  });

  for (let index = 0; index < 2; index++) {
    assert.equal(await settleStart(cycle), true);
    assert.equal(resets.length, index + 1, 'the IMU reset completes before this shot countdown begins');
    await clock.advance(3000);
    assert.equal(cycle.state, 'capturing');
    cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: clock.now() });
    await clock.advance(1000);
    assert.equal(cycle.state, 'ready');
  }

  assert.equal(resets.length, 2, 'each shot resets exactly once before its countdown');
  assert.equal(results.length, 2, 'one capture result is produced per START cycle');
});

test('keeps the device locked when the per-shot sensor reset fails', async () => {
  const clock = fakeClock();
  const states = [];
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onReset: async () => false,
    onState: state => states.push(state),
  });

  await settleStart(cycle);
  assert.equal(cycle.state, 'reset-failed');
  assert.equal(states.includes('capturing'), false);
  assert.equal(await cycle.start(), false, 'a new shot cannot start until the failed reset is recovered');
});

test('passes an isolated copy of captured quaternion samples with the result', async () => {
  const clock = fakeClock();
  let reportedSamples;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onResult: (_result, samples) => { reportedSamples = samples; },
  });

  await settleStart(cycle);
  await clock.advance(3000);
  const sample = { w: 1, x: 0, y: 0, z: 0, t: clock.now() };
  cycle.addSample(sample);
  await clock.advance(1000);

  assert.deepEqual(reportedSamples, [sample]);
  assert.notEqual(reportedSamples, cycle.samples, 'reporting does not expose the mutable internal sample array');
});

test('configured windows include only their timestamp range and produce one result', async () => {
  for (const captureMs of [400, 525, 900]) {
    const clock = fakeClock();
    const reported = [];
    const cycle = create({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      captureMs,
      analyze: samples => ({ sampleCount: samples.length }),
      onResult: (result, samples, detail) => reported.push({ result, samples, detail }),
    });

    await settleStart(cycle);
    await clock.advance(3000);
    const captureStart = clock.now();
    assert.equal(cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: captureStart - 1 }), false);
    for (let offset = 0; offset < captureMs; offset += 20) {
      assert.equal(cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: captureStart + offset }), true);
    }
    assert.equal(cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: captureStart + captureMs }), false,
      'the capture end is exclusive');
    await clock.advance(captureMs);

    const expectedCount = Math.ceil(captureMs / 20);
    assert.equal(reported.length, 1, 'one capture window creates exactly one result');
    assert.equal(reported[0].result.sampleCount, expectedCount);
    assert.equal(reported[0].samples.length, expectedCount);
    assert.equal(reported[0].samples.at(-1).t - reported[0].samples[0].t, (expectedCount - 1) * 20);
    assert.equal(reported[0].detail.captureMs, captureMs);
    assert.equal(reported[0].detail.sampleCount, expectedCount);
    assert.equal(reported[0].detail.sampleSpanMs, (expectedCount - 1) * 20,
      'actual packet timestamp span is reported separately from the configured window');
  }
});

test('rejects post-window packets even when the capture timer callback is delayed', async () => {
  const clock = fakeClock();
  let analyzed;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    captureMs: 400,
    analyze: samples => { analyzed = samples; return {}; },
  });
  await settleStart(cycle);
  await clock.advance(3000);
  const start = clock.now();
  assert.equal(cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: start }), true);

  clock.elapseWithoutRunningTimers(450);
  assert.equal(cycle.state, 'capturing', 'the delayed timer has not yet transitioned the state');
  assert.equal(cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: start + 450 }), false);
  await clock.advance(0);
  assert.equal(analyzed.length, 1, 'late notifications are excluded from analysis');
});

test('capture timestamps start when the capture state opens', async () => {
  const clock = fakeClock();
  let captured;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    captureMs: 400,
    onResult: (_result, samples) => { captured = samples; },
  });
  await settleStart(cycle);
  await clock.advance(3000);
  const start = clock.now();
  assert.equal(cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: start }), true);
  await clock.advance(400);
  assert.equal(captured.length, 1);
});

test('uses configured 525 ms capture duration and rejects unsupported windows', async () => {
  const clock = fakeClock();
  let captureDetail;
  let analyzed = false;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    captureMs: 1000,
    onState: (state, detail) => { if (state === 'capturing') captureDetail = detail; },
    analyze: () => { analyzed = true; return {}; },
  });

  assert.equal(cycle.setCaptureMs(525), true);
  await settleStart(cycle);
  await clock.advance(3000);
  assert.equal(captureDetail.captureMs, 525);
  await clock.advance(524);
  assert.equal(analyzed, false);
  await clock.advance(1);
  assert.equal(analyzed, true);
  assert.equal(cycle.setCaptureMs(349), false);
});

test('latches one capture duration per shot and reports its actual sample count', async () => {
  const clock = fakeClock();
  const states = [];
  let resultSamples;
  let resultDetail;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    captureMs: 400,
    analyze: samples => ({ sampleCount: samples.length }),
    onResult: (_result, samples, detail) => { resultSamples = samples; resultDetail = detail; },
    onState: (state, detail) => states.push({ state, detail }),
  });

  await settleStart(cycle);
  assert.equal(cycle.setCaptureMs(900), true, 'a later setting is accepted for the next shot');
  await clock.advance(3000);
  assert.equal(states.find(item => item.state === 'capturing').detail.captureMs, 400,
    'the in-flight shot retains the window chosen when it started');
  for (let offset = 0; offset < 400; offset += 20) {
    cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: clock.now() + offset });
  }
  await clock.advance(400);

  assert.equal(resultSamples.length, 20);
  assert.equal(cycle.lastSampleCount, 20);
  assert.equal(cycle.lastCaptureMs, 400);
  assert.equal(resultDetail.captureMs, 400);
  assert.equal(resultDetail.sampleCount, 20);
  assert.equal(resultDetail.sampleSpanMs, 380);
  const analyzing = states.find(item => item.state === 'analyzing');
  assert.deepEqual(analyzing.detail, {
    sampleCount: 20, captureMs: 400, sampleSpanMs: 380, context: null,
  });

  await settleStart(cycle);
  await clock.advance(3000);
  assert.equal(states.filter(item => item.state === 'capturing').at(-1).detail.captureMs, 900,
    'the new window takes effect on the following shot');
  cycle.cancel();
});

test('does not retain countdown samples or accept samples after the capture window', async () => {
  const clock = fakeClock();
  let analyzed = null;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    analyze: samples => { analyzed = samples; return {}; },
  });
  await settleStart(cycle);
  cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: 0 });
  await clock.advance(3000);
  cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: 3000 });
  await clock.advance(1000);
  cycle.addSample({ w: 1, x: 0, y: 0, z: 0, t: 4000 });
  assert.equal(analyzed.length, 1);
  assert.equal(analyzed[0].t, 3000);
});

test('cancelling during countdown clears pending work and prevents a result', async () => {
  const clock = fakeClock();
  let analyzed = false;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    analyze: () => { analyzed = true; return {}; },
  });
  await settleStart(cycle);
  cycle.cancel();
  await clock.advance(5000);
  assert.equal(cycle.state, 'ready');
  assert.equal(analyzed, false);
});

test('preparation failure is surfaced and a later shot can be retried', async () => {
  const clock = fakeClock();
  let fail = true;
  const cycle = create({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onPrepare: async () => !fail,
  });
  await settleStart(cycle);
  await clock.advance(3000);
  assert.equal(cycle.state, 'error');

  fail = false;
  assert.equal(await settleStart(cycle), true);
  await clock.advance(3000);
  assert.equal(cycle.state, 'capturing');
  await clock.advance(1000);
  assert.equal(cycle.state, 'ready');
});
