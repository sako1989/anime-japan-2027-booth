/**
 * Plan data for the illustrative circulation study. DOM-free and Three-free, so
 * the same geometry drives the WebGL scene, the 2D fallback and the Node tests.
 *
 * "Plan" coordinates use the 1000 × 750 tracing of the source section plan
 * (assets/plan.png). "World" coordinates are metres on the 12 × 9 m footprint:
 * +x = plan right, +y = plan bottom (front / entrance side).
 */
export const PLAN = Object.freeze({ width: 1000, height: 750, unit: 0.012 });
export const WALL_WIDTH = 0.12;
export const WALK_SPEED = 0.95;
const BODY_RADIUS = 0.19;

export const planToWorld = (x, y) => ({ x: (x - PLAN.width / 2) * PLAN.unit, y: (y - PLAN.height / 2) * PLAN.unit });
export const worldToPlan = (x, y) => ({ x: x / PLAN.unit + PLAN.width / 2, y: y / PLAN.unit + PLAN.height / 2 });

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const SIZES = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4 };

/** Flattens one SVG subpath (M L H V C Q Z, absolute or relative) into points. */
export function samplePath(d, spacing = 5) {
  const points = [];
  let closed = false, x = 0, y = 0, startX = 0, startY = 0;
  const add = (px, py) => {
    const last = points[points.length - 1];
    if (!last || Math.hypot(last.x - px, last.y - py) > 1e-6) points.push({ x: px, y: py });
    x = px; y = py;
  };
  const curve = (at, chord) => {
    const steps = Math.max(2, Math.ceil(chord / spacing));
    for (let i = 1; i <= steps; i += 1) { const p = at(i / steps); add(p.x, p.y); }
  };
  for (const [, letter, body] of String(d).matchAll(/([MLHVCQZ])([^MLHVCQZ]*)/gi)) {
    const command = letter.toUpperCase();
    if (command === 'Z') { closed = true; x = startX; y = startY; continue; }
    const values = (body.match(NUMBER) || []).map(Number);
    const relative = letter !== command;
    const size = SIZES[command];
    for (let i = 0; i + size <= values.length; i += size) {
      const v = values.slice(i, i + size);
      const ox = relative ? x : 0, oy = relative ? y : 0;
      if (command === 'M' && i === 0) { add(ox + v[0], oy + v[1]); startX = x; startY = y; }
      else if (command === 'M' || command === 'L') add(ox + v[0], oy + v[1]);
      else if (command === 'H') add(ox + v[0], y);
      else if (command === 'V') add(x, oy + v[0]);
      else if (command === 'C') {
        const x0 = x, y0 = y, x1 = ox + v[0], y1 = oy + v[1], x2 = ox + v[2], y2 = oy + v[3], x3 = ox + v[4], y3 = oy + v[5];
        curve(t => {
          const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
          return { x: a * x0 + b * x1 + c * x2 + e * x3, y: a * y0 + b * y1 + c * y2 + e * y3 };
        }, Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2));
      } else {
        const x0 = x, y0 = y, x1 = ox + v[0], y1 = oy + v[1], x2 = ox + v[2], y2 = oy + v[3];
        curve(t => {
          const u = 1 - t, a = u * u, b = 2 * u * t, c = t * t;
          return { x: a * x0 + b * x1 + c * x2, y: a * y0 + b * y1 + c * y2 };
        }, Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1));
      }
    }
  }
  return { points, closed };
}

/** Arc-length parameterised polyline. */
export function makePolyline(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const length = cumulative[cumulative.length - 1] || 0;
  const pointAt = distance => {
    if (!points.length) return { x: 0, y: 0 };
    const d = Math.min(length, Math.max(0, Number.isFinite(distance) ? distance : 0));
    let low = 0, high = cumulative.length - 1;
    while (high - low > 1) { const mid = (low + high) >> 1; if (cumulative[mid] <= d) low = mid; else high = mid; }
    const span = cumulative[high] - cumulative[low];
    const t = span > 0 ? (d - cumulative[low]) / span : 0;
    const a = points[low], b = points[high];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  return { points, cumulative, length, pointAt };
}

function normalAt(points, i) {
  const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len, tx: dx / len, ty: dy / len };
}

/** Shifts a polyline sideways; positive distances follow the normal (−ty, tx). */
export function offsetPolyline(points, distance) {
  return points.map((p, i) => { const n = normalAt(points, i); return { x: p.x + n.x * distance, y: p.y + n.y * distance }; });
}

/** Closed outline of a constant-width band with rounded ends, for extrusion. */
export function ribbonOutline(points, width, capSteps = 6) {
  const half = width / 2, left = [], right = [];
  points.forEach((p, i) => {
    const n = normalAt(points, i);
    left.push({ x: p.x + n.x * half, y: p.y + n.y * half });
    right.push({ x: p.x - n.x * half, y: p.y - n.y * half });
  });
  const cap = (p, n, sign) => Array.from({ length: capSteps - 1 }, (_, k) => {
    const a = Math.PI * (k + 1) / capSteps;
    return { x: p.x + half * sign * (Math.cos(a) * n.x + Math.sin(a) * n.tx), y: p.y + half * sign * (Math.cos(a) * n.y + Math.sin(a) * n.ty) };
  });
  const last = points.length - 1;
  return [...left, ...cap(points[last], normalAt(points, last), 1), ...right.reverse(), ...cap(points[0], normalAt(points, 0), -1)];
}

export function circlePoints(cx, cy, radius, steps = 64) {
  return Array.from({ length: steps }, (_, i) => {
    const a = i / steps * Math.PI * 2;
    return { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius };
  });
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export const worldPath = (d, spacing = 5) => samplePath(d, spacing).points.map(p => planToWorld(p.x, p.y));

// Section outlines traced from the source plan. `label` anchors the 3D overlay
// (plan x/y plus height in metres); `centre` is the flat-plan label position.
export const ZONES = [
  { id: 'S4', name: 'Game IPs', tint: '#cfdcc2', deep: '#5f8a63', label: { x: 250, y: 12, h: 1.34 }, centre: { x: 98, y: 112 },
    d: 'M110 286 C47 279 10 224 10 154 C10 70 85 10 157 10 L345 10 C416 10 416 77 496 80 C526 83 552 61 571 43 L550 84 L564 246 Q359 287 110 286Z' },
  { id: 'S2', name: 'Company introduction', tint: '#c9dfe8', deep: '#5d9fbd', label: { x: 760, y: 12, h: 1.34 }, centre: { x: 615, y: 200 },
    d: 'M550 84 C587 67 600 10 674 10 L840 10 C928 10 990 88 990 168 L990 250 L827 250 L827 334 C827 416 771 447 672 451 Q621 450 590 463 L564 246Z' },
  { id: 'S3', name: 'Activation', tint: '#efd3d7', deep: '#c9788c', label: { x: 356, y: 375, h: 1.62 }, centre: { x: 356, y: 375 },
    d: 'M110 286 Q359 287 564 246 L590 463 L558 482 Q358 454 110 453Z' },
  { id: 'S5', name: 'Anime & manga', tint: '#ecdcaa', deep: '#c2a03f', label: { x: 12, y: 600, h: 1.34 }, centre: { x: 385, y: 560 },
    d: 'M110 453 Q358 454 558 482 C522 504 492 558 492 604 L492 680 C475 723 434 742 382 742 L148 742 C64 742 10 675 10 601 C10 527 52 460 110 453Z' },
  { id: 'S0', name: 'VIP & guests', tint: '#f7f2e7', deep: '#b9ab8c', label: { x: 650, y: 590, h: 0.05 }, centre: { x: 640, y: 590 },
    d: 'M590 463 Q633 447 714 452 C717 500 747 522 757 565 C775 623 765 690 765 742 L612 742 C539 742 495 721 494 672 L494 604 C494 544 527 500 590 463Z' },
  { id: 'S1', name: 'Welcome', tint: '#ddd1ec', deep: '#9a7fc4', label: { x: 992, y: 345, h: 1.34 }, centre: { x: 895, y: 590 },
    d: 'M827 250 L990 250 L990 447 L1000 447 L1000 750 L765 750 C765 690 775 623 757 565 C747 522 717 500 714 452 C771 436 827 408 827 334Z' },
];

export const WALLS = [
  { id: 'rear', d: 'M110 286 C47 279 10 224 10 154 C10 70 85 10 157 10 L345 10 C416 10 416 77 496 80 C558 82 578 10 674 10 L840 10 C928 10 990 88 990 168 L990 447' },
  { id: 'front-left', d: 'M110 453 C52 460 10 527 10 601 C10 675 64 742 148 742 L382 742 C434 742 475 723 492 680' },
  { id: 'entry', d: 'M565 486 C524 515 494 544 494 604 L494 672 C495 721 539 742 612 742 L651 742' },
  { id: 'inner', d: 'M817 150 L817 334 C817 420 771 449 672 451 Q621 450 596 463' },
];

// Central S3 feature: the plan's circular enclosure near Blender (−1.73, 0).
export const RING = Object.freeze({ x: 356, y: 375, r: 59 });

// Illustrative proxies only. `face` is the plan direction (degrees, 0 = +x,
// 90 = toward the front) that the fixture addresses its visitors from.
export const FIXTURES = {
  stations: [
    { id: 'G1', x: 150, y: 44, face: 90 }, { id: 'G2', x: 215, y: 44, face: 90 }, { id: 'G3', x: 280, y: 44, face: 90 },
    { id: 'G4', x: 345, y: 46, face: 90 }, { id: 'G5', x: 46, y: 165, face: 0 },
  ],
  displays: [
    { id: 'D1', x: 175, y: 708, face: -90 }, { id: 'D2', x: 245, y: 708, face: -90 }, { id: 'D3', x: 315, y: 708, face: -90 },
    { id: 'D4', x: 44, y: 600, face: 0 }, { id: 'D5', x: 462, y: 610, face: 180 },
  ],
  // Three bays of 2 + 2 + 1 positions: the approved 15-position recognition gallery.
  trophyBays: [{ x: 796, y: 195, face: 180 }, { x: 796, y: 262, face: 180 }, { x: 796, y: 329, face: 180 }],
  timeline: { d: 'M990 384 L990 168 C990 88 928 10 858 10', offset: -0.085 },
  processWall: { d: 'M817 166 L817 334', offset: -0.085 },
  treatsCounter: { d: 'M845 338 C843 384 824 420 790 444' },
  vipPosts: [{ x: 750, y: 529 }, { x: 776, y: 629 }, { x: 761, y: 729 }],
  seat: { d: 'M524 600 L524 668 C528 700 560 714 606 714' },
  table: { x: 592, y: 640 },
};

const fixtureSpot = (fixture, distance = 52) => {
  const a = fixture.face * Math.PI / 180;
  return { id: fixture.id, x: fixture.x + Math.cos(a) * distance, y: fixture.y + Math.sin(a) * distance, face: [fixture.x, fixture.y] };
};
const pick = (list, ids) => ids.map(id => fixtureSpot(list.find(item => item.id === id)));
const ringSpot = (id, degrees, radius = 106) => {
  const a = degrees * Math.PI / 180;
  return { id, x: RING.x + Math.cos(a) * radius, y: RING.y + Math.sin(a) * radius, face: [RING.x, RING.y] };
};

// Confirmed visitor-flow markers. These are intentionally independent of the
// illustrative fixture proxies so the renderer can label the exact destinations.
export const EXIT = Object.freeze({ x: 40, y: 375, endX: -85, endY: 375, label: 'Exit' });
export const STOP_POINTS = Object.freeze([
  { id: 'junction', x: 515, y: 150, label: 'S2 / S4 junction', section: 'S4' },
  { id: 'awards', x: 746, y: 255, label: 'S2 awards', section: 'S2' },
  { id: 's5-inner', x: 410, y: 565, label: 'S5 inner', section: 'S5' },
  { id: 's5-left', x: 100, y: 595, label: 'S5 left', section: 'S5' },
]);
const stopPoint = id => STOP_POINTS.find(point => point.id === id);
const stopSpot = (id, face = null) => {
  const point = stopPoint(id);
  return { id: `stop-${id}`, x: point.x, y: point.y, face: face ?? [point.x, point.y - 42] };
};
const exitLeg = d => ({ d, dwell: 0, stop: 'Exit', exit: true });

// The four journeys requested on 12 October 2026. Centre-lines, pauses and
// stopping places are illustrative: not surveyed paths or capacity assumptions.
export const FLOW_ROUTES = [
  { id: 'A', title: 'S2 → S4 → Exit', subtitle: 'Junction, game IPs, exit', color: '#0e8f78', stops: ['S2', 'S4', 'Exit'], legs: [
    { d: 'M926 240 L926 160 C900 100 820 92 740 112 C660 132 588 148 515 150', dwell: 3.4, stop: 'S4', stopName: 'S2 / S4 junction', spots: [stopSpot('junction')] },
    { d: 'M515 150 C430 148 350 150 258 190', dwell: 3.4, stop: 'S4', stopName: 'Game stations', spots: pick(FIXTURES.stations, ['G2', 'G1', 'G5', 'G3', 'G4']) },
    exitLeg('M258 190 C210 220 160 285 160 345 C160 367 130 375 100 375 L-85 375'),
  ] },
  { id: 'B', title: 'S2 → S3 → S4 → Exit', subtitle: 'Awards, activation, game IPs, exit', color: '#d97f1e', stops: ['S2', 'S3', 'S4', 'Exit'], legs: [
    { d: 'M903 240 L903 160 C903 115 870 78 828 78 C775 78 728 118 700 180 C690 210 720 238 746 255', dwell: 3.8, stop: 'S2', stopName: 'S2 awards', spots: [stopSpot('awards', [796, 255])] },
    { d: 'M746 255 C715 330 645 390 480 410', dwell: 4.4, stop: 'S3', stopName: 'Activation', spots: [ringSpot('B1', 10), ringSpot('B2', 30), ringSpot('B3', 48), ringSpot('B4', 20, 150)] },
    { d: 'M480 410 C450 300 360 215 258 190', dwell: 3.4, stop: 'S4', stopName: 'Game stations', spots: pick(FIXTURES.stations, ['G2', 'G1', 'G5', 'G3', 'G4']) },
    exitLeg('M258 190 C210 220 160 285 160 345 C160 367 130 375 100 375 L-85 375'),
  ] },
  { id: 'C', title: 'S2 → S3 → S5', subtitle: 'S2 → S3 → S5 → Exit, or S4 → Exit', color: '#5560d8', stops: ['S2', 'S3', 'S5', 'Exit'], legs: [
    { d: 'M880 240 L880 160 C880 123 850 93 813 93 C776 93 746 123 720 180 C705 210 725 238 746 255', dwell: 3.8, stop: 'S2', stopName: 'S2 awards', spots: [stopSpot('awards', [796, 255])] },
    { d: 'M746 255 C715 330 645 390 480 410', dwell: 4.4, stop: 'S3', stopName: 'Activation', spots: [ringSpot('C1', 10), ringSpot('C2', 30), ringSpot('C3', 48), ringSpot('C4', 20, 150)] },
    { d: 'M480 410 C460 465 430 525 410 565', dwell: 3.4, stop: 'S5', stopName: 'S5 inner', spots: [stopSpot('s5-inner', [450, 565])] },
    { d: 'M410 565 C325 590 210 600 100 595', dwell: 3.4, stop: 'S5', stopName: 'S5 left', spots: [stopSpot('s5-left', [145, 595])] },
    exitLeg('M100 595 C92 540 105 485 130 430 C135 395 110 375 80 375 L-85 375'),
    { d: 'M100 595 C92 540 105 485 130 430 C145 350 185 255 258 190', dwell: 3.4, stop: 'S4', stopName: 'Game stations', spots: pick(FIXTURES.stations, ['G2', 'G1', 'G5', 'G3', 'G4']) },
    exitLeg('M258 190 C210 220 160 285 160 345 C160 367 130 375 100 375 L-85 375'),
  ], itineraries: [[0, 1, 2, 3, 4], [0, 1, 2, 3, 5, 6]] },
  { id: 'D', title: 'S4 → S3 → S5 → Exit', subtitle: 'Games, activation, anime & manga, exit', color: '#cc3f74', stops: ['S4', 'S3', 'S5', 'Exit'], legs: [
    { d: 'M210 150 C165 172 148 232 156 292 C162 338 190 372 236 384', dwell: 4.4, stop: 'S3', stopName: 'Activation', spots: [ringSpot('D1', 170), ringSpot('D2', 190), ringSpot('D3', 210), ringSpot('D4', 180, 150)] },
    { d: 'M236 384 C218 450 250 508 330 535 C368 550 390 560 410 565', dwell: 3.4, stop: 'S5', stopName: 'S5 inner', spots: [stopSpot('s5-inner', [450, 565])] },
    { d: 'M410 565 C325 590 210 600 100 595', dwell: 3.4, stop: 'S5', stopName: 'S5 left', spots: [stopSpot('s5-left', [145, 595])] },
    exitLeg('M100 595 C92 540 105 485 130 430 C135 395 110 375 80 375 L-85 375'),
  ] },
];

/** Engine-ready routes in metres. */
export function buildEngineRoutes(routes = FLOW_ROUTES, speed = WALK_SPEED) {
  return routes.map(route => {
    const legs = route.legs.map(leg => {
      const line = makePolyline(worldPath(leg.d, 4));
      return {
        length: line.length,
        pointAt: line.pointAt,
        dwell: leg.dwell,
        stop: leg.stop,
        stopName: leg.stopName,
        exit: Boolean(leg.exit),
        spots: (leg.spots || []).map(spot => ({ id: spot.id, ...planToWorld(spot.x, spot.y), face: planToWorld(spot.face[0], spot.face[1]) })),
      };
    });
    return {
      id: route.id,
      speed,
      legs,
      itineraries: (route.itineraries ?? [legs.map((_, index) => index)]).map(indices => indices.map(index => legs[index]).filter(Boolean)),
    };
  });
}

/** Walls and the central ring as engine obstacles, in metres. */
export function buildObstacles() {
  const segments = [];
  for (const wall of WALLS) {
    const points = worldPath(wall.d, 12);
    for (let i = 1; i < points.length; i += 1) segments.push([points[i - 1].x, points[i - 1].y, points[i].x, points[i].y]);
  }
  const ring = planToWorld(RING.x, RING.y);
  return {
    clearance: WALL_WIDTH / 2 + BODY_RADIUS,
    segments,
    circles: [{ x: ring.x, y: ring.y, r: RING.r * PLAN.unit + WALL_WIDTH / 2 + BODY_RADIUS }],
  };
}

let zonePolygons = null;
/** Section id containing a world-space point, or null outside every section. */
export function zoneAt(x, y) {
  zonePolygons ??= ZONES.map(zone => ({ id: zone.id, polygon: samplePath(zone.d, 4).points }));
  const point = worldToPlan(x, y);
  return zonePolygons.find(zone => pointInPolygon(point, zone.polygon))?.id ?? null;
}
