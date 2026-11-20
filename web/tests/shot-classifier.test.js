const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeShot } = require('../shot-classifier.js');
const WagonWheel = require('../wagon-wheel.js');

function axisAngle(axis, degrees) {
  const half = degrees * Math.PI / 360;
  const sine = Math.sin(half);
  return { w: Math.cos(half), x: axis.x * sine, y: axis.y * sine, z: axis.z * sine };
}

function samplesFor(axis, { degrees = 90, durationMs = 500, count = 26, reverse = false } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1);
    const signedAngle = degrees * progress * (reverse ? -1 : 1);
    return { ...axisAngle(axis, signedAngle), t: durationMs * progress };
  });
}

function zMotionPhases(phases, totalMs = 1000, stepMs = 20) {
  let angle = 0;
  let t = 0;
  const samples = [{ ...axisAngle({ x: 0, y: 0, z: 1 }, 0), t }];
  for (const phase of phases) {
    const steps = Math.round(phase.durationMs / stepMs);
    for (let index = 0; index < steps; index++) {
      angle += (phase.velocityRadS || 0) * stepMs / 1000;
      t += stepMs;
      samples.push({ ...axisAngle({ x: 0, y: 0, z: 1 }, angle * 180 / Math.PI), t });
    }
  }
  while (t < totalMs) {
    t += stepMs;
    samples.push({ ...axisAngle({ x: 0, y: 0, z: 1 }, angle * 180 / Math.PI), t });
  }
  return samples;
}

function planarMotionPhases(phases, totalMs = 1000, stepMs = 20) {
  let pose = { w: 1, x: 0, y: 0, z: 0 };
  let t = 0;
  const samples = [{ ...pose, t }];
  for (const phase of phases) {
    t += phase.gapMs || 0;
    const steps = Math.round(phase.durationMs / stepMs);
    const axis = { x: 0, y: -Math.sin(phase.heading), z: Math.cos(phase.heading) };
    for (let index = 0; index < steps; index++) {
      const increment = axisAngle(axis, phase.velocityRadS * stepMs * 180 / (Math.PI * 1000));
      pose = multiply(pose, increment);
      t += stepMs;
      samples.push({ ...pose, t });
    }
  }
  while (t < totalMs) {
    t += stepMs;
    samples.push({ ...pose, t });
  }
  return samples;
}

function multiply(a, b) {
  return {
    w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
    x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
    y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
    z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
  };
}

function conjugate(q) {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

test('derives angular velocity, accumulated rotation, and screen direction from quaternion deltas', () => {
  const result = analyzeShot(samplesFor({ x: 0, y: 0, z: 1 }));

  assert.ok(Math.abs(result.rotationDegrees - 90) < 0.01);
  assert.ok(Math.abs(result.peakAngularVelocityRadS - Math.PI) < 0.02);
  assert.equal(result.direction, 'Right');
  assert.equal(result.swingDetected, true);
});

test('shot direction stays screen-relative when firmware packets use a rotated guard frame', () => {
  const guard = axisAngle({ x: 0, y: 1, z: 0 }, 90);
  const localMotion = samplesFor({ x: 0, y: 0, z: 1 }, { degrees: 70, durationMs: 700, count: 36 });
  const firmwarePackets = localMotion.map(sample => ({
    ...multiply(multiply(guard, sample), conjugate(guard)),
    t: sample.t,
  }));

  const result = analyzeShot(firmwarePackets, { referenceQuaternion: guard });

  assert.equal(result.direction, 'Right');
  assert.ok(Math.abs(result.rotationDegrees - 70) < 0.01);
  assert.ok(Math.abs(result.peakAngularVelocityRadS - (70 * Math.PI / 180) / 0.7) < 0.02);
});

test('reports pitch direction and a heuristic drive family without claiming certainty', () => {
  const result = analyzeShot(samplesFor({ x: 0, y: 1, z: 0 }, { degrees: 80 }));

  assert.equal(result.direction, 'Up');
  assert.match(result.shotType, /glance-like/i);
  assert.equal(result.fieldSector, 'Straight');
  assert.equal(result.classificationBasis, 'heuristic');
});

test('maps screen-right to Point for a right-hander and mirrors sectors for a left-hander', () => {
  const rightHanded = analyzeShot(samplesFor({ x: 0, y: 0, z: 1 }));
  const leftHanded = analyzeShot(samplesFor({ x: 0, y: 0, z: 1 }), { battingHand: 'left' });

  assert.equal(rightHanded.direction, 'Right');
  assert.equal(rightHanded.fieldSector, 'Point');
  assert.match(rightHanded.shotType, /cut-like/i);
  assert.equal(leftHanded.fieldSector, 'Square leg');
  assert.match(leftHanded.shotType, /pull \/ sweep-like/i);
});

test('names cover and mid-on strokes from their canonical direction sectors', () => {
  const cover = analyzeShot(samplesFor({ x: 0, y: 1, z: 1 }));
  const midOn = analyzeShot(samplesFor({ x: 0, y: 1, z: -1 }));

  assert.equal(cover.direction, 'Up-right');
  assert.equal(cover.fieldSector, 'Cover');
  assert.equal(cover.shotType, 'Lofted cover drive-like swing');
  assert.equal(midOn.direction, 'Up-left');
  assert.equal(midOn.fieldSector, 'Mid-on');
  assert.equal(midOn.shotType, 'Lofted mid-on-directed drive-like swing');
  assert.equal(WagonWheel.shotGeometry(cover).shotType, cover.shotType);
  assert.equal(WagonWheel.shotGeometry(midOn).shotType, midOn.shotType);
});

test('uses the dominant fast stroke phase instead of slower setup movement', () => {
  const samples = zMotionPhases([
    { durationMs: 400, velocityRadS: 3 },
    { durationMs: 120, velocityRadS: -5 },
  ]);

  const result = analyzeShot(samples);

  assert.equal(result.direction, 'Left');
  assert.equal(result.fieldSector, 'Square leg');
  assert.match(result.shotType, /pull \/ sweep-like/i);
  assert.ok(result.dominantPathStartMs >= 380,
    'the faster directional lobe, not the long slow setup, should supply the shot vector');
  const geometry = WagonWheel.shotGeometry(result);
  assert.equal(geometry.direction, result.direction);
  assert.equal(geometry.fieldSector, result.fieldSector);
  assert.equal(geometry.shotType, result.shotType);
});

test('chooses a much stronger stroke lobe over an earlier decelerating bat-lift lobe', () => {
  const samples = zMotionPhases([
    { durationMs: 60, velocityRadS: -4 },
    { durationMs: 60, velocityRadS: -6 },
    { durationMs: 60, velocityRadS: -4 },
    { durationMs: 180, velocityRadS: 7 },
    { durationMs: 140, velocityRadS: 1.5 },
  ]);

  const result = analyzeShot(samples);

  assert.equal(result.direction, 'Right', 'the stronger stroke lobe should beat the leg-side lift');
  assert.equal(result.fieldSector, 'Point');
  assert.equal(result.directionLobeIndex, 1);
  assert.equal(result.directionLobeCount, 2);
  assert.equal(result.directionSelectionReason, 'strongest-lobe');
});

test('keeps the primary pre-peak path when a faster late follow-through reverses direction', () => {
  const samples = zMotionPhases([
    { durationMs: 220, velocityRadS: -3 },
    { durationMs: 80, velocityRadS: 0 },
    { durationMs: 120, velocityRadS: 8 },
  ]);

  const result = analyzeShot(samples);

  assert.equal(result.direction, 'Left');
  assert.equal(result.fieldSector, 'Square leg');
  assert.ok(result.dominantPathEndMs < 300,
    'the direction window must stop at the first substantial swing peak, before the late follow-through');
  assert.equal(result.dominantPathBurstCount, 2);
});

test('stops at the first clear swing peak when continuous follow-through reverses direction', () => {
  const samples = zMotionPhases([
    { durationMs: 120, velocityRadS: -5 },
    { durationMs: 80, velocityRadS: -3.5 },
    { durationMs: 120, velocityRadS: 8 },
  ]);

  const result = analyzeShot(samples);

  assert.equal(result.direction, 'Left');
  assert.ok(result.dominantPathEndMs <= 140,
    'a sustained first peak anchors the shot before the continuous reversing follow-through');
  assert.ok(result.opposingFollowThroughRatio > 1.25,
    'a larger follow-through is diagnostic, but does not replace the first shot path');
  const geometry = WagonWheel.shotGeometry(result);
  assert.equal(geometry.direction, result.direction);
  assert.equal(geometry.fieldSector, result.fieldSector);
  assert.equal(geometry.directionMismatch, false);
});

test('continuous angled follow-through after the speed peak cannot bend the dominant shot direction', () => {
  const samples = planarMotionPhases([
    { durationMs: 120, velocityRadS: 6, heading: 0 },
    { durationMs: 380, velocityRadS: 2.5, heading: Math.PI / 3 },
  ]);

  const result = analyzeShot(samples);

  assert.equal(result.direction, 'Right');
  assert.ok(result.dominantPathEndMs <= 140,
    'the selected path ends at the fast lobe peak, before slower angled follow-through');
  assert.ok(Math.abs(result.dominantMotionVector.y) < Math.abs(result.dominantMotionVector.x) * 0.15,
    'the slower post-peak path must not pull the selected shot vector off its launch heading');
  assert.equal(WagonWheel.shotGeometry(result).direction, result.direction);
});

test('a large packet-time gap splits motion bursts and cannot merge later direction into the shot path', () => {
  const samples = planarMotionPhases([
    { durationMs: 200, velocityRadS: 5, heading: 0 },
    { gapMs: 320, durationMs: 180, velocityRadS: 8, heading: Math.PI },
  ]);

  const result = analyzeShot(samples);

  assert.equal(result.direction, 'Right');
  assert.equal(result.dominantPathBurstCount, 2);
  assert.ok(result.dominantPathEndMs <= 220,
    'samples after the dropped-packet gap belong to a separate burst');
});

test('reports direction consistency separately from heuristic stroke family', () => {
  const result = analyzeShot(samplesFor({ x: 0, y: 0, z: -1 }));

  assert.equal(result.directionConsistency, 'High');
  assert.ok(result.directionConsistencyScore > 0.9);
  assert.equal(result.classificationBasis, 'heuristic');
});

test('direction consistency falls with dispersed active motion', () => {
  const samples = [];
  let pose = { w: 1, x: 0, y: 0, z: 0 };
  let t = 0;
  samples.push({ ...pose, t });
  for (let index = 0; index < 30; index++) {
    const axis = index % 2 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    pose = multiply(pose, axisAngle(axis, 4));
    t += 20;
    samples.push({ ...pose, t });
  }
  while (t < 1000) {
    t += 20;
    samples.push({ ...pose, t });
  }

  const result = analyzeShot(samples);

  assert.ok(result.directionConsistencyScore < 0.8,
    'alternating planar directions should score below a clean, straight movement');
  assert.ok(result.directionConsistencyScore >= 0, 'score remains bounded and non-negative');
});

test('direction consistency discounts a direction supported by only one active packet interval', () => {
  const samples = [
    { ...axisAngle({ x: 0, y: 0, z: -1 }, 0), t: 0 },
    { ...axisAngle({ x: 0, y: 0, z: -1 }, 20), t: 20 },
    { ...axisAngle({ x: 0, y: 0, z: -1 }, 20), t: 1000 },
  ];

  const result = analyzeShot(samples);

  assert.ok(result.directionConsistencyScore < 0.3);
  assert.equal(result.direction, 'No clear movement');
});

test('estimates aggression from configurable bat angular-speed bands', () => {
  const controlled = analyzeShot(samplesFor({ x: 0, y: 0, z: -1 }, { degrees: 50, durationMs: 1000 }), {
    swingThresholdRad: 0.5,
    powerLow: 1,
    powerHigh: 2,
  });
  const assertive = analyzeShot(samplesFor({ x: 0, y: 0, z: -1 }, { degrees: 100, durationMs: 1000 }), {
    swingThresholdRad: 0.5,
    powerLow: 1,
    powerHigh: 2,
  });
  const aggressive = analyzeShot(samplesFor({ x: 0, y: 0, z: -1 }, { degrees: 180, durationMs: 1000 }), {
    swingThresholdRad: 0.5,
    powerLow: 1,
    powerHigh: 2,
  });

  assert.equal(controlled.aggression, 'Controlled');
  assert.equal(assertive.aggression, 'Assertive');
  assert.equal(aggressive.aggression, 'Aggressive');
  assert.equal(analyzeShot(samplesFor({ x: 0, y: 0, z: 1 }, { degrees: 0 })).aggression, 'Unclear');
});

test('leaves direction and mapped stroke unclear when the dominant burst reverses equally', () => {
  const samples = zMotionPhases([
    { durationMs: 100, velocityRadS: -5 },
    { durationMs: 100, velocityRadS: 5 },
  ]);

  const result = analyzeShot(samples);

  assert.equal(result.direction, 'No clear movement');
  assert.equal(result.opposingPathsAmbiguous, true);
  assert.ok(result.opposingFollowThroughRatio >= 0.8 && result.opposingFollowThroughRatio <= 1.25);
  assert.equal(result.fieldSector, 'Unclear');
  assert.equal(result.directionConsistency, 'Unclear');
  assert.equal(result.shotType, 'Shot direction unclear');
});

test('quaternion sign flips do not create false rotation', () => {
  const samples = samplesFor({ x: 0, y: 0, z: 1 }, { degrees: 0, count: 26 });
  const result = analyzeShot(samples.map((sample, index) => index % 2 ? Object.fromEntries(
    Object.entries(sample).map(([key, value]) => [key, key === 't' ? value : -value]),
  ) : sample));

  assert.equal(result.rotationDegrees, 0);
  assert.equal(result.swingDetected, false);
  assert.equal(result.direction, 'No clear movement');
});

test('too-short captures remain insufficient while badly gapped captures avoid speed claims', () => {
  assert.equal(analyzeShot(samplesFor({ x: 0, y: 0, z: 1 }, { count: 2, durationMs: 400 })).status, 'insufficient-data');
  const gapped = samplesFor({ x: 0, y: 0, z: 1 }, { count: 4, durationMs: 1000 });
  const result = analyzeShot(gapped);

  assert.equal(result.status, 'no-clear-swing');
  assert.ok(result.rotationDegrees > 0, 'observed packet changes contribute to whole-shot rotation');
  assert.equal(result.peakAngularVelocityRadS, 0, 'gaps above the timing limit cannot produce a speed estimate');
});

test('keeps whole-capture rotation when sparse packets cannot support velocity classification', () => {
  const samples = [0, 500, 1000].map((t, index) => ({
    ...axisAngle({ x: 0, y: 0, z: -1 }, 45 * index),
    t,
  }));

  const result = analyzeShot(samples);

  assert.equal(result.sampleCount, 3);
  assert.equal(result.capturedMs, 1000);
  assert.ok(Math.abs(result.rotationDegrees - 90) < 0.01,
    'rotation uses all observed packet-to-packet changes in the one-second shot');
  assert.ok(Math.abs(result.netRotationDegrees - 90) < 0.01);
  assert.equal(result.peakAngularVelocityRadS, 0,
    'large packet gaps are not used to claim a peak swing speed');
  assert.equal(result.swingDetected, false,
    'sparse timing cannot satisfy the swing-speed threshold');
});

test('uses the net orientation change as a minimum rotation estimate with only two window samples', () => {
  const samples = [0, 1000].map((t, index) => ({
    ...axisAngle({ x: 0, y: 0, z: -1 }, 90 * index),
    t,
  }));

  const result = analyzeShot(samples);

  assert.equal(result.sampleCount, 2);
  assert.equal(result.capturedMs, 1000);
  assert.equal(result.status, 'insufficient-data');
  assert.equal(result.direction, 'No clear movement');
  assert.equal(result.swingDetected, false);
  assert.ok(Math.abs(result.rotationDegrees - 90) < 0.01);
  assert.ok(Math.abs(result.netRotationDegrees - 90) < 0.01);
  assert.equal(result.peakAngularVelocityRadS, 0);
});

test('non-finite samples are ignored and cannot poison the motion estimate', () => {
  const samples = samplesFor({ x: 0, y: 0, z: -1 });
  samples.splice(12, 0, { w: NaN, x: 0, y: 0, z: 0, t: 250 });
  const result = analyzeShot(samples);

  assert.equal(result.sampleCount, 26);
  assert.ok(Number.isFinite(result.peakAngularVelocityRadS));
});
