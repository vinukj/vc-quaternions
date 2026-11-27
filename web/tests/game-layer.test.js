const test = require('node:test');
const assert = require('node:assert/strict');
const GameLayer = require('../game-layer.js');

test('provides the agreed defaults and normalizes invalid config values', () => {
  assert.deepEqual(GameLayer.DEFAULT_CONFIG, {
    difficulty: 'dry_pitch',
    bowled_prob: 3,
    edge_base_prob: 10,
    capture_window_ms: 525,
    sampcnt: 1,
  });
  assert.deepEqual(GameLayer.normalizeConfig({
    difficulty: 'unknown', bowled_prob: 150, edge_base_prob: -4, capture_window_ms: 425,
  }), GameLayer.DEFAULT_CONFIG);
  assert.deepEqual(GameLayer.normalizeConfig({ bowled_prob: 20, edge_base_prob: 90 }), {
    ...GameLayer.DEFAULT_CONFIG, bowled_prob: 20, edge_base_prob: 80,
  });
});

test('generates a repeatable gameplay result without changing raw shot data', () => {
  const raw = {
    direction: 'Right', fieldSector: 'Point', shotType: 'Cut-like swing',
    aggression: 'Aggressive', height: 'Estimated ground-level',
    estimatedLoftDegrees: 10, peakAngularVelocityDegS: 293,
    dominantMotionVector: { x: 0.8, y: 0 }, swingDetected: true,
  };
  const geometry = {
    direction: 'Right', fieldSector: 'Point', shotType: 'Cut-like swing',
    shotCandidates: ['Cut', 'Square cut'], rawVector: { x: 0.8, y: 0 },
  };
  const config = { ...GameLayer.DEFAULT_CONFIG, bowled_prob: 0, edge_base_prob: 0 };
  const snapshot = structuredClone(raw);
  const first = GameLayer.createOutcome(raw, geometry, config, 7);
  const second = GameLayer.createOutcome(raw, geometry, config, 7);

  assert.deepEqual(first, second);
  assert.deepEqual(raw, snapshot);
  assert.equal(first.direction, 'point');
  assert.equal(first.shot, 'cut');
  assert.equal(first.family, 'Cut-like swing');
  assert.equal(first.lofted, false);
  assert.equal(first.peak, 293);
  assert.equal(first.angle, 90);
  assert.ok(Number.isInteger(first.runs) && first.runs >= 0 && first.runs <= 6);
  assert.ok(first.dist >= 0 && first.dist <= 1);
  assert.ok(first.h >= 0 && first.h <= 1);
  assert.equal(first.out, false);
  assert.equal(first.dismissal, '');
  assert.equal(first.edged, false);
});

test('applies configured wicket and edge probabilities over a deterministic ball sequence', () => {
  const config = { ...GameLayer.DEFAULT_CONFIG, bowled_prob: 3, edge_base_prob: 10 };
  const counts = { out: 0, edged: 0 };
  for (let ball = 1; ball <= 1000; ball++) {
    const outcome = GameLayer.createOutcome({}, {}, config, ball);
    if (outcome.out) counts.out++;
    if (outcome.edged) counts.edged++;
    if (outcome.out) assert.equal(outcome.dismissal, 'bowled');
  }
  assert.ok(counts.out >= 20 && counts.out <= 40, `expected about 3%, got ${counts.out}/1000`);
  assert.ok(counts.edged >= 80 && counts.edged <= 120, `expected about 10%, got ${counts.edged}/1000`);
});

test('difficulty changes the deterministic simulation but does not alter source facts', () => {
  const raw = { direction: 'Up', fieldSector: 'Straight', shotType: 'Drive-like swing', peakAngularVelocityDegS: 400 };
  const dry = GameLayer.createOutcome(raw, {}, { ...GameLayer.DEFAULT_CONFIG, bowled_prob: 0, edge_base_prob: 0, difficulty: 'dry_pitch' }, 12);
  const flat = GameLayer.createOutcome(raw, {}, { ...GameLayer.DEFAULT_CONFIG, bowled_prob: 0, edge_base_prob: 0, difficulty: 'flat_pitch' }, 12);

  assert.notEqual(dry.difficulty, flat.difficulty);
  assert.notEqual(dry.dist, flat.dist);
});
