/* In-session shot history; entries are never capped or persisted across reloads. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShotHistory = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const CSV_COLUMNS = [
    'shot_number', 'timestamp', 'direction', 'field_sector', 'direction_zone', 'shot_type', 'shot_candidates', 'side_estimate', 'aggression', 'power', 'height',
    'batting_hand', 'direction_consistency', 'direction_consistency_score', 'swing_detected', 'status',
    'classification_basis', 'classification_method', 'is_pitch_dominant',
    'rotation_degrees', 'net_rotation_degrees', 'peak_angular_velocity_rad_s', 'peak_angular_velocity_deg_s',
    'average_angular_velocity_rad_s', 'estimated_loft_degrees', 'sample_count', 'captured_ms',
    'configured_capture_window_ms', 'received_sample_count', 'observed_sample_span_ms',
    'dominant_motion_x', 'dominant_motion_y', 'vector_direction', 'classifier_direction',
    'selected_direction_lobe', 'direction_lobe_count', 'direction_selection_reason',
    'classifier_field_sector', 'classifier_shot_type', 'classifier_side_estimate',
    'direction_mismatch', 'sector_mismatch', 'shot_type_mismatch',
    'game_direction', 'game_shot', 'game_family', 'game_lofted', 'game_runs', 'game_dist_normalized', 'game_height_normalized',
    'game_aggression', 'game_peak_deg_s', 'game_angle_deg', 'game_timing', 'game_out', 'game_dismissal', 'game_edged',
    'game_difficulty', 'game_bowled_prob', 'game_edge_base_prob', 'game_capture_window_ms',
    'rendered_map_json', 'result_json', 'game_outcome_json', 'guard_reference_json', 'orientation_reference_json', 'samples_json',
  ];

  function fixed(value) {
    if (!Number.isFinite(value)) return 'Unclear';
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}°`;
  }

  function csvCell(value) {
    let text = value == null ? '' : String(value).replace(/\r\n|\r|\n/g, '\\n');
    // CSV quoting alone does not stop spreadsheet formula evaluation.
    if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function json(value) {
    return value == null ? '' : JSON.stringify(value);
  }

  function create(container, documentRef = document) {
    if (!container) throw new TypeError('A history container is required');
    let count = 0;
    const records = [];

    function append(result = {}, timestamp = new Date(), samples = [], geometry = null, gameOutcome = null, captureDetail = null, stanceReference = null, orientationReference = null) {
      count += 1;
      const time = timestamp instanceof Date ? timestamp : new Date(timestamp);
      const timestampText = Number.isNaN(time.getTime()) ? String(timestamp) : time.toISOString();
      records.push({
        shotNumber: count,
        timestamp: timestampText,
        result: JSON.parse(JSON.stringify(result || {})),
        samples: Array.isArray(samples) ? JSON.parse(JSON.stringify(samples)) : [],
        geometry: geometry ? JSON.parse(JSON.stringify(geometry)) : null,
        gameOutcome: gameOutcome ? JSON.parse(JSON.stringify(gameOutcome)) : null,
        captureDetail: captureDetail ? JSON.parse(JSON.stringify(captureDetail)) : null,
        stanceReference: stanceReference ? JSON.parse(JSON.stringify(stanceReference)) : null,
        orientationReference: orientationReference ? JSON.parse(JSON.stringify(orientationReference)) : null,
      });
      const entry = documentRef.createElement('article');
      entry.className = 'history-entry';
      entry.setAttribute('role', 'listitem');

      const heading = documentRef.createElement('h3');
      heading.textContent = `Shot ${count} · ${Number.isNaN(time.getTime()) ? String(timestamp) : time.toLocaleTimeString()}`;
      entry.append(heading);

      const metrics = documentRef.createElement('dl');
      const loft = String(result.height || 'Unclear').replace(/^Estimated /, '');
      // The geometry is the exact vector and sector drawn on the wagon wheel.
      // All visible labels use one canonical vector-derived geometry. Keep
      // classifier output in the record/CSV so mismatches remain diagnosable.
      const direction = geometry?.direction || result.direction || 'No clear movement';
      const sector = geometry?.fieldSector || geometry?.mappedSector || result.fieldSector || 'Unclear';
      const fieldZone = geometry?.fieldZone || 'Unclear';
      const shotType = geometry?.shotType || result.shotType || 'Not enough motion data';
      const values = [
        ['Direction', direction],
        ['Sector', sector],
        ['Direction zone', fieldZone],
        ['Shot type', shotType],
        ['Aggression', result.aggression || 'Unclear'],
        ['Rotation', `${fixed(result.rotationDegrees)} total · ${fixed(result.netRotationDegrees)} net`],
        ['Loft', `${loft} · ${fixed(result.estimatedLoftDegrees)} IMU estimate`],
      ];
      for (const [label, value] of values) {
        const term = documentRef.createElement('dt');
        term.textContent = label;
        const description = documentRef.createElement('dd');
        description.textContent = value;
        metrics.append(term, description);
      }
      if (captureDetail) {
        const term = documentRef.createElement('dt');
        term.textContent = 'Capture';
        const description = documentRef.createElement('dd');
        description.textContent = `${captureDetail.captureMs} ms configured · ${captureDetail.sampleCount} samples received · ${captureDetail.sampleSpanMs} ms observed span`;
        metrics.append(term, description);
      }
      if (geometry?.shotCandidates?.length) {
        const term = documentRef.createElement('dt');
        term.textContent = 'Possible strokes';
        const description = documentRef.createElement('dd');
        description.textContent = `${geometry.shotCandidates.join(', ')} · direction-based candidates, not exact recognition`;
        metrics.append(term, description);
      }
      if (Number.isInteger(geometry?.directionLobeIndex) && Number.isInteger(geometry?.directionLobeCount)) {
        const term = documentRef.createElement('dt');
        term.textContent = 'Direction path';
        const description = documentRef.createElement('dd');
        description.textContent = `Lobe ${geometry.directionLobeIndex + 1} of ${geometry.directionLobeCount} · ${geometry.directionSelectionReason || 'selected'}`;
        metrics.append(term, description);
      }
      entry.append(metrics);
      if (gameOutcome) {
        const gameTerm = documentRef.createElement('dt');
        gameTerm.textContent = 'Game outcome';
        const gameDescription = documentRef.createElement('dd');
        gameDescription.textContent = gameOutcome.out
          ? `OUT · ${gameOutcome.dismissal || 'Dismissed'}${gameOutcome.edged ? ' · edged' : ''}`
          : `${gameOutcome.runs} run${gameOutcome.runs === 1 ? '' : 's'}${gameOutcome.edged ? ' · edged' : ''}`;
        metrics.append(gameTerm, gameDescription);
        const gameDetails = documentRef.createElement('dd');
        gameDetails.textContent = `${gameOutcome.timing} · ${gameOutcome.shot} · ${gameOutcome.dist} dist / ${gameOutcome.h} h`;
        const detailsTerm = documentRef.createElement('dt');
        detailsTerm.textContent = 'Game details';
        metrics.append(detailsTerm, gameDetails);
      }
      container.prepend(entry);
      return count;
    }

    function toCSV() {
      const rows = records.map(record => {
        const result = record.result;
        const vector = result.dominantMotionVector || {};
        const geometry = record.geometry || {};
        const game = record.gameOutcome || {};
        const capture = record.captureDetail || {};
        const values = [
          record.shotNumber, record.timestamp, geometry.direction || result.direction,
          geometry.fieldSector || result.fieldSector, geometry.fieldZone || '', geometry.shotType || result.shotType,
          json(geometry.shotCandidates || []), geometry.sideEstimate || result.sideEstimate, result.aggression, result.power,
          result.height, geometry.battingHand || result.battingHand, result.directionConsistency, result.directionConsistencyScore,
          result.swingDetected, result.status, result.classificationBasis, result.classificationMethod, result.isPitchDominant,
          result.rotationDegrees, result.netRotationDegrees,
          result.peakAngularVelocityRadS, result.peakAngularVelocityDegS,
          result.averageAngularVelocityRadS, result.estimatedLoftDegrees,
          result.sampleCount ?? record.samples.length, result.capturedMs,
          capture.captureMs ?? capture.context?.capture_window_ms ?? game.capture_window_ms,
          capture.sampleCount ?? record.samples.length,
          capture.sampleSpanMs ?? result.capturedMs,
          vector.x, vector.y, geometry.vectorDirection, geometry.classifierDirection,
          Number.isInteger(geometry.directionLobeIndex) ? geometry.directionLobeIndex + 1 : '',
          geometry.directionLobeCount, geometry.directionSelectionReason,
          geometry.classifierSector, result.shotType, result.sideEstimate,
          geometry.directionMismatch, geometry.sectorMismatch,
          Boolean(result.shotType && geometry.shotType && result.shotType !== geometry.shotType),
          game.direction, game.shot, game.family, game.lofted, game.runs, game.dist, game.h,
          game.agg, game.peak, game.angle, game.timing, game.out, game.dismissal, game.edged,
          game.difficulty, game.bowled_prob, game.edge_base_prob, game.capture_window_ms,
          json(geometry), json(result), json(record.gameOutcome), json(record.stanceReference), json(record.orientationReference), json(record.samples),
        ];
        return values.map(csvCell).join(',');
      });
      return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
    }

    function clear() {
      count = 0;
      records.length = 0;
      container.replaceChildren();
    }

    return { append, clear, toCSV, get count() { return count; }, get records() { return records.slice(); } };
  }

  return { create, CSV_COLUMNS };
});
