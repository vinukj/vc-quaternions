/* Copyable, single-line shot report shared by the UI and browser console. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShotReport = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  function fixed(value, digits = 0) {
    return Number.isFinite(value) ? value.toFixed(digits) : '0'.padEnd(digits ? digits + 2 : 1, '0');
  }

  function fields(result = {}, geometry = null) {
    const sector = geometry?.fieldSector || geometry?.mappedSector || result.fieldSector || 'Unclear';
    const direction = geometry?.direction || result.direction || 'No clear movement';
    const side = geometry?.sideEstimate || result.sideEstimate || 'Unclear';
    const fieldZone = geometry?.fieldZone || 'Unclear';
    const shotType = geometry?.shotType || result.shotType || 'Not enough motion data';
    const height = String(result.height || 'Unclear').replace(/^Estimated /, '');
    return [
      `Direction: ${direction} · ${sector}`,
      `Direction zone: ${fieldZone}`,
      ...(Number.isInteger(geometry?.directionLobeIndex) && Number.isInteger(geometry?.directionLobeCount)
        ? [`Direction path: lobe ${geometry.directionLobeIndex + 1} of ${geometry.directionLobeCount} · ${geometry.directionSelectionReason || 'selected'}`]
        : []),
      `Likely shot type: ${shotType}`,
      ...(geometry?.shotCandidates?.length ? [`Possible strokes: ${geometry.shotCandidates.join(', ')} (direction-based candidates; exact stroke not identified)`] : []),
      `Direction consistency: ${result.directionConsistency || 'Unclear'}`,
      `Side: ${side}`,
      `Rotation: ${fixed(result.rotationDegrees)}° total · ${fixed(result.netRotationDegrees)}° net`,
      `Angular speed: ${fixed(result.peakAngularVelocityRadS, 1)} rad/s peak · ${fixed(result.averageAngularVelocityRadS, 1)} average`,
      `Loft: ${height} · ${fixed(result.estimatedLoftDegrees)}° IMU estimate`,
      `Aggression: ${result.aggression || 'Unclear'} · estimated from bat angular speed`,
      'Direction and shot type are inferred from bat-mounted IMU motion; no ball tracking.',
    ];
  }

  function ariaLabel(result = {}, geometry = null) {
    const direction = geometry?.direction || result.direction || 'No clear movement';
    const sector = geometry?.fieldSector || geometry?.mappedSector || result.fieldSector || 'Unclear';
    const shotType = geometry?.shotType || result.shotType || 'Shot estimate unavailable';
    const fieldZone = geometry?.fieldZone || 'Unclear';
    return `Cricket ground showing bat movement. Likely stroke estimate ${shotType}; bat direction ${direction}; mapped sector ${sector}; broad direction zone ${fieldZone}.`;
  }

  function trailPoints(result = {}) {
    const vector = result.dominantMotionVector;
    if (!vector || !Number.isFinite(vector.x) || !Number.isFinite(vector.y)) return [{ x: 0, y: 0 }];
    const maximum = Math.max(Math.abs(vector.x), Math.abs(vector.y));
    if (maximum < 1e-8) return [{ x: 0, y: 0 }];
    const scale = 0.78 / maximum;
    return [{ x: 0, y: 0 }, { x: vector.x * scale, y: vector.y * scale }];
  }

  function create(result, samples, timestamp = new Date().toISOString(), renderedMap = null, gameOutcome = null) {
    return {
      type: 'POWERPLAI_SHOT',
      timestamp,
      displayedFields: fields(result, renderedMap),
      groundAriaLabel: ariaLabel(result, renderedMap),
      displayedDirection: renderedMap?.direction || result.direction || 'No clear movement',
      displayedFieldSector: renderedMap?.fieldSector || renderedMap?.mappedSector || result.fieldSector || 'Unclear',
      displayedFieldZone: renderedMap?.fieldZone || 'Unclear',
      displayedShotType: renderedMap?.shotType || result.shotType || 'Shot estimate unavailable',
      displayedSideEstimate: renderedMap?.sideEstimate || result.sideEstimate || 'Unclear',
      result: { ...result },
      gameOutcome: gameOutcome ? { ...gameOutcome } : null,
      renderedMap: renderedMap ? {
        ...renderedMap,
        points: renderedMap.points?.map(point => ({ ...point })) || [],
        sector: renderedMap.sector ? { ...renderedMap.sector } : null,
      } : null,
      sampleCount: Array.isArray(samples) ? samples.length : 0,
      samples: Array.isArray(samples) ? samples.map(sample => ({ ...sample })) : [],
    };
  }

  function log(result, samples, logger = console, timestamp, renderedMap = null, gameOutcome = null) {
    const report = create(result, samples, timestamp, renderedMap, gameOutcome);
    logger.info(`POWERPLAI_SHOT ${JSON.stringify(report)}`);
    return report;
  }

  return { fields, ariaLabel, trailPoints, create, log };
});
