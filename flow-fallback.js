/**
 * Canvas 2D stand-in for flow-scene.js when WebGL is unavailable. It draws the
 * same plan, routes and engine snapshot from above and mirrors the scene's
 * interface, so FlowSimulation drives either renderer identically.
 */
import { EXIT, FIXTURES, PLAN, RING, WALLS, WALL_WIDTH, ZONES, samplePath, worldToPlan } from './flow-world.js';

const TAU = Math.PI * 2;
const WALL = '#35312c';
const SKIN = ['#f3d9c3', '#e6bf9f', '#c99872', '#a9744f'];
const HAIR = ['#2b2420', '#4a3426', '#6b4a2e', '#1d1f26', '#8a6a48'];

export class FlowFallback {
  constructor({ host, routes, sourcePlan = 'assets/plan.png' }) {
    this.kind = 'canvas2d';
    this.routes = routes;
    this.active = routes.map(route => route.id);
    this.sourcePlanUrl = sourcePlan;
    this.showSource = false;
    this.image = null;
    this.snapshot = null;
    this.clock = 0;
    this.followId = null;
    this.width = 1; this.height = 1;
    this.pad = { top: 64, bottom: 96, side: 24 };
    this.dirty = true;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'flow-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Illustrative plan-view circulation study of the booth sections with walking visitors');
    this.ctx = this.canvas.getContext('2d');
    host.append(this.canvas);
    this.zones = ZONES.map(zone => ({ ...zone, path: new Path2D(zone.d) }));
    this.walls = WALLS.map(wall => new Path2D(wall.d));
    this.legs = new Map(routes.map(route => [route.id, route.legs.map(leg => ({ path: new Path2D(leg.d), points: samplePath(leg.d, 6).points, stop: !leg.exit && leg.dwell > 0 }))]));
  }

  #frame() {
    // 16 px keeps the base plate and its shadow clear of the pills and the dock.
    const top = this.pad.top + 16, free = this.height - top - this.pad.bottom - 16;
    const left = EXIT.endX - 55, extent = PLAN.width - left;
    const scale = Math.max(0.05, Math.min((this.width - this.pad.side * 2) / extent, free / PLAN.height));
    return { scale, x: (this.width - extent * scale) / 2 - left * scale, y: top + (free - PLAN.height * scale) / 2 };
  }

  setSize(width, height, pad = {}) {
    if (!(width > 0 && height > 0)) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.width = width; this.height = height; this.ratio = ratio;
    this.pad = { top: pad.top ?? 64, bottom: pad.bottom ?? 96, side: Math.min(pad.side ?? 24, 28) };
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.dirty = true;
  }

  setView() {}

  setActiveRoutes(ids) { this.active = ids; this.dirty = true; }

  setSourcePlan(show, onError) {
    if (show && !this.image) {
      this.image = new Image();
      this.image.onload = () => { this.dirty = true; };
      this.image.onerror = () => { this.image = null; this.showSource = false; this.dirty = true; onError?.(); };
      this.image.src = this.sourcePlanUrl;
    }
    this.showSource = show;
    this.dirty = true;
  }

  setFollow(id) { this.followId = id || null; this.dirty = true; }

  pick(x, y) {
    if (!this.snapshot) return null;
    const frame = this.#frame();
    let best = null, bestDistance = 16;
    for (const visitor of this.snapshot.visitors) {
      if (!visitor.visible) continue;
      const p = worldToPlan(visitor.x, visitor.y), d = Math.hypot(frame.x + p.x * frame.scale - x, frame.y + p.y * frame.scale - y);
      if (d < bestDistance) { best = visitor.id; bestDistance = d; }
    }
    return best;
  }

  step() { return this.dirty; }

  update(snapshot, clock) { this.snapshot = snapshot; this.clock = clock; this.dirty = true; }

  render() {
    const ctx = this.ctx, frame = this.#frame(), unit = 1 / PLAN.unit;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(frame.x, frame.y);
    ctx.scale(frame.scale, frame.scale);
    ctx.lineCap = ctx.lineJoin = 'round';

    ctx.save();
    ctx.shadowColor = 'rgba(84,62,30,.22)'; ctx.shadowBlur = 28 * this.ratio; ctx.shadowOffsetY = 10 * this.ratio;
    ctx.fillStyle = '#fbf8f1';
    ctx.beginPath(); ctx.roundRect(-14, -14, PLAN.width + 28, PLAN.height + 28, 56); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#e5e1d6';
    ctx.fillRect(EXIT.endX - 48, EXIT.y - 62, 112 - EXIT.endX + 48, 124);
    if (this.showSource && this.image?.complete && this.image.naturalWidth) ctx.drawImage(this.image, 0, 0, PLAN.width, PLAN.height);
    else for (const zone of this.zones) { ctx.fillStyle = zone.tint; ctx.fill(zone.path); }

    // Fixture proxies, then walls and the central enclosure.
    const square = (item, size, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(item.x - size / 2, item.y - size / 2, size, size, 4); ctx.fill(); };
    for (const item of FIXTURES.stations) square(item, 34, '#5f8a63');
    for (const item of FIXTURES.displays) square(item, 34, '#c2a03f');
    for (const item of FIXTURES.trophyBays) square(item, 26, '#c9a23f');
    ctx.strokeStyle = '#c9a780'; ctx.lineWidth = 24; ctx.stroke(new Path2D(FIXTURES.treatsCounter.d));
    ctx.strokeStyle = '#e3d7c2'; ctx.lineWidth = 32; ctx.stroke(new Path2D(FIXTURES.seat.d));
    ctx.strokeStyle = WALL; ctx.lineWidth = WALL_WIDTH * unit;
    for (const wall of this.walls) ctx.stroke(wall);
    ctx.fillStyle = '#f8cfd4';
    ctx.beginPath(); ctx.arc(RING.x, RING.y, RING.r, 0, TAU); ctx.fill(); ctx.stroke();

    for (const route of this.routes) {
      if (!this.active.includes(route.id)) continue;
      for (const leg of this.legs.get(route.id)) {
        const end = leg.points[leg.points.length - 1];
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,253,248,.7)'; ctx.lineWidth = 16; ctx.stroke(leg.path);
        ctx.strokeStyle = route.color; ctx.lineWidth = 6;
        ctx.setLineDash([16, 18]); ctx.lineDashOffset = -(this.clock * 0.9 * unit) % 34;
        ctx.stroke(leg.path);
        ctx.setLineDash([]);
        if (leg.stop) {
          ctx.fillStyle = '#fffdf8'; ctx.lineWidth = 5;
          ctx.beginPath(); ctx.arc(end.x, end.y, 12, 0, TAU); ctx.fill(); ctx.stroke();
        }
      }
    }

    for (const visitor of this.snapshot?.visitors ?? []) {
      if (!visitor.visible) continue;
      const route = this.routes.find(item => item.id === visitor.routeId), p = worldToPlan(visitor.x, visitor.y);
      const moving = Math.min(1, visitor.speed / 0.55), swing = Math.sin(visitor.phase) * 9 * moving;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(visitor.appear, visitor.appear);
      if (visitor.state === 'dwelling' || visitor.id === this.followId) {
        ctx.strokeStyle = visitor.id === this.followId ? '#2a2824' : route.color; ctx.globalAlpha = 0.5; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, 25 + Math.sin(this.clock * 3.2) * 3, 0, TAU); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.rotate(visitor.heading);
      ctx.fillStyle = 'rgba(60,44,22,.18)';
      ctx.beginPath(); ctx.ellipse(-3, 4, 15, 17, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#4b4640';
      for (const side of [1, -1]) { ctx.beginPath(); ctx.ellipse(side * swing, side * 6, 7, 4, 0, 0, TAU); ctx.fill(); }
      ctx.fillStyle = route.color;
      ctx.beginPath(); ctx.ellipse(0, 0, 9, 16, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = HAIR[Math.floor((visitor.tone * 7.3) % 1 * HAIR.length)];
      ctx.beginPath(); ctx.arc(-1, 0, 9.5, 0, TAU); ctx.fill();
      ctx.fillStyle = SKIN[Math.floor(visitor.tone * SKIN.length) % SKIN.length];
      ctx.beginPath(); ctx.arc(3, 0, 7, -1.2, 1.2); ctx.fill();
      ctx.restore();
    }

    ctx.textAlign = 'center';
    for (const zone of this.zones) {
      ctx.fillStyle = '#2a2824'; ctx.font = '600 26px Georgia, serif';
      ctx.fillText(zone.id, zone.centre.x, zone.centre.y - (zone.id === 'S3' ? -9 : 4));
      if (zone.id === 'S3') continue;
      ctx.fillStyle = '#6f6656'; ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(zone.name.toUpperCase(), zone.centre.x, zone.centre.y + 16);
    }
    ctx.fillStyle = '#536556'; ctx.font = '600 19px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('← EXIT', EXIT.x - 35, EXIT.y - 50);
    this.dirty = false;
  }

  dispose() {
    if (this.image) this.image.onload = this.image.onerror = null;
    this.canvas.remove();
  }
}
