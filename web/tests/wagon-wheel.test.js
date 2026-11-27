const test = require('node:test');
const assert = require('node:assert/strict');
const { sectorForDirection, shotGeometry, draw } = require('../wagon-wheel.js');

test('assigns eight field sectors for a right-handed batter and mirrors them for a left-hander', () => {
  assert.equal(sectorForDirection('Up').name, 'Straight');
  assert.equal(sectorForDirection('Up-right').name, 'Cover');
  assert.equal(sectorForDirection('Right').name, 'Point');
  assert.equal(sectorForDirection('Down-right').name, 'Third man');
  assert.equal(sectorForDirection('Down-left', 'left').name, 'Third man');
  assert.equal(sectorForDirection('Right', 'left').name, 'Square leg');
  assert.equal(sectorForDirection('Sideways'), null);
});

test('physical batter-right is screen-left and maps to Square Leg for a right-hander', () => {
  assert.equal(sectorForDirection('Left', 'right').name, 'Square leg');
  assert.equal(sectorForDirection('Right', 'right').name, 'Point');
  assert.equal(sectorForDirection('Left', 'left').name, 'Point');
  assert.equal(sectorForDirection('Right', 'left').name, 'Square leg');
});

test('preserves the workbook right-handed direction-to-sector examples', () => {
  for (const [direction, fieldSector] of [
    ['Up-right', 'Cover'],
    ['Up', 'Straight'],
    ['Left', 'Square leg'],
    ['Down-right', 'Third man'],
  ]) {
    assert.equal(sectorForDirection(direction, 'right').name, fieldSector);
  }
});

test('maps eight field sectors into the five batter-relative direction zones', () => {
  const expected = new Map([
    ['Up', 'Straight'],
    ['Up-right', 'Offside front'],
    ['Right', 'Offside back'],
    ['Down-right', 'Offside back'],
    ['Down', 'Behind batter'],
    ['Down-left', 'Legside back'],
    ['Left', 'Legside back'],
    ['Up-left', 'Legside front'],
  ]);

  for (const [direction, fieldZone] of expected) {
    assert.equal(shotGeometry({ direction, swingDetected: true }).fieldZone, fieldZone, direction);
  }
  assert.equal(shotGeometry({ direction: 'Up-right' }, 'left').fieldZone, 'Legside front',
    'the broad zone mirrors with the left-handed detailed field sector');
});

test('shot direction, field sector, and arrow all follow the same dominant motion vector', () => {
  const geometry = shotGeometry({
    direction: 'Up-left',
    fieldSector: 'Mid-on',
    shotType: 'cut-like swing',
    swingDetected: true,
    battingHand: 'right',
    directionConsistencyScore: 0.9,
    dominantMotionVector: { x: 0.4, y: 0.5 },
  });

  assert.equal(geometry.direction, 'Down-right');
  assert.equal(geometry.mappedSector, 'Third man');
  assert.equal(geometry.sector.name, geometry.mappedSector);
  assert.equal(geometry.classifierDirection, 'Up-left');
  assert.equal(geometry.classifierSector, 'Mid-on');
  assert.equal(geometry.shotType, 'Late-cut-like swing');
  assert.equal(geometry.sideEstimate, 'Offside · right-handed stance');
  assert.equal(geometry.directionMismatch, true);
  assert.ok(geometry.points.at(-1).x > 0);
  assert.ok(geometry.points.at(-1).y > 0);
});

test('snaps the rendered arrow to the selected sector while retaining the measured vector', () => {
  const vector = { x: 0.48, y: -0.52 };
  const geometry = shotGeometry({
    direction: 'Up-right',
    fieldSector: 'Cover',
    swingDetected: true,
    dominantMotionVector: vector,
  });

  assert.equal(geometry.direction, 'Up-right');
  assert.equal(geometry.fieldSector, 'Cover');
  assert.ok(Math.abs(geometry.heading - geometry.sector.angle) < 1e-10);
  assert.ok(Math.abs(geometry.points.at(-1).x - Math.cos(geometry.sector.angle) * 0.78) < 1e-10);
  assert.ok(Math.abs(geometry.points.at(-1).y - Math.sin(geometry.sector.angle) * 0.78) < 1e-10);
  assert.deepEqual(geometry.rawVector, vector, 'the measured vector is preserved for diagnostics');
  assert.equal(geometry.snapToSector, true);
});

test('draws the highlighted field wedge and finished-shot arrow on one sector angle', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    set(target, key, value) { target[key] = value; return true; },
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => calls.push([key, ...args]);
    },
  });
  const geometry = shotGeometry({
    direction: 'Right',
    fieldSector: 'Point',
    swingDetected: true,
    dominantMotionVector: { x: 0.5, y: -0.5 },
  });

  draw(ctx, {
    width: 400,
    height: 320,
    points: geometry.points,
    heading: geometry.heading,
    sector: geometry.sector,
    snapToSector: geometry.snapToSector,
    battingHand: geometry.battingHand,
  });

  const selectedWedge = calls.find(([name, , , , , rotation, start]) =>
    name === 'ellipse' && rotation === 0 && start === geometry.sector.angle - Math.PI / 8);
  assert.ok(selectedWedge, 'the selected highlight uses the canonical sector angle');
  const head = calls.filter(([name]) => name === 'arc').at(-1);
  const ry = Math.min(320 * 0.43, 400 * 0.45);
  const rx = Math.min(400 * 0.38, ry * 0.78);
  const expectedHead = {
    x: 200 + rx * Math.cos(geometry.sector.angle),
    y: 320 * 0.47 + ry * Math.sin(geometry.sector.angle),
  };
  assert.ok(Math.abs(head[1] - expectedHead.x) < 1e-8);
  assert.ok(Math.abs(head[2] - expectedHead.y) < 1e-8,
    'the snapped arrow endpoint lands on the same highlighted sector');
});

test('provides explicitly heuristic stroke candidates for every wagon-wheel sector', () => {
  const expected = new Map([
    ['Up', ['Straight drive', 'On-drive', 'Lofted straight hit', 'Checked drive']],
    ['Up-right', ['Cover drive', 'Inside-out drive', 'Lofted cover drive', 'Square drive']],
    ['Right', ['Cut', 'Square cut', 'Late cut']],
    ['Down-right', ['Late cut', 'Open-faced dab', 'Upper cut', 'Guide to third man', 'Edged shots']],
    ['Down', ['Ramp', 'Scoop', 'Dilscoop', 'Reverse ramp', 'Edges over keeper']],
    ['Down-left', ['Leg glance', 'Fine sweep', 'Paddle sweep', 'Deflection off pads or bat']],
    ['Left', ['Pull shot', 'Sweep', 'Slog sweep', 'Flick', 'Paddle sweep', 'Hip glance']],
    ['Up-left', ['On-drive', 'Flick drive', 'Lofted on-drive', 'Whip through mid-on']],
  ]);
  for (const [direction, candidates] of expected) {
    assert.deepEqual(shotGeometry({ direction, swingDetected: true }).shotCandidates, candidates, direction);
  }
  assert.match(shotGeometry({ direction: 'Up-right', swingDetected: true }).classificationNotice, /candidates/i);
});

test('uses cover and mid-on stroke families from the canonical mapped sector', () => {
  const cover = shotGeometry({
    direction: 'Up',
    dominantMotionVector: { x: 0.5, y: -0.5 },
    height: 'Estimated lofted',
    swingDetected: true,
  });
  const midOn = shotGeometry({ direction: 'Up-left', swingDetected: true });

  assert.equal(cover.fieldSector, 'Cover');
  assert.equal(cover.shotType, 'Lofted cover drive-like swing');
  assert.equal(midOn.fieldSector, 'Mid-on');
  assert.equal(midOn.shotType, 'Mid-on-directed drive-like swing');
});

test('displayed stroke family follows canonical map sector when raw classifier disagrees', () => {
  const geometry = shotGeometry({
    direction: 'Right',
    fieldSector: 'Point',
    shotType: 'Cut-like swing',
    swingDetected: true,
    battingHand: 'right',
    dominantMotionVector: { x: 0.03, y: 0.8 },
  });

  assert.equal(geometry.direction, 'Down');
  assert.equal(geometry.fieldSector, 'Behind batter');
  assert.equal(geometry.shotType, 'Back-foot / glance-like swing');
  assert.equal(geometry.classifierDirection, 'Right');
  assert.equal(geometry.classifierSector, 'Point');
  assert.equal(geometry.directionMismatch, true);
  assert.equal(geometry.sectorMismatch, true);
});

test('does not display a directional arrow when classifier confidence is unclear', () => {
  const geometry = shotGeometry({
    direction: 'No clear movement',
    dominantMotionVector: { x: 0.5, y: 0.1 },
  });

  assert.equal(geometry.direction, 'No clear movement');
  assert.equal(geometry.fieldSector, 'Unclear');
  assert.deepEqual(geometry.points, [{ x: 0, y: 0 }]);
});

test('draws the ground, labeled sectors, selected sector, and a live movement tail', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    set(target, key, value) { target[key] = value; return true; },
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => calls.push([key, ...args]);
    },
  });

  draw(ctx, {
    width: 400,
    height: 320,
    points: [{ x: 0, y: 0 }, { x: 0.4, y: -0.3 }],
    heading: -0.64,
    sector: sectorForDirection('Up-right'),
    battingHand: 'right',
  });

  const fieldOval = calls.find(([name]) => name === 'ellipse');
  assert.ok(fieldOval, 'field and inner ring are ellipses');
  assert.ok(fieldOval[3] > fieldOval[4] * 0.75, 'offside and legside have a fuller, less pinched contour');
  assert.ok(fieldOval[4] > fieldOval[3] * 1.2, 'the ground remains longer from straight to behind the batter');
  assert.ok(calls.some(([name, label]) => name === 'fillText' && label === 'COVER'));
  assert.ok(calls.some(([name]) => name === 'lineTo'), 'movement tail and sector dividers are rendered');
  assert.ok(calls.some(([name]) => name === 'setLineDash'), 'wagon-wheel boundary is dashed');
  assert.ok(calls.filter(([name]) => name === 'arc').length >= 9, 'batter, trail, and fielder markers are drawn');
  assert.ok(calls.filter(([name]) => name === 'fillRect').length >= 8, 'pitch markings are drawn over the field');
});

test('can hide a stale arrow when a finished shot has no clear direction', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    set(target, key, value) { target[key] = value; return true; },
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => calls.push([key, ...args]);
    },
  });

  draw(ctx, {
    width: 400,
    height: 320,
    points: [{ x: 0, y: 0 }, { x: 0.4, y: -0.3 }],
    showArrow: false,
  });

  assert.equal(calls.filter(([name]) => name === 'closePath').length, 0, 'no arrowhead is drawn');
});
