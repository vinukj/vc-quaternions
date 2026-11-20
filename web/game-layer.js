/* Browser-only deterministic cricket-game outcome simulation. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameLayer = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const DEFAULT_CONFIG = Object.freeze({
    difficulty: 'dry_pitch',
    bowled_prob: 3,
    edge_base_prob: 10,
    capture_window_ms: 525,
  });
  const DIFFICULTIES = Object.freeze(['dry_pitch', 'green_pitch', 'flat_pitch']);
  const CAPTURE_WINDOWS = Object.freeze([400, 500, 525, 600, 700, 800, 900]);
  const DIFFICULTY = Object.freeze({
    dry_pitch: { distance: 0.88, goodTiming: 0.56 },
    green_pitch: { distance: 0.78, goodTiming: 0.46 },
    flat_pitch: { distance: 1.08, goodTiming: 0.68 },
  });

  function normalizeConfig(value = {}) {
    const config = { ...DEFAULT_CONFIG };
    if (DIFFICULTIES.includes(value.difficulty)) config.difficulty = value.difficulty;
    if (Number.isInteger(value.bowled_prob) && value.bowled_prob >= 0 && value.bowled_prob <= 100) {
      config.bowled_prob = value.bowled_prob;
    }
    if (Number.isInteger(value.edge_base_prob) && value.edge_base_prob >= 0 && value.edge_base_prob <= 100) {
      config.edge_base_prob = value.edge_base_prob;
    }
    config.edge_base_prob = Math.min(config.edge_base_prob, 100 - config.bowled_prob);
    if (CAPTURE_WINDOWS.includes(value.capture_window_ms)) config.capture_window_ms = value.capture_window_ms;
    return config;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index++) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  }

  function randomFor(seed, salt) {
    let value = (seed ^ hash(salt)) >>> 0;
    value = (value + 0x6D2B79F5) >>> 0;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }

  function token(value, fallback = 'unclear') {
    const normalized = String(value || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return normalized || fallback;
  }

  function createOutcome(raw = {}, geometry = {}, inputConfig = DEFAULT_CONFIG, ballNumber = 1) {
    const config = normalizeConfig(inputConfig);
    const difficulty = DIFFICULTY[config.difficulty];
    const direction = geometry.fieldSector || geometry.mappedSector || raw.fieldSector || geometry.direction || raw.direction;
    const shotName = geometry.shotCandidates?.[0] || geometry.shotType || raw.shotType;
    const vector = geometry.rawVector || raw.dominantMotionVector || {};
    const hasVector = Number.isFinite(vector.x) && Number.isFinite(vector.y) && Math.hypot(vector.x, vector.y) > 1e-8;
    const angle = hasVector
      ? (Math.round((Math.atan2(vector.x, -vector.y) * 180 / Math.PI + 360) % 360 * 10) / 10)
      : null;
    const peak = Number.isFinite(raw.peakAngularVelocityDegS)
      ? Math.round(raw.peakAngularVelocityDegS)
      : Number.isFinite(raw.peakAngularVelocityRadS) ? Math.round(raw.peakAngularVelocityRadS * 180 / Math.PI) : 0;
    const lofted = raw.height === 'Estimated lofted' || Math.abs(raw.estimatedLoftDegrees || 0) >= 30;
    const height = lofted ? clamp(Math.abs(raw.estimatedLoftDegrees || 30) / 90, 0.12, 1)
      : clamp(0.08 + Math.abs(raw.estimatedLoftDegrees || 0) / 180, 0.08, 0.35);
    const distance = clamp((0.18 + peak / 500 * 0.48 + height * 0.2) * difficulty.distance, 0.08, 1);
    const family = raw.shotType || geometry.shotType || 'Unclear';
    const seed = hash(`${ballNumber}|${direction || ''}|${shotName || ''}|${family}|${peak}|${config.difficulty}`);
    const roll = randomFor(seed, 'dismissal');
    const isBowled = roll < config.bowled_prob / 100;
    const remainingProbability = 100 - config.bowled_prob;
    const isEdged = !isBowled && remainingProbability > 0 &&
      randomFor(seed, 'edge') < config.edge_base_prob / remainingProbability;
    const goodTiming = difficulty.goodTiming;
    const timingRoll = randomFor(seed, 'timing');
    const timing = timingRoll < (1 - goodTiming) * 0.5 ? 'EARLY'
      : timingRoll > (1 + goodTiming) * 0.5 ? 'LATE' : 'GOOD';
    let runs = 0;
    if (!isBowled) {
      const runRoll = randomFor(seed, 'runs');
      if (isEdged) runs = runRoll < 0.72 ? 0 : runRoll < 0.94 ? 1 : 2;
      else if (distance < 0.25) runs = runRoll < 0.72 ? 0 : 1;
      else if (distance < 0.42) runs = runRoll < 0.65 ? 1 : runRoll < 0.94 ? 0 : 2;
      else if (distance < 0.62) runs = runRoll < 0.58 ? 1 : runRoll < 0.86 ? 2 : 3;
      else if (distance < 0.8) runs = runRoll < 0.48 ? 2 : runRoll < 0.83 ? 3 : 4;
      else runs = lofted && distance > 0.9
        ? (runRoll < 0.58 ? 4 : 6)
        : (runRoll < 0.52 ? 3 : runRoll < 0.9 ? 4 : 6);
      if (timing !== 'GOOD' && runs > 1) runs--;
    }

    return {
      direction: token(direction),
      shot: token(shotName),
      family,
      lofted,
      runs,
      dist: Math.round(distance * 100) / 100,
      h: Math.round(height * 100) / 100,
      agg: token(raw.aggression, 'unclear'),
      peak,
      angle,
      timing,
      out: isBowled,
      dismissal: isBowled ? 'bowled' : '',
      edged: isEdged,
      difficulty: config.difficulty,
      bowled_prob: config.bowled_prob,
      edge_base_prob: config.edge_base_prob,
      capture_window_ms: config.capture_window_ms,
    };
  }

  return { DEFAULT_CONFIG, DIFFICULTIES, CAPTURE_WINDOWS, normalizeConfig, createOutcome };
});
