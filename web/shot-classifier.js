/*
 * Estimates bat motion from the quaternion-only BLE stream. The ESP32 packet
 * has no raw gyro or accelerometer channels, so cricket names are intentionally
 * labelled heuristic rather than ground truth.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./bat-screen-frame.js') : root.BatScreenFrame);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShotClassifier = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function (BatScreenFrame) {
  const RAD_TO_DEG = 180 / Math.PI;
  // A 400 ms window yields roughly 20 packets at 50 Hz; shorter spans are
  // still rejected to avoid classifying only a few noisy orientation steps.
  const MIN_CAPTURE_MS = 350;
  const DEFAULT_SAMPLE_RATE_HZ = 50;
  // A gap of ~11 sample intervals (220 ms at 50 Hz) marks a dropped-packet
  // break; it scales with the configured BLE cadence.
  const MAX_GAP_INTERVALS = 11;
  const MAX_BURST_GAP_INTERVALS = 2;
  const LATER_LOBE_DISTANCE_RATIO = 1.25;

  function normalize(q) {
    if (!q) return null;
    const length = Math.hypot(q.w, q.x, q.y, q.z);
    if (!Number.isFinite(length) || length < 1e-8) return null;
    return { w: q.w / length, x: q.x / length, y: q.y / length, z: q.z / length };
  }

  function conjugate(q) {
    return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
  }

  function multiply(a, b) {
    return {
      w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
      x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
      y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
      z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
    };
  }

  function relativeQuat(a, b) {
    // Match DirectionTracker: this increment is in the captured stance frame,
    // so its projected axis does not rotate with the bat during a swing.
    let delta = normalize(multiply(b, conjugate(a)));
    if (!delta) return null;
    // q and -q encode the same pose. Pick the shortest signed rotation.
    if (delta.w < 0) delta = { w: -delta.w, x: -delta.x, y: -delta.y, z: -delta.z };
    return delta;
  }

  function screenDelta(a, b) {
    let delta = normalize(multiply(b, conjugate(a)));
    if (delta && delta.w < 0) delta = { w: -delta.w, x: -delta.x, y: -delta.y, z: -delta.z };
    return delta;
  }

  function rotationOf(q) {
    const vectorLength = Math.hypot(q.x, q.y, q.z);
    if (vectorLength < 1e-10) return { angle: 0, axis: { x: 0, y: 0, z: 0 } };
    return {
      angle: 2 * Math.atan2(vectorLength, Math.max(0, q.w)),
      axis: { x: q.x / vectorLength, y: q.y / vectorLength, z: q.z / vectorLength },
    };
  }

  function quatDeltaMagRad(a, b) {
    const delta = relativeQuat(a, b);
    return delta ? rotationOf(delta).angle : 0;
  }

  function directionFor(dx, dy) {
    if (Math.hypot(dx, dy) < 1e-5) return 'No clear movement';
    // +x is screen-right, +y is screen-down.
    const angle = Math.atan2(-dy, dx);
    const labels = ['Right', 'Up-right', 'Up', 'Up-left', 'Left', 'Down-left', 'Down', 'Down-right'];
    return labels[Math.round(angle / (Math.PI / 4) + 8) % 8];
  }

  function emptyResult(sampleCount = 0, sampleRateHz = DEFAULT_SAMPLE_RATE_HZ) {
    return {
      status: 'insufficient-data',
      direction: 'No clear movement',
      fieldSector: 'Unclear',
      sideEstimate: 'Unclear',
      shotType: 'Not enough motion data',
      classificationBasis: 'heuristic',
      swingDetected: false,
      sampleCount,
      sampleRateHz,
      capturedMs: 0,
      rotationDegrees: 0,
      netRotationDegrees: 0,
      peakAngularVelocityRadS: 0,
      peakAngularVelocityDegS: 0,
      averageAngularVelocityRadS: 0,
      estimatedLoftDegrees: 0,
      directionConsistencyScore: 0,
      directionConsistency: 'Unclear',
      classificationMethod: 'dominant directional lobe through its speed peak → likely stroke family',
      height: 'Unclear',
      power: 'Unclear',
      aggression: 'Unclear',
    };
  }

  function fieldSectorFor(direction, battingHand = 'right') {
    const sectors = ['Straight', 'Cover', 'Point', 'Third man', 'Behind batter', 'Fine leg', 'Square leg', 'Mid-on'];
    const directions = ['Up', 'Up-right', 'Right', 'Down-right', 'Down', 'Down-left', 'Left', 'Up-left'];
    const directionIndex = directions.indexOf(direction);
    if (directionIndex < 0) return 'Unclear';
    const sectorIndex = battingHand === 'left' ? (8 - directionIndex) % 8 : directionIndex;
    return sectors[sectorIndex];
  }

  function shotTypeFor(fieldSector, lofted, isPitchDominant = false) {
    const families = {
      Straight: 'straight drive-like swing',
      Cover: 'cover drive-like swing',
      Point: 'cut-like swing',
      'Third man': 'late-cut-like swing',
      'Behind batter': 'back-foot / glance-like swing',
      'Fine leg': 'flick / glance-like swing',
      'Square leg': 'pull / sweep-like swing',
      'Mid-on': 'mid-on-directed drive-like swing',
    };
    const family = families[fieldSector];
    if (!family) return 'Shot direction unclear';
    // Pitch-dominant motion with high loft behaves like a glance
    if (isPitchDominant && lofted) return 'lofted glance-like swing';
    return lofted ? `Lofted ${family}` : family[0].toUpperCase() + family.slice(1);
  }

  function analyzeShot(inputSamples, params = {}) {
    const sampleRateHz = Number.isFinite(params.sampleRateHz) && params.sampleRateHz > 0
      ? params.sampleRateHz : DEFAULT_SAMPLE_RATE_HZ;
    const sampleIntervalMs = 1000 / sampleRateHz;
    const maxSampleGapMs = sampleIntervalMs * MAX_GAP_INTERVALS;
    const guard = normalize(params.referenceQuaternion) || { w: 1, x: 0, y: 0, z: 0 };
    const samples = (Array.isArray(inputSamples) ? inputSamples : [])
      .map(sample => {
        const packet = normalize(sample);
        if (!packet || !Number.isFinite(sample.t)) return null;
        // Firmware packets are q_current * inverse(q_guard), a world-frame
        // rotation. Conjugate them into the captured stance/screen frame.
        const q = normalize(multiply(multiply(conjugate(guard), packet), guard));
        return q ? { ...q, t: sample.t } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
    // Two endpoint poses reveal elapsed time and a minimum net rotation, but
    // cannot establish a reliable motion path, speed, or direction.
    const capturedMs = samples.length > 1 ? samples.at(-1).t - samples[0].t : 0;
    if (samples.length < 3 || capturedMs < MIN_CAPTURE_MS) {
      const result = emptyResult(samples.length, sampleRateHz);
      result.capturedMs = Math.max(0, capturedMs);
      if (samples.length >= 2) {
        const endpointDelta = screenDelta(samples[0], samples.at(-1));
        if (endpointDelta) {
          const endpointRotation = rotationOf(endpointDelta).angle * RAD_TO_DEG;
          result.rotationDegrees = endpointRotation;
          result.netRotationDegrees = endpointRotation;
        }
      }
      return result;
    }

    const deltas = [];
    const observedDeltas = [];
    for (let index = 1; index < samples.length; index++) {
      const a = samples[index - 1];
      const b = samples[index];
      const dtMs = b.t - a.t;
      if (!(dtMs > 0)) continue;
      // BLE notifications can arrive in bursts, so use the configured cadence
      // for velocity/path weighting. Keep callback timestamps for capture span
      // and for detecting actual long gaps.
      const delta = relativeQuat(a, b);
      if (!delta) continue;
      const rotation = rotationOf(delta);
      observedDeltas.push(rotation);
      // Keep every observed orientation change in the whole-shot rotation,
      // but only trust short intervals for instantaneous speed and direction.
      if (dtMs > maxSampleGapMs) continue;
      const dt = sampleIntervalMs / 1000;
      const velocity = rotation.angle / dt;
      const previousDelta = deltas.at(-1);
      const axialRoll = BatScreenFrame.isAxialRoll({
        x: rotation.axis.x * rotation.angle,
        y: rotation.axis.y * rotation.angle,
        z: rotation.axis.z * rotation.angle,
      }, b);
      deltas.push({
        ...rotation,
        dt,
        velocity,
        startMs: a.t,
        endMs: b.t,
        continuousFromPrevious: !previousDelta || a.t - previousDelta.endMs <= maxSampleGapMs,
        // Axial X roll contributes to swing magnitude but not map heading.
        // Use the same current-bat-axis rejection as the live pointer.
        screenVelocity: axialRoll ? { x: 0, y: 0 } : BatScreenFrame.rotationToScreen({
          x: rotation.axis.x * velocity,
          y: rotation.axis.y * velocity,
          z: rotation.axis.z * velocity,
        }),
      });
    }

    const peakVelocity = deltas.length ? Math.max(...deltas.map(delta => delta.velocity)) : 0;
    const totalRotation = observedDeltas.reduce((sum, delta) => sum + delta.angle, 0);
    const startToEnd = rotationOf(screenDelta(samples[0], samples.at(-1)));
    // Select the first substantial speed peak, then use only its rising path.
    // The post-peak bat motion is often follow-through and must not redirect
    // the shot sector. Lower burst activation retains a real stroke when the
    // follow-through is faster; the 70%-of-peak start trims slower setup.
    const smoothedPlanarSpeed = deltas.map((delta, index) => {
      let x = 0;
      let y = 0;
      let weight = 0;
      const neighbors = [
        ...(index > 0 && delta.continuousFromPrevious ? [index - 1] : []),
        index,
        ...(index + 1 < deltas.length && deltas[index + 1].continuousFromPrevious ? [index + 1] : []),
      ];
      for (const cursor of neighbors) {
        const neighborWeight = cursor === index ? 2 : 1;
        x += deltas[cursor].screenVelocity.x * neighborWeight;
        y += deltas[cursor].screenVelocity.y * neighborWeight;
        weight += neighborWeight;
      }
      return Math.hypot(x / weight, y / weight);
    });
    const peakPlanarSpeed = Math.max(0, ...smoothedPlanarSpeed);
    const activeThreshold = Math.max(0.45, peakPlanarSpeed * 0.3);
    const bursts = [];
    for (let index = 0; index < deltas.length;) {
      if (smoothedPlanarSpeed[index] < activeThreshold) {
        index++;
        continue;
      }
      const start = index;
      let lastActive = index;
      let activeIntervals = 1;
      let rotation = deltas[index].angle;
      let peakSpeed = smoothedPlanarSpeed[index];
      for (let cursor = index + 1; cursor < deltas.length; cursor++) {
        if (!deltas[cursor].continuousFromPrevious) break;
        if (smoothedPlanarSpeed[cursor] < activeThreshold) continue;
        if (cursor - lastActive - 1 > MAX_BURST_GAP_INTERVALS) break;
        lastActive = cursor;
        activeIntervals++;
        rotation += deltas[cursor].angle;
        peakSpeed = Math.max(peakSpeed, smoothedPlanarSpeed[cursor]);
      }
      bursts.push({
        startIndex: start,
        endIndex: lastActive,
        peakSpeed,
        rotation,
        activeIntervals,
      });
      index = lastActive + 1;
    }
    // Select the earliest sustained burst that clears the relative activity
    // threshold. A later, faster burst after a quiet gap is usually recovery /
    // follow-through; it must not replace the initial stroke path. Requiring
    // several intervals and meaningful rotation filters isolated packet noise.
    const primaryBurst = bursts.find(burst =>
      burst.activeIntervals >= 3 && burst.rotation >= 0.12 && burst.peakSpeed >= activeThreshold,
    ) || bursts[0];
    // Split the first active burst into directional lobes. Planar speed alone
    // is unsigned: a fast reversal can otherwise look like the continuation
    // of the stroke and steal the shot direction from the pre-impact path.
    const directionalRuns = [];
    if (primaryBurst) {
      let run = null;
      for (let index = primaryBurst.startIndex; index <= primaryBurst.endIndex; index++) {
        if (!deltas[index].continuousFromPrevious && run) {
          directionalRuns.push(run);
          run = null;
        }
        if (smoothedPlanarSpeed[index] < activeThreshold) continue;
        const delta = deltas[index];
        const speed = Math.hypot(delta.screenVelocity.x, delta.screenVelocity.y);
        if (speed < 1e-8) continue;
        const velocity = delta.screenVelocity;
        const direction = { x: velocity.x / speed, y: velocity.y / speed };
        const runLength = run ? Math.hypot(run.vector.x, run.vector.y) : 0;
        const alignment = runLength > 1e-8
          ? (velocity.x * run.vector.x + velocity.y * run.vector.y) / (speed * runLength)
          : 1;
        // A turn greater than about 110 degrees begins a new lobe; ordinary
        // curvature within a swing remains part of the same dominant path.
        if (run && alignment < -0.35) {
          directionalRuns.push(run);
          run = null;
        }
        if (!run) {
          run = { indices: [], vector: { x: 0, y: 0 }, distance: 0, peakSpeed: 0 };
        }
        run.indices.push(index);
        run.vector.x += velocity.x * delta.dt;
        run.vector.y += velocity.y * delta.dt;
        run.distance += speed * delta.dt;
        run.peakSpeed = Math.max(run.peakSpeed, smoothedPlanarSpeed[index]);
        run.lastDirection = direction;
      }
      if (run) directionalRuns.push(run);
    }

    // A first lobe that peaks and visibly decelerates before turning is the
    // best available impact-phase anchor. If motion merely ramps up or stays
    // level into a reversal, treat that lobe as setup and choose the strongest
    // sustained directional lobe instead. A later separate burst never gets
    // considered here, even if its peak speed is larger.
    const supportedRuns = directionalRuns.filter(run => run.indices.length >= 3 && run.distance >= 0.12);
    const candidateRuns = supportedRuns.length ? supportedRuns : directionalRuns;
    const firstRun = candidateRuns[0];
    if (firstRun && firstRun.indices.length >= 4 && directionalRuns.length > 1) {
      const tail = firstRun.indices.slice(-3).map(index => smoothedPlanarSpeed[index]).sort((a, b) => a - b);
      const tailMedian = tail[Math.floor(tail.length / 2)];
      firstRun.hasPreReversalDeceleration = tailMedian <= firstRun.peakSpeed * 0.82;
    } else if (firstRun) {
      firstRun.hasPreReversalDeceleration = false;
    }
    const strongestRun = candidateRuns.reduce((best, candidate) =>
      !best || candidate.peakSpeed > best.peakSpeed ? candidate : best, null);
    const strongestDistanceRun = candidateRuns.reduce((best, candidate) =>
      !best || candidate.distance > best.distance ? candidate : best, null);
    const laterLobeClearlyDominates = firstRun?.hasPreReversalDeceleration && strongestDistanceRun !== firstRun &&
      strongestDistanceRun.distance >= firstRun.distance * LATER_LOBE_DISTANCE_RATIO;
    const chosenRun = laterLobeClearlyDominates ? strongestDistanceRun
      : firstRun?.hasPreReversalDeceleration ? firstRun : strongestRun;
    const directionLobeIndex = Math.max(0, candidateRuns.indexOf(chosenRun));
    const directionSelectionReason = laterLobeClearlyDominates ? 'strongest-lobe'
      : firstRun?.hasPreReversalDeceleration ? 'first-decelerating-lobe'
        : chosenRun !== firstRun ? 'strongest-lobe' : 'first-lobe';
    let dominantPathIndices = chosenRun?.indices ?? [];
    if (dominantPathIndices.length) {
      // Stop at the end of the selected speed peak even if the bat keeps
      // moving in a similar direction; post-peak motion is follow-through.
      const peak = Math.max(...dominantPathIndices.map(index => smoothedPlanarSpeed[index]));
      let peakEnd = dominantPathIndices[0];
      for (const index of dominantPathIndices) {
        if (smoothedPlanarSpeed[index] >= peak * 0.95) peakEnd = index;
      }
      dominantPathIndices = dominantPathIndices.filter(index => index <= peakEnd);
    }
    const dominantPath = dominantPathIndices.map(index => deltas[index]);
    const dominantMotionVector = dominantPath.reduce((sum, delta) => ({
      x: sum.x + delta.screenVelocity.x * delta.dt,
      y: sum.y + delta.screenVelocity.y * delta.dt,
    }), { x: 0, y: 0 });
    const dominantLength = Math.hypot(dominantMotionVector.x, dominantMotionVector.y);
    const primaryDirection = dominantLength > 1e-8
      ? { x: dominantMotionVector.x / dominantLength, y: dominantMotionVector.y / dominantLength }
      : null;
    let alignedPath = 0;
    let activePath = 0;
    if (primaryDirection) {
      for (const delta of dominantPath) {
        const speed = Math.hypot(delta.screenVelocity.x, delta.screenVelocity.y);
        const distance = speed * delta.dt;
        if (speed < 1e-8 || distance < 1e-8) continue;
        activePath += distance;
        alignedPath += distance * Math.max(0, Math.min(1,
          (delta.screenVelocity.x * primaryDirection.x + delta.screenVelocity.y * primaryDirection.y) / speed));
      }
    }
    let opposingFollowThroughDistance = 0;
    if (primaryDirection && chosenRun && primaryBurst) {
      const lastChosenIndex = dominantPathIndices.at(-1);
      for (let index = lastChosenIndex + 1; index <= primaryBurst.endIndex; index++) {
        const delta = deltas[index];
        const speed = Math.hypot(delta.screenVelocity.x, delta.screenVelocity.y);
        if (speed < 1e-8 || smoothedPlanarSpeed[index] < activeThreshold) continue;
        const alongShot = (delta.screenVelocity.x * primaryDirection.x + delta.screenVelocity.y * primaryDirection.y) / speed;
        opposingFollowThroughDistance += speed * delta.dt * Math.max(0, -alongShot);
      }
    }
    const opposingFollowThroughRatio = dominantLength > 1e-8
      ? opposingFollowThroughDistance / dominantLength : 0;
    // If a similarly sized, nearly opposite path follows the chosen peak,
    // there is no defensible single direction (e.g. a deliberate reversal).
    const opposingPathsAmbiguous = opposingFollowThroughRatio >= 0.8 && opposingFollowThroughRatio <= 1.25;
    const dominantPathConsistency = activePath > 1e-8 && !opposingPathsAmbiguous
      ? Math.max(0, Math.min(1, (alignedPath / activePath) ** 2 * Math.min(1, dominantPath.length / 5)))
      : 0;
    const directionConsistencyScore = dominantPathConsistency;
    const directionConsistency = directionConsistencyScore >= 0.8 ? 'High'
      : directionConsistencyScore >= 0.55 ? 'Moderate'
        : directionConsistencyScore >= 0.3 ? 'Low' : 'Unclear';

    // X is the bat's long/roll axis; Z and Y project onto the facing-screen
    // plane. This reports screen direction; field side still depends on stance.
    const direction = dominantPathConsistency >= 0.3
      ? directionFor(dominantMotionVector.x, dominantMotionVector.y)
      : 'No clear movement';
    const batAxis = { x: 1, y: 0, z: 0 };
    const relativePose = screenDelta(samples[0], samples.at(-1));
    const rotatedAxis = multiply(multiply(relativePose, { w: 0, ...batAxis }), conjugate(relativePose));
    const estimatedLoftDegrees = Math.asin(Math.max(-1, Math.min(1, rotatedAxis.z))) * RAD_TO_DEG;
    const heightBound = Number.isFinite(params.heightBound) ? params.heightBound : 30;
    const lofted = Math.abs(estimatedLoftDegrees) >= heightBound;
    const swingThreshold = Number.isFinite(params.swingThresholdRad) ? params.swingThresholdRad : 2;
    const battingHand = params.battingHand === 'left' ? 'left' : 'right';
    const fieldSector = fieldSectorFor(direction, battingHand);
    const swingDetected = peakVelocity >= swingThreshold && totalRotation * RAD_TO_DEG >= 12;
    const averageVelocity = totalRotation / (capturedMs / 1000);
    const powerLow = Number.isFinite(params.powerLow) ? Math.max(0, params.powerLow) : 3;
    const configuredPowerHigh = Number.isFinite(params.powerHigh) ? params.powerHigh : 6;
    const powerHigh = Math.max(powerLow, configuredPowerHigh);
    const power = peakVelocity < powerLow ? 'Low' : peakVelocity < powerHigh ? 'Medium' : 'High';
    // This is a bat-speed proxy for aggression, not a measure of intent or
    // ball speed. Avoid reporting a category if the motion didn't pass swing
    // detection at all.
    const aggression = !swingDetected ? 'Unclear'
      : power === 'Low' ? 'Controlled'
        : power === 'Medium' ? 'Assertive' : 'Aggressive';
    const sideEstimate = fieldSector === 'Straight' ? 'Straight' :
      fieldSector === 'Behind batter' ? 'Behind the batter' :
        ['Cover', 'Point', 'Third man'].includes(fieldSector) ? `Offside · ${battingHand}-handed stance` :
          `${battingHand === 'right' ? 'Legside' : 'Offside'} · ${battingHand}-handed stance`;

    return {
      status: swingDetected ? 'swing-detected' : 'no-clear-swing',
      direction,
      fieldSector,
      sideEstimate,
      // Pitch-dominant motion (x=0 in motion vector) behaves like a glance
      isPitchDominant: Math.abs(dominantMotionVector.x) < 1e-8,
      shotType: swingDetected ? shotTypeFor(fieldSector, lofted, Math.abs(dominantMotionVector.x) < 1e-8) : 'No clear shot detected',
      classificationBasis: 'heuristic',
      classificationMethod: 'dominant directional lobe through its speed peak → likely stroke family',
      directionConsistencyScore,
      directionConsistency,
      swingDetected,
      sampleCount: samples.length,
      sampleRateHz,
      capturedMs,
      rotationDegrees: totalRotation * RAD_TO_DEG,
      netRotationDegrees: startToEnd.angle * RAD_TO_DEG,
      peakAngularVelocityRadS: peakVelocity,
      peakAngularVelocityDegS: peakVelocity * RAD_TO_DEG,
      averageAngularVelocityRadS: averageVelocity,
      estimatedLoftDegrees,
      dominantMotionVector,
      dominantPathStartMs: dominantPath[0]?.startMs ?? null,
      dominantPathEndMs: dominantPath.at(-1)?.endMs ?? null,
      dominantPathBurstCount: bursts.length,
      directionLobeIndex: chosenRun ? directionLobeIndex : null,
      directionLobeCount: candidateRuns.length,
      directionSelectionReason: chosenRun ? directionSelectionReason : 'no-directional-lobe',
      opposingFollowThroughRatio,
      opposingPathsAmbiguous,
      battingHand,
      height: lofted ? 'Estimated lofted' : 'Estimated ground-level',
      power,
      aggression,
    };
  }

  // Preserve the small legacy surface used by the automatic swing detector.
  function classifyShot(samples, params) {
    const result = analyzeShot(samples, params);
    return {
      name: result.shotType,
      direction: result.direction,
      height: result.height,
      power: result.power,
      aggression: result.aggression,
      swingPlane: null,
      peakVelocity: result.peakAngularVelocityRadS,
      lofted: result.height === 'Estimated lofted',
      confidence: result.swingDetected ? 'low' : 0,
      ...result,
    };
  }

  return { analyzeShot, classifyShot, quatDeltaMagRad, relativeQuat, directionFor, fieldSectorFor };
});
