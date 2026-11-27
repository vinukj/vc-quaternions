const test = require('node:test');
const assert = require('node:assert/strict');
const ShotReport = require('../shot-report.js');
const WagonWheel = require('../wagon-wheel.js');

test('logs the displayed shot metrics, canonical field sector, map geometry, and raw quaternion samples', () => {
  const result = {
    direction: 'Up-right',
    fieldSector: 'Cover',
    swingDetected: true,
    battingHand: 'right',
    shotType: 'Cover-drive-like swing',
    directionConsistency: 'High',
    sideEstimate: 'Offside · right-handed stance',
    rotationDegrees: 58,
    netRotationDegrees: 51,
    peakAngularVelocityRadS: 5.4,
    averageAngularVelocityRadS: 2.1,
    estimatedLoftDegrees: 34,
    height: 'Estimated lofted',
    aggression: 'Assertive',
    dominantMotionVector: { x: 0.42, y: -0.31 },
  };
  const samples = [{ w: 0.99, x: 0.01, y: 0.02, z: 0.03, t: 100 }];
  const geometry = WagonWheel.shotGeometry(result, result.battingHand);
  let line = '';
  const logged = ShotReport.log(result, samples, { info: value => { line = value; } },
    '2026-11-15T00:00:00.000Z', geometry);

  assert.match(line, /^POWERPLAI_SHOT /);
  const parsed = JSON.parse(line.slice('POWERPLAI_SHOT '.length));
  assert.equal(parsed.displayedFields[0], 'Direction: Up-right · Cover');
  assert.equal(parsed.displayedFields[1], 'Direction zone: Offside front');
  assert.equal(parsed.displayedFields[2], 'Likely shot type: Lofted cover drive-like swing');
  assert.match(parsed.groundAriaLabel, /Up-right; mapped sector Cover/);
  assert.deepEqual(parsed.renderedMap.points, geometry.points);
  assert.match(parsed.displayedFields[3], /Possible strokes: Cover drive, Inside-out drive, Lofted cover drive, Square drive/);
  assert.equal(parsed.renderedMap.mappedSector, 'Cover');
  assert.deepEqual(parsed.samples, samples);
  assert.equal(parsed.displayedShotType, 'Lofted cover drive-like swing');
  assert.equal(parsed.result.shotType, 'Cover-drive-like swing', 'raw classifier shot type is preserved for diagnostics');
  assert.equal(logged.sampleCount, 1);
});

test('shot report and accessibility label use the same vector direction as the wagon wheel', () => {
  const result = {
    direction: 'Right',
    fieldSector: 'Point',
    shotType: 'Cut-like swing',
    swingDetected: true,
    battingHand: 'right',
    dominantMotionVector: { x: 0, y: 1 },
  };
  const geometry = WagonWheel.shotGeometry(result, 'right');
  const report = ShotReport.create(result, [], '2026-11-16T10:00:00.000Z', geometry);

  assert.equal(geometry.direction, 'Down');
  assert.equal(geometry.fieldSector, 'Behind batter');
  assert.equal(report.displayedFields[0], 'Direction: Down · Behind batter');
  assert.equal(report.displayedFields[1], 'Direction zone: Behind batter');
  assert.equal(report.displayedFields[2], 'Likely shot type: Back-foot / glance-like swing');
  assert.ok(report.displayedFields.includes('Side: Behind the batter'));
  assert.match(report.groundAriaLabel, /bat direction Down; mapped sector Behind batter/);
  assert.match(report.groundAriaLabel, /stroke estimate Back-foot \/ glance-like swing/);
  assert.equal(report.displayedDirection, 'Down');
  assert.equal(report.displayedFieldSector, 'Behind batter');
  assert.equal(report.displayedFieldZone, 'Behind batter');
  assert.equal(report.displayedShotType, 'Back-foot / glance-like swing');
  assert.equal(report.displayedSideEstimate, 'Behind the batter');
  assert.equal(report.result.direction, 'Right', 'raw classifier direction stays in the diagnostic payload');
});
