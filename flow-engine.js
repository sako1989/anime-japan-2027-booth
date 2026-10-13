/**
 * Small, browser-independent visitor flow simulator. Routes provide their own
 * geometry (`length` + `pointAt(distance)` per leg), so the engine has no DOM,
 * SVG or Three.js dependency. Units are whatever the routes use; the defaults
 * below assume metres and seconds.
 *
 * Visitors steer toward a point a short way ahead on their route, keep a little
 * personal space, stay out of the supplied obstacles and pause at each leg's
 * stop. It is a presentation model: seeded and repeatable, not a calibrated
 * crowd or capacity simulation.
 */
const DEFAULT_ROUTE_SPEED = 1;
const MAX_TICK_SECONDS = 0.25;
const MAX_STEP = 1 / 30;
const ROUTE_START_OFFSET = 0.4;
const MIN_STAGGER = 2.2;
const MAX_STAGGER = 6;
const RESPAWN_DELAY = 0.7;
const RESPAWN_JITTER = 1.6;
const SPAWN_RETRY = 0.2;
const APPEAR_TIME = 0.4;
const LEAVE_TIME = 0.45;
const ARRIVE_TIMEOUT = 3.5;
const STALL_PATIENCE = 0.6;
const STALL_REACH = 2.5;
const SEPARATION_GAIN = 1.15;
// Neighbours are passed on a consistent side so head-on visitors do not mirror each other.
const SIDESTEP_COS = Math.cos(0.7);
const SIDESTEP_SIN = Math.sin(0.7);
const TAU = Math.PI * 2;

const DEFAULT_METRICS = Object.freeze({
  lookahead: 0.5,
  bodyRadius: 0.19,
  personalSpace: 0.78,
  accel: 2.4,
  brake: 4.2,
  arriveRadius: 0.7,
  arriveTolerance: 0.06,
  stride: 1.35,
  turnRate: 9,
  spawnGap: 0.8,
  laneWidth: 0.14,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = value => Number.isFinite(value) ? value : 0;
const wrapAngle = angle => angle - TAU * Math.round(angle / TAU);

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normaliseSpot(spot, key) {
  if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return null;
  const face = spot.face && Number.isFinite(spot.face.x) && Number.isFinite(spot.face.y) ? { x: spot.face.x, y: spot.face.y } : null;
  return { id: String(spot.id ?? key), x: spot.x, y: spot.y, face };
}

function normaliseRoute(route, index) {
  if (!route || typeof route !== 'object') return null;
  const id = String(route.id ?? `route-${index}`);
  const legs = Array.isArray(route.legs) ? route.legs.map((leg, legIndex) => {
    if (!leg || typeof leg.pointAt !== 'function' || !Number.isFinite(leg.length) || leg.length < 0) return null;
    return {
      length: leg.length,
      pointAt: leg.pointAt,
      dwell: Math.max(0, finite(leg.dwell)),
      stop: leg.stop == null ? null : String(leg.stop),
      stopName: leg.stopName == null ? null : String(leg.stopName),
      exit: Boolean(leg.exit),
      spots: (Array.isArray(leg.spots) ? leg.spots : []).map((spot, i) => normaliseSpot(spot, `${id}:${legIndex}:${i}`)).filter(Boolean),
    };
  }).filter(Boolean) : [];
  if (!legs.length) return null;
  const itineraryIndexes = Array.isArray(route.itineraries) && route.itineraries.length
    ? route.itineraries
    : [legs.map((_, legIndex) => legIndex)];
  const itineraries = itineraryIndexes.map(indices => {
    if (!Array.isArray(indices) || !indices.length) return null;
    const selected = indices.every(Number.isInteger)
      ? indices.map(legIndex => legs[legIndex]).filter(Boolean)
      : indices.map(source => legs[route.legs.indexOf(source)]).filter(Boolean);
    return selected.length === indices.length ? selected : null;
  }).filter(Boolean);
  if (!itineraries.length) return null;
  return {
    id,
    legs,
    itineraries,
    speed: Number.isFinite(route.speed) && route.speed > 0 ? route.speed : DEFAULT_ROUTE_SPEED,
    length: Math.max(...itineraries.map(itinerary => itinerary.reduce((total, leg) => total + leg.length, 0))),
  };
}

function normaliseObstacles(obstacles) {
  const circles = (obstacles?.circles ?? []).filter(c => c && [c.x, c.y, c.r].every(Number.isFinite) && c.r > 0).map(c => ({ x: c.x, y: c.y, r: c.r }));
  const segments = (obstacles?.segments ?? []).filter(s => Array.isArray(s) && s.length >= 4 && s.slice(0, 4).every(Number.isFinite)).map(([ax, ay, bx, by]) => {
    const dx = bx - ax, dy = by - ay;
    return { ax, ay, dx, dy, len2: dx * dx + dy * dy, minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minY: Math.min(ay, by), maxY: Math.max(ay, by) };
  });
  return { circles, segments, clearance: Math.max(0, finite(obstacles?.clearance)) };
}

export class FlowEngine {
  constructor({ routes = [], perRoute = 3, seed = 1, obstacles = null, warm = 0, metrics = {} } = {}) {
    this.playing = false;
    this.time = 0;
    this.speed = 1;
    this.completed = 0;
    this.journeys = {};
    this.seed = finite(Number(seed)) >>> 0;
    this.warm = Math.max(0, finite(Number(warm)));
    this.metrics = Object.fromEntries(Object.entries(DEFAULT_METRICS).map(([key, fallback]) => {
      const value = metrics?.[key];
      const valid = Number.isFinite(value) && (key === 'laneWidth' ? value >= 0 : value > 0);
      return [key, valid ? value : fallback];
    }));
    this.obstacles = normaliseObstacles(obstacles);
    this.perRoute = this.#perRoute(perRoute);
    this.routes = [];
    this.activeRouteIds = [];
    this.visitors = [];
    this.claims = new Map();
    this.#loadRoutes(routes);
    this.setRoutes(this.routes.map(route => route.id));
  }

  setRoutes(ids) {
    const wanted = new Set(Array.isArray(ids) ? ids.map(String) : []);
    this.activeRouteIds = this.routes.filter(route => wanted.has(route.id)).map(route => route.id);
    this.reset();
    return this.snapshot();
  }

  setPerRoute(count) {
    this.perRoute = this.#perRoute(count);
    this.reset();
    return this.snapshot();
  }

  reset() {
    // Reset deliberately preserves playing; integrations can reset an active demo
    // without needing to restart their requestAnimationFrame loop.
    this.claims.clear();
    this.visitors = this.activeRouteIds.flatMap((routeId, routeIndex) =>
      Array.from({ length: this.perRoute }, (_, slot) => this.#newVisitor(routeId, routeIndex, slot))
    );
    // Warm-up runs the same deterministic steps so a fresh scene opens mid-flow.
    for (let elapsed = 0; elapsed < this.warm - 1e-9; elapsed += MAX_STEP) this.#step(MAX_STEP);
    this.time = 0;
    this.completed = 0;
    this.journeys = Object.fromEntries(this.activeRouteIds.map(id => [id, 0]));
    return this.snapshot();
  }

  setPlaying(playing) {
    this.playing = Boolean(playing);
    return this.snapshot();
  }

  setSpeed(multiplier) {
    const value = Number(multiplier);
    if (Number.isFinite(value)) this.speed = clamp(value, 0.25, 3);
    return this.snapshot();
  }

  tick(deltaSeconds) {
    if (!this.playing) return this.snapshot();
    const dt = clamp(finite(Number(deltaSeconds)), 0, MAX_TICK_SECONDS);
    if (dt === 0) return this.snapshot();
    this.time += dt;
    const scaled = dt * this.speed;
    const steps = Math.max(1, Math.ceil(scaled / MAX_STEP - 1e-9));
    for (let i = 0; i < steps; i += 1) this.#step(scaled / steps);
    return this.snapshot();
  }

  snapshot() {
    const visitors = this.visitors.map(visitor => this.#visitorSnapshot(visitor));
    const counts = { walking: 0, dwelling: 0, waiting: 0 };
    for (const visitor of this.visitors) {
      if (visitor.state === 'walking') counts.walking += 1;
      else if (visitor.state === 'dwelling') counts.dwelling += 1;
      else if (visitor.state === 'waiting') counts.waiting += 1;
    }
    return {
      playing: this.playing,
      time: this.time,
      speed: this.speed,
      visitors,
      completed: this.completed,
      journeys: { ...this.journeys },
      counts,
      activeCount: this.visitors.length - counts.waiting,
    };
  }

  #loadRoutes(routes) {
    const seen = new Set();
    this.routes = (Array.isArray(routes) ? routes : []).map(normaliseRoute).filter(route => {
      if (!route || seen.has(route.id)) return false;
      seen.add(route.id);
      return true;
    });
  }

  #perRoute(count) {
    return clamp(Math.round(finite(Number(count)) || 1), 1, 6);
  }

  #routeFor(visitor) {
    const route = this.routes.find(item => item.id === visitor.routeId);
    if (!route) return null;
    const itineraryIndex = clamp(visitor.itineraryIndex ?? 0, 0, route.itineraries.length - 1);
    const legs = route.itineraries[itineraryIndex];
    return { ...route, legs, length: legs.reduce((total, leg) => total + leg.length, 0) };
  }

  #newVisitor(routeId, routeIndex, slot) {
    const route = this.routes.find(item => item.id === routeId);
    // Departures are spread over one nominal journey so the route stays evenly populated.
    const cycle = route.length / route.speed + route.legs.reduce((sum, leg) => sum + leg.dwell, 0) + RESPAWN_DELAY;
    const stagger = clamp(cycle / this.perRoute, MIN_STAGGER, MAX_STAGGER);
    return {
      id: `${routeId}-${slot + 1}`,
      routeId,
      slot,
      rng: mulberry32(hashString(`${this.seed}:${routeId}:${slot}`)),
      state: 'waiting',
      remaining: routeIndex * ROUTE_START_OFFSET + slot * stagger,
      legIndex: 0,
      s: 0,
      x: 0,
      y: 0,
      heading: 0,
      speedNow: 0,
      phase: 0,
      appear: 0,
      legTime: 0,
      arriving: 0,
      stall: 0,
      generation: 0,
      itineraryIndex: slot % route.itineraries.length,
      spot: null,
      fallback: null,
      pace: 1,
      lane: 0,
      dwellScale: 1,
      build: 0.5,
      tone: 0.5,
    };
  }

  #step(h) {
    for (const visitor of this.visitors) this.#advance(visitor, h);
    this.#resolveOverlaps();
  }

  #advance(visitor, h) {
    const route = this.#routeFor(visitor);
    if (!route) return;
    if (visitor.state === 'waiting') {
      visitor.remaining -= h;
      if (visitor.remaining > 1e-9) return;
      if (!this.#spawn(visitor, route)) visitor.remaining = SPAWN_RETRY;
      return;
    }
    if (visitor.state === 'leaving') {
      visitor.remaining -= h;
      visitor.appear = clamp(visitor.remaining / LEAVE_TIME, 0, 1);
      if (visitor.remaining > 1e-9) return;
      this.completed += 1;
      this.journeys[visitor.routeId] = (this.journeys[visitor.routeId] ?? 0) + 1;
      visitor.state = 'waiting';
      visitor.appear = 0;
      visitor.remaining = RESPAWN_DELAY + visitor.rng() * RESPAWN_JITTER;
      return;
    }
    visitor.appear = Math.min(1, visitor.appear + h / APPEAR_TIME);
    if (visitor.state === 'walking') this.#walk(visitor, route, h);
    else this.#dwell(visitor, route, h);
  }

  #spawn(visitor, route) {
    // Branches alternate across visitor slots and rotate on each generation.
    // This makes both C itineraries visible even when the UI shows one visitor.
    visitor.itineraryIndex = (visitor.slot + visitor.generation) % route.itineraries.length;
    route = this.#routeFor(visitor);
    const m = this.metrics, leg = route.legs[0];
    const lane = (visitor.rng() * 2 - 1) * m.laneWidth;
    const start = this.#lanePoint(leg, 0, lane);
    for (const other of this.visitors) {
      if (other !== visitor && other.state !== 'waiting' && Math.hypot(other.x - start.x, other.y - start.y) < m.spawnGap) return false;
    }
    const tangent = this.#tangent(leg, 0);
    Object.assign(visitor, {
      state: 'walking',
      legIndex: 0,
      s: 0,
      x: start.x,
      y: start.y,
      heading: Math.atan2(tangent.y, tangent.x),
      speedNow: 0,
      appear: 0,
      legTime: 0,
      arriving: 0,
      stall: 0,
      generation: visitor.generation + 1,
      lane,
      pace: 0.82 + visitor.rng() * 0.36,
      dwellScale: 0.75 + visitor.rng() * 0.6,
      build: visitor.rng(),
      tone: visitor.rng(),
    });
    this.#claimSpot(visitor, leg);
    return true;
  }

  #claimSpot(visitor, leg) {
    this.#releaseSpot(visitor);
    const jitter = visitor.rng(), spread = visitor.rng();
    const count = leg.spots.length;
    if (count) {
      const first = Math.floor(jitter * Math.min(2, count));
      for (let i = 0; i < count; i += 1) {
        const spot = leg.spots[(first + i) % count];
        if (!this.claims.has(spot.id)) { this.claims.set(spot.id, visitor.id); visitor.spot = spot; return; }
      }
      // Every place is taken: wait just off the end of the leg instead.
      const end = leg.pointAt(leg.length), angle = spread * TAU, r = this.metrics.bodyRadius * 2;
      visitor.fallback = { x: end.x + Math.cos(angle) * r, y: end.y + Math.sin(angle) * r, face: leg.spots[0].face };
    }
  }

  #releaseSpot(visitor) {
    if (visitor.spot && this.claims.get(visitor.spot.id) === visitor.id) this.claims.delete(visitor.spot.id);
    visitor.spot = null;
    visitor.fallback = null;
  }

  #tangent(leg, s) {
    const eps = Math.max(1e-4, Math.min(0.02, leg.length / 4));
    const a = leg.pointAt(clamp(s - eps, 0, leg.length)) || {}, b = leg.pointAt(clamp(s + eps, 0, leg.length)) || {};
    const dx = finite(b.x) - finite(a.x), dy = finite(b.y) - finite(a.y), len = Math.hypot(dx, dy);
    return len > 1e-12 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
  }

  #lanePoint(leg, s, lane) {
    const point = leg.pointAt(clamp(s, 0, leg.length)) || {};
    const x = finite(Number(point.x)), y = finite(Number(point.y));
    if (!lane) return { x, y };
    const t = this.#tangent(leg, s);
    return { x: x - t.y * lane, y: y + t.x * lane };
  }

  #stopPoint(visitor, leg) {
    return visitor.spot ?? visitor.fallback ?? this.#lanePoint(leg, leg.length, 0);
  }

  #walk(visitor, route, h) {
    const m = this.metrics, leg = route.legs[visitor.legIndex];
    visitor.legTime += h;
    // The pursuit point stays about one lookahead in front of the visitor.
    const before = visitor.s;
    for (let guard = 0; visitor.s < leg.length && guard < 64; guard += 1) {
      const carrot = this.#lanePoint(leg, visitor.s, visitor.lane);
      if (Math.hypot(carrot.x - visitor.x, carrot.y - visitor.y) >= m.lookahead) break;
      visitor.s = Math.min(leg.length, visitor.s + m.lookahead * 0.2);
    }
    // Held up by an obstacle or a neighbour: let the point creep on so the visitor can slide past.
    visitor.stall = visitor.s > before || visitor.s >= leg.length ? 0 : visitor.stall + h;
    if (visitor.stall > STALL_PATIENCE) {
      const ahead = this.#lanePoint(leg, visitor.s, visitor.lane);
      if (Math.hypot(ahead.x - visitor.x, ahead.y - visitor.y) < m.lookahead * STALL_REACH) visitor.s = Math.min(leg.length, visitor.s + route.speed * h);
    }
    const atEnd = visitor.s >= leg.length;
    const target = atEnd ? this.#stopPoint(visitor, leg) : this.#lanePoint(leg, visitor.s, visitor.lane);
    const dx = target.x - visitor.x, dy = target.y - visitor.y, dist = Math.hypot(dx, dy);
    const passing = leg.dwell === 0 && visitor.legIndex + 1 < route.legs.length;
    if (atEnd) {
      visitor.arriving += h;
      // Completion is never inferred from elapsed time: terminal exit legs must
      // physically reach their external endpoint before the visitor can leave.
      if (dist <= m.arriveTolerance || (passing && dist <= m.lookahead)) {
        if (dist <= m.arriveTolerance) { visitor.x = target.x; visitor.y = target.y; }
        visitor.state = 'dwelling';
        visitor.remaining = leg.dwell * visitor.dwellScale;
        visitor.speedNow = 0;
        return;
      }
    }
    const dirX = dist > 1e-9 ? dx / dist : Math.cos(visitor.heading), dirY = dist > 1e-9 ? dy / dist : Math.sin(visitor.heading);
    let want = route.speed * visitor.pace;
    if (atEnd) want *= clamp(dist / m.arriveRadius, 0.22, 1);
    let sepX = 0, sepY = 0, slow = 1;
    for (const other of this.visitors) {
      if (other === visitor || other.state === 'waiting') continue;
      const ox = visitor.x - other.x, oy = visitor.y - other.y, d = Math.hypot(ox, oy);
      if (d >= m.personalSpace || d < 1e-9) continue;
      const weight = (m.personalSpace - d) / m.personalSpace, ax = ox / d, ay = oy / d;
      sepX += (ax * SIDESTEP_COS - ay * SIDESTEP_SIN) * weight;
      sepY += (ax * SIDESTEP_SIN + ay * SIDESTEP_COS) * weight;
      if (-(ax * dirX + ay * dirY) > 0.55) {
        slow = Math.min(slow, clamp((d - m.bodyRadius * 2) / (m.personalSpace - m.bodyRadius * 2), 0.18, 1));
      }
    }
    // Keep avoidance mostly sideways; slowing handles whoever is directly ahead.
    const along = sepX * dirX + sepY * dirY;
    if (along < 0) { sepX -= dirX * along * 0.7; sepY -= dirY * along * 0.7; }
    const gain = SEPARATION_GAIN * (atEnd ? clamp(dist / 0.6, 0, 1) : 1);
    let moveX = dirX + sepX * gain, moveY = dirY + sepY * gain;
    const moveLen = Math.hypot(moveX, moveY);
    if (moveLen > 1e-9) { moveX /= moveLen; moveY /= moveLen; } else { moveX = dirX; moveY = dirY; }
    const goal = want * slow;
    visitor.speedNow = goal > visitor.speedNow
      ? Math.min(goal, visitor.speedNow + m.accel * h)
      : Math.max(goal, visitor.speedNow - m.brake * h);
    const step = atEnd ? Math.min(visitor.speedNow * h, dist) : visitor.speedNow * h;
    visitor.x += moveX * step;
    visitor.y += moveY * step;
    visitor.phase += step * TAU / m.stride;
    if (step > 1e-6) visitor.heading += wrapAngle(Math.atan2(moveY, moveX) - visitor.heading) * Math.min(1, m.turnRate * h);
    this.#constrain(visitor);
  }

  #dwell(visitor, route, h) {
    const face = visitor.spot?.face ?? visitor.fallback?.face;
    if (face && Math.hypot(face.x - visitor.x, face.y - visitor.y) > 1e-6) {
      const want = Math.atan2(face.y - visitor.y, face.x - visitor.x);
      visitor.heading += wrapAngle(want - visitor.heading) * Math.min(1, this.metrics.turnRate * 0.6 * h);
    }
    visitor.remaining -= h;
    if (visitor.remaining > 1e-9) return;
    this.#releaseSpot(visitor);
    if (visitor.legIndex + 1 < route.legs.length) {
      visitor.legIndex += 1;
      const next = route.legs[visitor.legIndex];
      visitor.s = this.#joinDistance(visitor, next);
      visitor.state = 'walking';
      visitor.legTime = 0;
      visitor.arriving = 0;
      visitor.stall = 0;
      this.#claimSpot(visitor, next);
    } else {
      visitor.state = 'leaving';
      visitor.remaining = LEAVE_TIME;
    }
  }

  // Visitors rejoin the next leg at its nearest early point instead of doubling back.
  #joinDistance(visitor, leg) {
    const reach = Math.min(leg.length, this.metrics.lookahead * 5), step = this.metrics.lookahead * 0.2;
    let best = 0, bestDistance = Infinity;
    for (let s = 0; s <= reach + 1e-9; s += step) {
      const p = this.#lanePoint(leg, s, 0), d = Math.hypot(p.x - visitor.x, p.y - visitor.y);
      if (d < bestDistance - 1e-9) { bestDistance = d; best = s; }
    }
    return best;
  }

  #resolveOverlaps() {
    const min = this.metrics.bodyRadius * 2, list = this.visitors;
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      if (a.state === 'waiting') continue;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        if (b.state === 'waiting') continue;
        const moveA = a.state === 'walking', moveB = b.state === 'walking';
        if (!moveA && !moveB) continue;
        let dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d >= min) continue;
        // Coincident visitors separate along a fixed, index-derived direction.
        if (d < 1e-6) { const angle = (i * 7 + j * 13) % 12 / 12 * TAU; dx = Math.cos(angle); dy = Math.sin(angle); }
        else { dx /= d; dy /= d; }
        const push = (min - d) / (moveA && moveB ? 2 : 1);
        if (moveA) { a.x += dx * push; a.y += dy * push; this.#constrain(a); }
        if (moveB) { b.x -= dx * push; b.y -= dy * push; this.#constrain(b); }
      }
    }
  }

  #constrain(visitor) {
    const { circles, segments, clearance } = this.obstacles;
    for (const circle of circles) {
      const dx = visitor.x - circle.x, dy = visitor.y - circle.y, d = Math.hypot(dx, dy);
      if (d >= circle.r) continue;
      if (d < 1e-9) { visitor.x = circle.x + circle.r; continue; }
      visitor.x = circle.x + dx / d * circle.r;
      visitor.y = circle.y + dy / d * circle.r;
    }
    if (!clearance) return;
    for (const seg of segments) {
      if (visitor.x < seg.minX - clearance || visitor.x > seg.maxX + clearance || visitor.y < seg.minY - clearance || visitor.y > seg.maxY + clearance) continue;
      const t = seg.len2 > 0 ? clamp(((visitor.x - seg.ax) * seg.dx + (visitor.y - seg.ay) * seg.dy) / seg.len2, 0, 1) : 0;
      const px = seg.ax + seg.dx * t, py = seg.ay + seg.dy * t;
      const dx = visitor.x - px, dy = visitor.y - py, d = Math.hypot(dx, dy);
      if (d >= clearance) continue;
      if (d < 1e-9) {
        const length = Math.sqrt(seg.len2);
        visitor.x = px + (length ? -seg.dy / length : 1) * clearance;
        visitor.y = py + (length ? seg.dx / length : 0) * clearance;
        continue;
      }
      visitor.x = px + dx / d * clearance;
      visitor.y = py + dy / d * clearance;
    }
  }

  #visitorSnapshot(visitor) {
    const route = this.#routeFor(visitor);
    // Queued agents always describe the route's initial position, even when they
    // have just respawned from a later leg.
    const queued = visitor.state === 'waiting';
    const legIndex = queued ? 0 : visitor.legIndex;
    const leg = route?.legs[legIndex];
    const start = queued && leg ? this.#lanePoint(leg, 0, 0) : null;
    const tangent = queued && leg ? this.#tangent(leg, 0) : null;
    const heading = tangent ? Math.atan2(tangent.y, tangent.x) : visitor.heading;
    const preceding = route ? route.legs.slice(0, legIndex).reduce((sum, item) => sum + item.length, 0) : 0;
    const progress = queued || !route?.length ? 0 : clamp((preceding + Math.min(visitor.s, leg.length)) / route.length, 0, 1);
    return {
      id: visitor.id,
      routeId: visitor.routeId,
      branch: visitor.itineraryIndex,
      x: start ? start.x : visitor.x,
      y: start ? start.y : visitor.y,
      angle: heading * 180 / Math.PI,
      heading,
      state: visitor.state,
      visible: !queued,
      progress,
      legIndex,
      at: visitor.state === 'dwelling' ? leg?.stop ?? null : null,
      atName: visitor.state === 'dwelling' ? leg?.stopName ?? leg?.stop ?? null : null,
      speed: queued ? 0 : visitor.speedNow,
      phase: visitor.phase,
      appear: queued ? 0 : visitor.appear,
      generation: visitor.generation,
      pace: visitor.pace,
      build: visitor.build,
      tone: visitor.tone,
    };
  }
}
