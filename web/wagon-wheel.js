/* Cricket-ground projection for live bat movement and estimated shot direction. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WagonWheel = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const DIRECTIONS = ['Up', 'Up-right', 'Right', 'Down-right', 'Down', 'Down-left', 'Left', 'Up-left'];
  const RIGHT_HANDED_SECTORS = ['Straight', 'Cover', 'Point', 'Third man', 'Behind batter', 'Fine leg', 'Square leg', 'Mid-on'];
  const SHOT_FAMILIES = {
    Straight: 'straight drive-like swing',
    Cover: 'cover drive-like swing',
    Point: 'cut-like swing',
    'Third man': 'late-cut-like swing',
    'Behind batter': 'back-foot / glance-like swing',
    'Fine leg': 'flick / glance-like swing',
    'Square leg': 'pull / sweep-like swing',
    'Mid-on': 'mid-on-directed drive-like swing',
  };
  const SHOT_CANDIDATES = {
    Straight: ['Straight drive', 'On-drive', 'Lofted straight hit', 'Checked drive'],
    Cover: ['Cover drive', 'Inside-out drive', 'Lofted cover drive', 'Square drive'],
    Point: ['Cut', 'Square cut', 'Late cut'],
    'Third man': ['Late cut', 'Open-faced dab', 'Upper cut', 'Guide to third man', 'Edged shots'],
    'Behind batter': ['Ramp', 'Scoop', 'Dilscoop', 'Reverse ramp', 'Edges over keeper'],
    'Fine leg': ['Leg glance', 'Fine sweep', 'Paddle sweep', 'Deflection off pads or bat'],
    'Square leg': ['Pull shot', 'Sweep', 'Slog sweep', 'Flick', 'Paddle sweep', 'Hip glance'],
    'Mid-on': ['On-drive', 'Flick drive', 'Lofted on-drive', 'Whip through mid-on'],
  };
  const DIRECTION_INDEX = new Map(DIRECTIONS.map((direction, index) => [direction.toLowerCase(), index]));

  function sectorForDirection(direction, battingHand = 'right') {
    const index = DIRECTION_INDEX.get(String(direction || '').toLowerCase());
    if (index === undefined) return null;
    const sectorIndex = battingHand === 'left' ? (8 - index) % 8 : index;
    return {
      direction: DIRECTIONS[index],
      name: RIGHT_HANDED_SECTORS[sectorIndex],
      index: sectorIndex,
      angle: -Math.PI / 2 + index * Math.PI / 4,
    };
  }

  function ellipsePoint(cx, cy, rx, ry, angle) {
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  }

  // Motion vectors use screen coordinates (+y is down); field directions are
  // compass-like (+y is up). Derive the label from the exact vector being drawn.
  function directionForVector(vector) {
    if (!vector || !Number.isFinite(vector.x) || !Number.isFinite(vector.y) || Math.hypot(vector.x, vector.y) < 1e-8) {
      return 'No clear movement';
    }
    const index = ((Math.round(Math.atan2(vector.x, -vector.y) / (Math.PI / 4)) % 8) + 8) % 8;
    return DIRECTIONS[index];
  }

  function shotTypeForGeometry(result, fieldSector, vector) {
    if (result.swingDetected === false) return result.shotType || 'No clear shot detected';
    const family = SHOT_FAMILIES[fieldSector];
    if (!family) return result.swingDetected ? 'Shot direction unclear' : (result.shotType || 'Shot direction unclear');
    const pitchDominant = result.isPitchDominant ?? Boolean(vector && Math.abs(vector.x) < 1e-8);
    if (pitchDominant && result.height === 'Estimated lofted') return 'Lofted glance-like swing';
    return result.height === 'Estimated lofted' ? `Lofted ${family}` : family[0].toUpperCase() + family.slice(1);
  }

  function sideForSector(fieldSector, battingHand) {
    if (fieldSector === 'Straight') return 'Straight';
    if (fieldSector === 'Behind batter') return 'Behind the batter';
    if (['Cover', 'Point', 'Third man'].includes(fieldSector)) return `Offside · ${battingHand}-handed stance`;
    if (['Fine leg', 'Square leg', 'Mid-on'].includes(fieldSector)) {
      return `${battingHand === 'right' ? 'Legside' : 'Offside'} · ${battingHand}-handed stance`;
    }
    return 'Unclear';
  }

  function fieldZoneForSector(fieldSector) {
    if (fieldSector === 'Straight') return 'Straight';
    if (fieldSector === 'Behind batter') return 'Behind wicket';
    if (fieldSector === 'Cover') return 'Offside front';
    if (['Point', 'Third man'].includes(fieldSector)) return 'Offside back';
    if (fieldSector === 'Mid-on') return 'Legside front';
    if (['Square leg', 'Fine leg'].includes(fieldSector)) return 'Legside back';
    return 'Unclear';
  }

  function shotGeometry(result = {}, battingHand = result.battingHand || 'right') {
    const vector = result.dominantMotionVector;
    const vectorDirection = directionForVector(vector);
    const classifierDirection = result.direction || 'No clear movement';
    const classifierSector = result.fieldSector || 'Unclear';
    // The classifier intentionally suppresses labels for low-confidence motion.
    // Otherwise, use the direction represented by the arrow so label, sector,
    // and rendered movement cannot silently disagree.
    const direction = classifierDirection === 'No clear movement'
      ? classifierDirection
      : vectorDirection !== 'No clear movement' ? vectorDirection : classifierDirection;
    const sector = sectorForDirection(direction, battingHand);
    const fieldSector = sector?.name || 'Unclear';
    // Derive the broad zone from the exact handedness-aware sector used for
    // the highlighted wedge. This keeps offside/legside labels consistent
    // with the selected batter stance as well as the arrow direction.
    const fieldZone = fieldZoneForSector(fieldSector);
    const normalizedHand = battingHand === 'left' ? 'left' : 'right';
    const points = [{ x: 0, y: 0 }];
    if (direction !== 'No clear movement' && sector) {
      points.push({ x: Math.cos(sector.angle) * 0.78, y: Math.sin(sector.angle) * 0.78 });
    }
    const heading = points.length > 1
      ? Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x)
      : null;
    return {
      direction,
      fieldSector,
      fieldZone,
      battingHand: normalizedHand,
      sideEstimate: sideForSector(fieldSector, normalizedHand),
      shotType: shotTypeForGeometry(result, fieldSector, vector),
      shotCandidates: result.swingDetected ? (SHOT_CANDIDATES[fieldSector] || []).slice() : [],
      classificationNotice: 'Possible strokes are direction-based candidates; the IMU does not identify the exact stroke.',
      points,
      heading,
      rawVector: vector && Number.isFinite(vector.x) && Number.isFinite(vector.y) ? { ...vector } : null,
      snapToSector: Boolean(sector && points.length > 1),
      mappedSector: sector?.name || 'Unclear',
      sector,
      classifierDirection,
      classifierSector,
      vectorDirection,
      directionMismatch: classifierDirection !== 'No clear movement' && vectorDirection !== 'No clear movement' && classifierDirection !== vectorDirection,
      sectorMismatch: classifierSector !== 'Unclear' && (sector?.name || 'Unclear') !== classifierSector,
      sectorMatchesResult: (sector?.name || 'Unclear') === classifierSector,
      directionLobeIndex: Number.isInteger(result.directionLobeIndex) ? result.directionLobeIndex : null,
      directionLobeCount: Number.isInteger(result.directionLobeCount) ? result.directionLobeCount : null,
      directionSelectionReason: result.directionSelectionReason || null,
    };
  }

  function draw(ctx, options = {}) {
    const width = Math.max(1, options.width || 1);
    const height = Math.max(1, options.height || width);
    const points = Array.isArray(options.points) ? options.points : [];
    const cx = width / 2;
    const cy = height * 0.47;
    // The long axis is Straight ↔ Behind batter; the two side sectors are
    // shorter. Keep that orientation even in the near-square mobile layout.
    const ry = Math.min(height * 0.43, width * 0.45);
    // Give the offside and legside a gentler, fuller shoulder while keeping
    // Straight ↔ Behind batter as the longer axis of the ground.
    const rx = Math.min(width * 0.38, ry * 0.78);
    const origin = { x: cx, y: cy + ry * 0.23 };
    const sector = options.sector || null;
    const project = point => ({
      x: origin.x + point.x * rx * 0.82,
      y: origin.y + point.y * ry * 0.75,
    });

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#111820';
    ctx.fillRect(0, 0, width, height);

    // Oval outfield with subtle mowing bands, clipped cleanly to the boundary.
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#174d2b';
    ctx.fill();
    for (let band = 0; band < 8; band++) {
      const bandHeight = (2 * ry) / 8;
      ctx.fillStyle = band % 2 === 0 ? 'rgba(129, 183, 93, 0.12)' : 'rgba(5, 35, 20, 0.12)';
      ctx.fillRect(cx - rx, cy - ry + band * bandHeight, rx * 2, bandHeight);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = '#b4d89b';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Selected field corridor is intentionally broad: it communicates a zone,
    // not a measured ball landing position.
    if (sector) {
      const start = sector.angle - Math.PI / 8;
      const end = sector.angle + Math.PI / 8;
      const startPoint = ellipsePoint(cx, cy, rx, ry, start);
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(startPoint.x, startPoint.y);
      ctx.ellipse(cx, cy, rx, ry, 0, start, end);
      ctx.closePath();
      ctx.fillStyle = 'rgba(216, 255, 173, 0.18)';
      ctx.fill();
    }

    // The inner ring and boundary rope make the view read as a cricket field,
    // rather than a generic circular cursor pad.
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.48, ry * 0.48, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(232, 246, 222, 0.72)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.7, ry * 0.7, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(232, 246, 222, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.96, ry * 0.96, 0, 0, Math.PI * 2);
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = 'rgba(246, 255, 237, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // Wagon-wheel sector guides radiate from the striker's crease.
    ctx.beginPath();
    for (let index = 0; index < 8; index++) {
      const boundaryAngle = -Math.PI / 2 + Math.PI / 8 + index * Math.PI / 4;
      const edge = ellipsePoint(cx, cy, rx, ry, boundaryAngle);
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(edge.x, edge.y);
    }
    ctx.strokeStyle = 'rgba(239, 249, 229, 0.34)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Pitch, creases, and stumps orient the field with the batter at the bottom.
    const pitchWidth = Math.max(20, width * 0.052);
    const pitchHeight = ry * 0.62;
    const pitchTop = origin.y - pitchHeight;
    ctx.fillStyle = '#c7ad78';
    ctx.fillRect(cx - pitchWidth / 2, pitchTop, pitchWidth, pitchHeight);
    ctx.fillStyle = 'rgba(255, 244, 213, 0.22)';
    ctx.fillRect(cx - pitchWidth * 0.34, pitchTop, pitchWidth * 0.68, pitchHeight);
    ctx.strokeStyle = 'rgba(255, 249, 231, 0.96)';
    ctx.lineWidth = 1.5;
    for (const creaseY of [pitchTop + pitchHeight * 0.12, origin.y]) {
      ctx.beginPath();
      ctx.moveTo(cx - pitchWidth * 1.45, creaseY);
      ctx.lineTo(cx + pitchWidth * 1.45, creaseY);
      ctx.stroke();
    }
    const wicketY = pitchTop + pitchHeight * 0.12;
    ctx.fillStyle = '#f0e7d3';
    for (let stump = -1; stump <= 1; stump++) {
      ctx.fillRect(cx + stump * pitchWidth * 0.17 - 1, wicketY - 8, 2, 8);
    }

    // Field positions follow the selected batting hand. Labels stay on the
    // ground, while the live readout below states the screen-relative direction.
    ctx.font = `700 ${Math.max(9, Math.min(13, width * 0.022))}px Segoe UI, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const direction of DIRECTIONS) {
      const label = sectorForDirection(direction, options.battingHand).name;
      const index = DIRECTION_INDEX.get(direction.toLowerCase());
      const angle = -Math.PI / 2 + index * Math.PI / 4;
      const labelPoint = ellipsePoint(cx, cy, rx * 0.79, ry * 0.79, angle);
      const isSelected = sector && sector.direction === direction;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(11, 35, 20, 0.82)';
      ctx.strokeText(label.toUpperCase(), labelPoint.x, labelPoint.y);
      ctx.fillStyle = isSelected ? '#e2ffad' : '#f4f7ed';
      ctx.fillText(label.toUpperCase(), labelPoint.x, labelPoint.y);

      // Small fielding-position markers give the diagram a familiar cricket
      // ground frame without implying that fielders or ball flight are tracked.
      const fielderPoint = ellipsePoint(cx, cy, rx * 0.58, ry * 0.58, angle);
      ctx.beginPath();
      ctx.arc(fielderPoint.x, fielderPoint.y, isSelected ? 4.2 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? '#e2ffad' : '#f4f7ed';
      ctx.fill();
      ctx.strokeStyle = 'rgba(11, 35, 20, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (points.length > 1) {
      ctx.lineCap = 'round';
      const projectedPoints = points.map(project);
      if (options.snapToSector && sector) {
        projectedPoints[projectedPoints.length - 1] = ellipsePoint(cx, cy, rx, ry, sector.angle);
      }
      for (let index = 1; index < points.length; index++) {
        const from = projectedPoints[index - 1];
        const to = projectedPoints[index];
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.strokeStyle = `rgba(220, 255, 184, ${0.18 + 0.78 * index / (points.length - 1)})`;
        ctx.lineWidth = Math.max(2.5, width * 0.006);
        ctx.stroke();
      }

      const start = projectedPoints[0];
      const head = projectedPoints[projectedPoints.length - 1];
      ctx.beginPath();
      ctx.arc(start.x, start.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      if (options.showArrow !== false) {
        const rawHeading = Number.isFinite(options.heading)
          ? options.heading
          : Math.atan2(points.at(-1).y - points.at(-2).y, points.at(-1).x - points.at(-2).x);
        const angle = options.snapToSector && sector
          ? Math.atan2(head.y - projectedPoints.at(-2).y, head.x - projectedPoints.at(-2).x)
          : Math.atan2(Math.sin(rawHeading) * ry * 0.75, Math.cos(rawHeading) * rx * 0.82);
        const arrowLength = Math.max(10, width * 0.022);
        const tip = { x: head.x + Math.cos(angle) * arrowLength, y: head.y + Math.sin(angle) * arrowLength };
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(head.x + Math.cos(angle + 2.55) * arrowLength * 0.76, head.y + Math.sin(angle + 2.55) * arrowLength * 0.76);
        ctx.lineTo(head.x + Math.cos(angle - 2.55) * arrowLength * 0.76, head.y + Math.sin(angle - 2.55) * arrowLength * 0.76);
        ctx.closePath();
        ctx.fillStyle = '#f4ffd9';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(head.x, head.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#d8ff9e';
      ctx.fill();
    } else {
      // A simple batter silhouette marks the guard and makes the ground's
      // batting end immediately recognizable before any sensor movement.
      ctx.beginPath();
      ctx.arc(origin.x, origin.y + 9, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#f4f7ed';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y + 13);
      ctx.lineTo(origin.x, origin.y + 21);
      ctx.moveTo(origin.x, origin.y + 16);
      ctx.lineTo(origin.x - 5, origin.y + 19);
      ctx.moveTo(origin.x, origin.y + 16);
      ctx.lineTo(origin.x + 5, origin.y + 19);
      ctx.moveTo(origin.x, origin.y + 21);
      ctx.lineTo(origin.x - 4, origin.y + 26);
      ctx.moveTo(origin.x, origin.y + 21);
      ctx.lineTo(origin.x + 4, origin.y + 26);
      ctx.moveTo(origin.x + 5, origin.y + 17);
      ctx.lineTo(origin.x + 11, origin.y + 3);
      ctx.strokeStyle = '#f4f7ed';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.stroke();

      // The guard marker is the origin of the live movement trail.
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#d8ff9e';
      ctx.fill();
    }
  }

  return { DIRECTIONS, sectorForDirection, directionForVector, shotGeometry, draw };
});
