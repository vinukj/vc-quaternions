const test = require('node:test');
const assert = require('node:assert/strict');
const ShotHistory = require('../shot-history.js');
const WagonWheel = require('../wagon-wheel.js');

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.textContent = '';
  }
  append(...children) { this.children.push(...children); }
  prepend(child) { this.children.unshift(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

function textContent(element) {
  return [element.textContent, ...element.children.map(textContent)].join(' ');
}

function parseCsvRow(row) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < row.length; index++) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  cells.push(value);
  return cells;
}

test('retains every shot in the session and records every requested metric', () => {
  const container = new FakeElement('div');
  const history = ShotHistory.create(container, { createElement: tag => new FakeElement(tag) });
  const result = {
    direction: 'Up-right',
    fieldSector: 'Cover',
    shotType: 'Cover drive',
    aggression: 'Assertive',
    rotationDegrees: 58,
    netRotationDegrees: 51,
    height: 'Estimated lofted',
    estimatedLoftDegrees: 34,
  };

  for (let index = 0; index < 9; index++) {
    assert.equal(history.append(result, new Date('2026-11-16T10:00:00Z')), index + 1);
  }

  assert.equal(history.count, 9);
  assert.equal(container.children.length, 9, 'history is not truncated after five shots');
  assert.match(textContent(container.children[0]), /Shot 9/);
  for (const field of ['Direction Up-right', 'Sector Cover', 'Shot type Cover drive', 'Aggression Assertive', 'Rotation 58° total · 51° net', 'Loft lofted · 34° IMU estimate']) {
    assert.ok(textContent(container.children[0]).includes(field), `history includes ${field}`);
  }
  assert.equal(container.children[0].attributes.get('role'), 'listitem');
});

test('history displays fractional rotation instead of rounding small measured motion to zero', () => {
  const container = new FakeElement('history');
  const history = ShotHistory.create(container, { createElement: tag => new FakeElement(tag) });

  history.append({ rotationDegrees: 0.4, netRotationDegrees: 0.2 });

  assert.match(textContent(container.children[0]), /Rotation 0\.4° total · 0\.2° net/);
});

test('clear removes rendered and exported shots and restarts numbering', () => {
  const container = new FakeElement('history');
  const history = ShotHistory.create(container, { createElement: tag => new FakeElement(tag) });
  history.append({ direction: 'Up' });
  history.append({ direction: 'Left' });

  history.clear();

  assert.equal(history.count, 0);
  assert.deepEqual(history.records, []);
  assert.deepEqual(container.children, []);
  assert.equal(history.toCSV().trimEnd().split('\r\n').length, 1, 'CSV keeps only its header');
  assert.equal(history.append({ direction: 'Down' }), 1, 'the fresh history starts at shot one');
});

test('history labels match the wagon-wheel vector while retaining classifier values as diagnostics', () => {
  const container = new FakeElement('history');
  const history = ShotHistory.create(container, { createElement: tag => new FakeElement(tag) });
  history.append({
    direction: 'Right',
    fieldSector: 'Point',
    dominantMotionVector: { x: 0, y: 0.8 },
  }, new Date('2026-11-16T10:00:00Z'), [], {
    direction: 'Down',
    fieldSector: 'Behind batter',
    mappedSector: 'Behind batter',
    classifierDirection: 'Right',
    classifierSector: 'Point',
    directionMismatch: true,
    sectorMismatch: true,
  });

  const visible = textContent(container.children[0]);
  assert.match(visible, /Direction Down/);
  assert.match(visible, /Sector Behind batter/);
  assert.match(history.toCSV(), /,"Down","Behind batter"/,
    'the exported primary labels match the wagon-wheel geometry');
  assert.equal(history.records[0].result.direction, 'Right',
    'the original classifier result remains available for diagnostics');
});

test('history and CSV expose the canonical broad direction zone', () => {
  const container = new FakeElement('history');
  const history = ShotHistory.create(container, { createElement: tag => new FakeElement(tag) });
  const result = {
    direction: 'Up-right',
    fieldSector: 'Cover',
    swingDetected: true,
    battingHand: 'right',
    dominantMotionVector: { x: 0.5, y: -0.5 },
  };
  const geometry = WagonWheel.shotGeometry(result);
  history.append(result, new Date('2026-11-20T10:00:00Z'), [], geometry);

  assert.match(textContent(container.children[0]), /Direction zone Offside front/);
  const [header, row] = history.toCSV().trimEnd().split('\r\n');
  const columns = header.split(',');
  const cells = parseCsvRow(row);
  assert.equal(cells[columns.indexOf('direction_zone')], 'Offside front');
  assert.equal(cells[columns.indexOf('selected_direction_lobe')], '');
});

test('history and CSV use the same canonical stroke while exporting the disagreeing classifier value', () => {
  const container = new FakeElement('history');
  const history = ShotHistory.create(container, { createElement: tag => new FakeElement(tag) });
  const result = {
    direction: 'Right',
    fieldSector: 'Point',
    shotType: 'Cut-like swing',
    swingDetected: true,
    battingHand: 'right',
    dominantMotionVector: { x: 0.03, y: 0.8 },
  };
  const geometry = WagonWheel.shotGeometry(result);
  history.append(result, new Date('2026-11-16T10:00:00Z'), [], geometry);

  assert.match(textContent(container.children[0]), /Direction Down/);
  assert.match(textContent(container.children[0]), /Sector Behind batter/);
  assert.match(textContent(container.children[0]), /Shot type Back-foot \/ glance-like swing/);
  assert.match(textContent(container.children[0]), /Possible strokes Ramp, Scoop, Dilscoop/);

  const [header, row] = history.toCSV().trimEnd().split('\r\n');
  const columns = header.split(',');
  const cells = parseCsvRow(row);
  const cell = name => cells[columns.indexOf(name)];
  assert.equal(columns.length, ShotHistory.CSV_COLUMNS.length);
  assert.equal(cell('direction'), 'Down');
  assert.equal(cell('field_sector'), 'Behind batter');
  assert.equal(cell('shot_type'), 'Back-foot / glance-like swing');
  assert.equal(cell('side_estimate'), 'Behind the batter');
  assert.deepEqual(JSON.parse(cell('shot_candidates')), ['Ramp', 'Scoop', 'Dilscoop', 'Reverse ramp', 'Edges over keeper'],
    'CSV exposes direction-based candidates in their own column');
  assert.equal(cell('classifier_direction'), 'Right');
  assert.equal(cell('classifier_field_sector'), 'Point');
  assert.equal(cell('classifier_shot_type'), 'Cut-like swing',
    'raw classifier labels remain in explicitly separate diagnostic columns');
});

test('game outcome details render as paired history fields and export all outcome fields', () => {
  const container = new FakeElement('history');
  const history = ShotHistory.create(container, { createElement: tag => new FakeElement(tag) });
  const outcome = {
    direction: 'point', shot: 'cover_drive', family: 'Drive-like swing', lofted: true,
    runs: 4, dist: 0.76, h: 0.58, agg: 'aggressive', peak: 412, angle: 92.5,
    timing: 'GOOD', out: false, dismissal: '', edged: true,
    difficulty: 'dry_pitch', bowled_prob: 3, edge_base_prob: 10, capture_window_ms: 525,
  };
  history.append({ direction: 'Right', fieldSector: 'Point' }, new Date('2026-11-17T03:50:00Z'), [], {}, outcome);

  const entry = container.children[0];
  const terms = entry.children.find(child => child.tag === 'dl').children;
  assert.equal(terms.length % 2, 0, 'every definition-list term has a corresponding description');
  assert.ok(textContent(entry).includes('Game outcome 4 runs · edged'));
  assert.ok(textContent(entry).includes('Game details GOOD · cover_drive · 0.76 dist / 0.58 h'));

  const [header, row] = history.toCSV().trimEnd().split('\r\n');
  const columns = header.split(',');
  const cells = parseCsvRow(row);
  const cell = name => cells[columns.indexOf(name)];
  assert.equal(cell('game_direction'), 'point');
  assert.equal(cell('game_shot'), 'cover_drive');
  assert.equal(cell('game_runs'), '4');
  assert.equal(cell('game_timing'), 'GOOD');
  assert.equal(cell('game_edged'), 'true');
  assert.deepEqual(JSON.parse(cell('game_outcome_json')), outcome);
});

test('CSV has one complete row per recorded shot and retains raw samples and geometry', () => {
  const container = new FakeElement('history');
  const history = ShotHistory.create(container, { createElement: tag => new FakeElement(tag) });
  const firstSamples = [{ w: 1, x: 0, y: 0, z: 0, t: 10 }, { w: 0.9, x: 0.1, y: 0, z: 0, t: 1010 }];
  const result = {
    direction: 'Up-right', fieldSector: 'Cover', shotType: 'Cover drive',
    aggression: 'Assertive', power: 'Medium', height: 'Estimated lofted',
    rotationDegrees: 58.2, netRotationDegrees: 51.4, estimatedLoftDegrees: 34,
    peakAngularVelocityRadS: 4.2, averageAngularVelocityRadS: 1.7,
    sampleCount: firstSamples.length, capturedMs: 1000,
    dominantMotionVector: { x: 0.4, y: -0.3 }, battingHand: 'right',
  };
  history.append(result, new Date('2026-11-16T10:00:00.000Z'), firstSamples, {
    direction: 'Up-right', fieldSector: 'Cover', points: [{ x: 0, y: 0 }, { x: 0.7, y: -0.5 }],
  });
  history.append({ direction: 'Right', shotType: 'Cut, late' }, new Date('2026-11-16T10:00:02.000Z'), [], null);

  const csv = history.toCSV();
  const rows = csv.trimEnd().split('\r\n');
  assert.equal(rows.length, 3, 'header plus exactly one physical row for each shot');
  assert.match(rows[0], /shot_number,timestamp,direction,field_sector,direction_zone,shot_type/);
  assert.equal(rows[0].split(',').length, ShotHistory.CSV_COLUMNS.length);
  assert.match(rows[1], /Cover drive/);
  assert.match(rows[1], /58\.2/);
  assert.match(rows[1], /"\[\{""w"":1/);
  assert.match(rows[2], /"Cut, late"/, 'commas in values are quoted safely');
  assert.equal(history.count, 2);
});

test('history and CSV distinguish configured capture time from received packet count and timestamp span', () => {
  const container = new FakeElement('history');
  const history = ShotHistory.create(container, { createElement: tag => new FakeElement(tag) });
  const samples = [
    { w: 1, x: 0, y: 0, z: 0, t: 100 },
    { w: 1, x: 0, y: 0, z: 0, t: 120 },
    { w: 1, x: 0, y: 0, z: 0, t: 480 },
  ];
  const captureDetail = {
    captureMs: 400,
    sampleCount: 3,
    sampleSpanMs: 380,
    context: { capture_window_ms: 400 },
  };
  history.append({ sampleCount: 3, capturedMs: 380 }, new Date('2026-11-20T08:00:00Z'), samples, null, null, captureDetail);

  assert.match(textContent(container.children[0]), /Capture 400 ms configured · 3 samples received · 380 ms observed span/);
  const [header, row] = history.toCSV().trimEnd().split('\r\n');
  const columns = header.split(',');
  const cells = parseCsvRow(row);
  const cell = name => cells[columns.indexOf(name)];
  assert.equal(cell('configured_capture_window_ms'), '400');
  assert.equal(cell('received_sample_count'), '3');
  assert.equal(cell('observed_sample_span_ms'), '380');
});

test('CSV neutralizes spreadsheet formulas in user-facing text fields', () => {
  const history = ShotHistory.create(new FakeElement('history'), { createElement: tag => new FakeElement(tag) });
  history.append({ direction: '=IMPORTDATA("https://example.invalid")' });

  assert.match(history.toCSV(), /' =|="|\'=IMPORTDATA/);
});
