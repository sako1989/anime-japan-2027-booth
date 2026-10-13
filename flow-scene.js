/**
 * WebGL stage for the circulation study: a low cutaway of the section plan with
 * illustrative fixture proxies, route ribbons and walking figures. Everything
 * drawn here comes from flow-world.js; nothing is loaded from the Blender export.
 * World metres map to Three as (x, height, y), so plan top (rear) is −z.
 */
import * as THREE from 'three';
import { OrbitControls } from './vendor/controls/OrbitControls.js';
import {
  EXIT, FIXTURES, PLAN, RING, WALLS, WALL_WIDTH, ZONES,
  circlePoints, makePolyline, offsetPolyline, planToWorld, ribbonOutline, worldPath,
} from './flow-world.js';

const WALL_HEIGHT = 1.05;
const DASH_PERIOD = 0.46;
const TAU = Math.PI * 2;
const HOME_TARGET = new THREE.Vector3(0, 0.3, 0.1);
const VIEWS = { perspective: { theta: -0.4, phi: 0.8 }, plan: { theta: 0, phi: 0.0008 } };
const INK = '#2a2824';
const TONE = {
  slabTop: '#fbf8f1', slabSide: '#e2d8c6', wall: '#fbf8f2', wallCap: '#35312c', fixture: '#f4eee2', fixtureShade: '#ddd3c1',
  gold: '#c9a23f', rope: '#8d2231', wood: '#c9a780', woodTop: '#e3cba8', seat: '#e3d7c2', shoe: '#f6f1e7',
  skin: ['#f3d9c3', '#e6bf9f', '#c99872', '#a9744f'],
  hair: ['#2b2420', '#4a3426', '#6b4a2e', '#1d1f26', '#8a6a48'],
  legs: ['#3a3f4a', '#4b4640', '#2f3a3a', '#5a5248'],
};

const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...extra });
const toShape = points => new THREE.Shape(points.map(p => new THREE.Vector2(p.x, -p.y)));
const faceRotation = degrees => Math.PI / 2 - degrees * Math.PI / 180;
const smooth = t => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };
const popIn = t => { const u = Math.min(1, Math.max(0, t)) - 1; return 1 + 2.2 * u * u * u + 1.2 * u * u; };

function flatMesh(points, y, material) {
  const geometry = new THREE.ShapeGeometry(toShape(points));
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

// ExtrudeGeometry groups: 0 = the two caps, 1 = the sides.
function solid(points, height, y, material, holes = []) {
  const shape = toShape(points);
  shape.holes = holes.map(hole => new THREE.Path(hole.map(p => new THREE.Vector2(p.x, -p.y))));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = y;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// `radii` runs front-right, front-left, rear-left, rear-right.
function roundedRect(halfW, halfH, radii, steps = 12) {
  const points = [];
  [[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(([sx, sy], corner) => {
    const radius = radii[corner];
    for (let i = 0; i <= steps; i += 1) {
      const a = (corner + i / steps) * Math.PI / 2;
      points.push({ x: sx * (halfW - radius) + Math.cos(a) * radius, y: sy * (halfH - radius) + Math.sin(a) * radius });
    }
  });
  return points;
}

// Flat band on the floor; u runs along the path in dash periods.
function stripGeometry(points, width) {
  const count = points.length, position = new Float32Array(count * 6), uv = new Float32Array(count * 4), index = [];
  let distance = 0;
  for (let i = 0; i < count; i += 1) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(count - 1, i + 1)], p = points[i];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len * width / 2, ny = dx / len * width / 2;
    if (i) distance += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);
    position.set([p.x + nx, 0, p.y + ny, p.x - nx, 0, p.y - ny], i * 6);
    uv.set([distance / DASH_PERIOD, 1, distance / DASH_PERIOD, 0], i * 4);
    if (i < count - 1) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class FlowScene {
  constructor({ host, labels, routes, sourcePlan = 'assets/plan.png', reducedMotion = false, onContextLost = null }) {
    this.kind = 'webgl';
    this.host = host;
    this.labelHost = labels;
    this.sourcePlanUrl = sourcePlan;
    this.reducedMotion = reducedMotion;
    this.view = 'perspective';
    this.width = 1; this.height = 1;
    this.pad = { top: 64, bottom: 96, side: 56 };
    this.home = { perspective: { radius: 26, target: HOME_TARGET.clone() }, plan: { radius: 30, target: HOME_TARGET.clone() } };
    this.figures = new Map();
    this.routeStyle = new Map();
    this.followId = null;
    this.dirty = true;
    this.tween = null;
    this.userMoved = false;

    const canvas = document.createElement('canvas');
    canvas.className = 'flow-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Illustrative 3D circulation study of the booth sections with walking visitors');
    // Probe for WebGL 2 here so an unsupported browser falls back to 2D quietly,
    // without Three logging a console error on its way to throwing.
    const context = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'high-performance' });
    if (!context) throw new Error('WebGL 2 is not available.');
    this.renderer = new THREE.WebGLRenderer({ canvas, context });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = canvas;
    host.append(canvas);
    this.onLost = event => { event.preventDefault(); onContextLost?.(); };
    canvas.addEventListener('webglcontextlost', this.onLost);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 220);
    this.raycaster = new THREE.Raycaster();
    this.#light();
    this.#buildBase();
    this.#buildWalls();
    this.#buildFixtures();
    this.#buildRoutes(routes);
    this.#buildFigureAssets();
    this.#buildLabels();

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = 1.36;
    this.controls.minDistance = 3;
    this.controls.zoomSpeed = 0.8;
    this.onControlStart = () => { this.tween = null; this.followZoom = false; this.userMoved = true; };
    this.onControlChange = () => { this.dirty = true; };
    this.controls.addEventListener('start', this.onControlStart);
    this.controls.addEventListener('change', this.onControlChange);
    this.#place({ ...VIEWS.perspective, ...this.home.perspective });
  }

  #light() {
    this.scene.add(new THREE.HemisphereLight('#fffaf0', '#e6dccb', 2.35));
    const sun = new THREE.DirectionalLight('#fff3df', 1.15);
    sun.position.set(-5.5, 11, 6.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 8, bottom: -8, near: 1, far: 32 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#eef2ff', 0.35);
    fill.position.set(7, 6, -5);
    this.scene.add(fill);
  }

  #buildBase() {
    const world = new THREE.Group();
    this.scene.add(world);
    this.world = world;

    // Soft contact beneath the base plate; the page background shows through the canvas.
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(17, 13.5), basic('#ffffff', {
      map: canvasTexture(128, 128, (ctx, w) => {
        const g = ctx.createRadialGradient(w / 2, w / 2, w * 0.2, w / 2, w / 2, w / 2);
        g.addColorStop(0, 'rgba(84,62,30,.30)'); g.addColorStop(1, 'rgba(84,62,30,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
      }), transparent: true, depthWrite: false,
    }));
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = -0.139;
    world.add(contact);
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.12 }));
    catcher.rotation.x = -Math.PI / 2;
    catcher.position.y = -0.138;
    catcher.receiveShadow = true;
    world.add(catcher);

    const half = { w: PLAN.width * PLAN.unit / 2, h: PLAN.height * PLAN.unit / 2 };
    world.add(solid(roundedRect(half.w + 0.16, half.h + 0.16, [0.45, 1.7, 1.7, 1.7]), 0.14, -0.14, [lambert(TONE.slabTop), lambert(TONE.slabSide)]));

    // A neutral strip of exhibition aisle keeps the entire departure visible.
    world.add(flatMesh([
      planToWorld(EXIT.endX - 48, EXIT.y - 62), planToWorld(112, EXIT.y - 62),
      planToWorld(112, EXIT.y + 62), planToWorld(EXIT.endX - 48, EXIT.y + 62),
    ], 0.008, lambert('#e5e1d6')));
    const arrow = new THREE.Mesh(new THREE.PlaneGeometry(0.54, 0.34), basic('#ffffff', {
      map: canvasTexture(160, 100, ctx => {
        ctx.strokeStyle = '#5b685d'; ctx.lineWidth = 10; ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(132, 50); ctx.lineTo(26, 50);
        ctx.moveTo(53, 22); ctx.lineTo(25, 50); ctx.lineTo(53, 78); ctx.stroke();
      }), transparent: true, depthWrite: false,
    }));
    const exitPoint = planToWorld(EXIT.x, EXIT.y + 42);
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(exitPoint.x, 0.03, exitPoint.y);
    world.add(arrow);

    this.zoneFloors = new THREE.Group();
    for (const zone of ZONES) this.zoneFloors.add(flatMesh(worldPath(zone.d, 4), 0.006, lambert(zone.tint)));
    world.add(this.zoneFloors);

    // The unchanged source plan can replace the tinted floors; loaded on first use.
    this.planFloor = new THREE.Mesh(new THREE.PlaneGeometry(half.w * 2, half.h * 2), lambert('#ffffff'));
    this.planFloor.rotation.x = -Math.PI / 2;
    this.planFloor.position.y = 0.007;
    this.planFloor.receiveShadow = true;
    this.planFloor.visible = false;
    world.add(this.planFloor);
  }

  #buildWalls() {
    const materials = [lambert(TONE.wallCap), lambert(TONE.wall)];
    for (const wall of WALLS) this.world.add(solid(ribbonOutline(worldPath(wall.d, 5), WALL_WIDTH), WALL_HEIGHT, 0, materials));

    // Central S3 enclosure with an abstract beacon: the activation format is undecided.
    const centre = planToWorld(RING.x, RING.y), radius = RING.r * PLAN.unit;
    this.world.add(solid(circlePoints(centre.x, centre.y, radius + WALL_WIDTH / 2, 72), WALL_HEIGHT, 0, materials, [circlePoints(centre.x, centre.y, radius - WALL_WIDTH / 2, 72)]));
    const zone = ZONES.find(item => item.id === 'S3');
    const glow = new THREE.Mesh(new THREE.CircleGeometry(radius - WALL_WIDTH / 2, 48), basic('#ffffff', {
      map: canvasTexture(128, 128, (ctx, w) => {
        const g = ctx.createRadialGradient(w / 2, w / 2, 4, w / 2, w / 2, w / 2);
        g.addColorStop(0, '#fff3ee'); g.addColorStop(0.55, '#f8cfd4'); g.addColorStop(1, '#e9a3b1');
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
      }),
    }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(centre.x, 0.014, centre.y);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, 1.3, 16), lambert(TONE.fixture));
    stem.position.set(centre.x, 0.65, centre.y);
    stem.castShadow = true;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), basic('#ffe3d6'));
    lamp.position.set(centre.x, 1.4, centre.y);
    this.halo = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.62, 0.02, 10, 72), basic(zone.deep));
    this.halo.rotation.x = Math.PI / 2;
    this.halo.position.set(centre.x, 1.4, centre.y);
    this.world.add(glow, stem, lamp, this.halo);
  }

  #buildFixtures() {
    const world = this.world;
    const neutral = lambert(TONE.fixture), shade = lambert(TONE.fixtureShade), gold = lambert(TONE.gold);
    const deep = id => ZONES.find(zone => zone.id === id).deep;
    const box = (w, h, d, material, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true; mesh.receiveShadow = true;
      return mesh;
    };
    const stand = fixture => {
      const group = new THREE.Group(), p = planToWorld(fixture.x, fixture.y);
      group.position.set(p.x, 0, p.y);
      group.rotation.y = faceRotation(fixture.face);
      world.add(group);
      return group;
    };

    // S4: game-station proxies. Local +z faces the player.
    const screen = basic('#bfeccd'), trim = lambert(deep('S4'));
    for (const station of FIXTURES.stations) {
      const group = stand(station);
      const display = box(0.56, 0.36, 0.035, screen, 0, 1.08, 0.02);
      display.rotation.x = -0.26;
      const bezel = box(0.62, 0.42, 0.03, trim, 0, 1.075, -0.008);
      bezel.rotation.x = -0.26;
      group.add(box(0.5, 0.84, 0.3, neutral, 0, 0.42, -0.04), box(0.54, 0.05, 0.24, trim, 0, 0.84, 0.1), bezel, display);
    }

    // S5: display-panel proxies, deliberately without artwork.
    const plate = lambert(deep('S5')), caption = lambert('#f1e6c4');
    for (const item of FIXTURES.displays) {
      const group = stand(item);
      group.add(box(0.8, 0.1, 0.3, shade, 0, 0.05, 0), box(0.7, 1.32, 0.06, neutral, 0, 0.76, 0));
      for (const side of [1, -1]) group.add(box(0.56, 0.78, 0.014, plate, 0, 0.9, side * 0.034), box(0.56, 0.1, 0.014, caption, 0, 0.36, side * 0.034));
    }

    // S2: recognition bays (2 + 2 + 1 positions each), timeline and process wall.
    const trophy = new THREE.CylinderGeometry(0.034, 0.02, 0.11, 12), cup = new THREE.SphereGeometry(0.038, 12, 10);
    for (const bay of FIXTURES.trophyBays) {
      const group = stand(bay);
      group.add(box(0.64, 0.45, 0.34, neutral, 0, 0.225, 0), box(0.64, 0.7, 0.22, neutral, 0, 0.35, -0.06), box(0.64, 0.95, 0.1, neutral, 0, 0.475, -0.12));
      for (const [x, y, z] of [[-0.16, 0.45, 0.11], [0.16, 0.45, 0.11], [-0.16, 0.7, 0], [0.16, 0.7, 0], [0, 0.95, -0.12]]) {
        const base = new THREE.Mesh(trophy, gold), top = new THREE.Mesh(cup, gold);
        base.position.set(x, y + 0.055, z); top.position.set(x, y + 0.13, z);
        base.castShadow = top.castShadow = true;
        group.add(base, top);
      }
    }
    const band = (points, material, y = 0.3, height = 0.62) => world.add(solid(ribbonOutline(points, 0.035, 2), height, y, material));
    band(offsetPolyline(worldPath(FIXTURES.timeline.d, 4), FIXTURES.timeline.offset), lambert(deep('S2')));
    const process = makePolyline(offsetPolyline(worldPath(FIXTURES.processWall.d, 4), FIXTURES.processWall.offset));
    ['#b9d9e6', '#8fc3d8', '#5d9fbd'].forEach((color, i) => {
      const from = process.length * (0.02 + i * 0.335), to = from + process.length * 0.29;
      band(Array.from({ length: 9 }, (_, k) => process.pointAt(from + (to - from) * k / 8)), lambert(color));
    });

    // S1 treats counter, S0 seat and the S0 / S1 rope line.
    const counter = makePolyline(worldPath(FIXTURES.treatsCounter.d, 4));
    world.add(solid(ribbonOutline(counter.points, 0.3), 0.82, 0, [lambert(TONE.woodTop), lambert(TONE.wood)]));
    for (const t of [0.22, 0.5, 0.78]) {
      const p = counter.pointAt(counter.length * t), dish = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.03, 20), gold);
      dish.position.set(p.x, 0.835, p.y);
      world.add(dish);
    }
    world.add(solid(ribbonOutline(worldPath(FIXTURES.seat.d, 4), 0.42), 0.42, 0, lambert(TONE.seat)));
    const table = planToWorld(FIXTURES.table.x, FIXTURES.table.y);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.04, 28), neutral), leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.09, 0.4, 12), shade);
    top.position.set(table.x, 0.42, table.y); leg.position.set(table.x, 0.2, table.y);
    top.castShadow = leg.castShadow = true;
    world.add(top, leg);
    const rope = lambert(TONE.rope), posts = FIXTURES.vipPosts.map(post => planToWorld(post.x, post.y));
    posts.forEach((p, i) => {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1, 12), gold), foot = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.03, 24), gold), cap = new THREE.Mesh(new THREE.SphereGeometry(0.042, 14, 10), gold);
      post.position.set(p.x, 0.5, p.y); foot.position.set(p.x, 0.015, p.y); cap.position.set(p.x, 1.02, p.y);
      post.castShadow = foot.castShadow = true;
      world.add(post, foot, cap);
      if (!i) return;
      const a = posts[i - 1], curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(a.x, 0.94, a.y), new THREE.Vector3((a.x + p.x) / 2, 0.62, (a.y + p.y) / 2), new THREE.Vector3(p.x, 0.94, p.y));
      const line = new THREE.Mesh(new THREE.TubeGeometry(curve, 18, 0.017, 8), rope);
      line.castShadow = true;
      world.add(line);
    });
  }

  #buildRoutes(routes) {
    // A feathered arrow tile; sliding its offset animates the direction of travel.
    this.dashTexture = canvasTexture(128, 32, ctx => {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(14, 4); ctx.lineTo(62, 4); ctx.lineTo(90, 16); ctx.lineTo(62, 28); ctx.lineTo(14, 28); ctx.lineTo(42, 16);
      ctx.closePath(); ctx.fill();
    });
    this.dashTexture.wrapS = THREE.RepeatWrapping;
    this.dashTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const flatOptions = { transparent: true, depthWrite: false, side: THREE.DoubleSide };
    const halo = basic('#fffdf8', { ...flatOptions, opacity: 0.62 });
    const nodeFill = basic('#fffdf8', { side: THREE.DoubleSide });
    const disc = new THREE.CircleGeometry(0.13, 32), ring = new THREE.RingGeometry(0.13, 0.19, 40), dot = new THREE.CircleGeometry(0.085, 24);
    this.routeGroup = new THREE.Group();
    this.scene.add(this.routeGroup);
    for (const route of routes) {
      const style = {
        color: route.color,
        body: lambert(route.color),
        ring: basic(route.color, { ...flatOptions, opacity: 0.92 }),
        pulse: basic(route.color, { ...flatOptions, opacity: 0.4 }),
        track: basic(route.color, { ...flatOptions, opacity: 0.3 }),
        dash: basic(route.color, { ...flatOptions, map: this.dashTexture }),
        group: new THREE.Group(),
      };
      const layer = (geometry, material, y, order) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.y = y; mesh.renderOrder = order;
        style.group.add(mesh);
        return mesh;
      };
      const marker = (geometry, material, point, order) => {
        const mesh = layer(geometry, material, 0.024, order);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(point.x, mesh.position.y, point.y);
      };
      route.legs.forEach((leg, i) => {
        const points = worldPath(leg.d, 3);
        layer(stripGeometry(points, 0.22), halo, 0.014, 1);
        layer(stripGeometry(points, 0.05), style.track, 0.017, 2);
        layer(stripGeometry(points, 0.1), style.dash, 0.02, 3);
        if (!i) marker(dot, style.ring, points[0], 4);
        if (!leg.exit && leg.dwell > 0) {
          marker(disc, nodeFill, points[points.length - 1], 4);
          marker(ring, style.ring, points[points.length - 1], 5);
        }
      });
      this.routeStyle.set(route.id, style);
      this.routeGroup.add(style.group);
    }
    this.figureGroup = new THREE.Group();
    this.scene.add(this.figureGroup);
  }

  #buildFigureAssets() {
    const leg = new THREE.CapsuleGeometry(0.062, 0.6, 4, 10), arm = new THREE.CapsuleGeometry(0.046, 0.42, 4, 8);
    leg.translate(0, -0.322, 0);
    arm.translate(0, -0.226, 0);
    const baseRing = new THREE.RingGeometry(0.2, 0.26, 36), pulseRing = new THREE.RingGeometry(0.3, 0.335, 40);
    baseRing.rotateX(-Math.PI / 2);
    pulseRing.rotateX(-Math.PI / 2);
    this.assets = {
      torso: new THREE.CapsuleGeometry(0.15, 0.34, 6, 16),
      head: new THREE.SphereGeometry(0.118, 22, 16),
      hair: new THREE.SphereGeometry(0.127, 22, 12, 0, TAU, 0, 1.72),
      foot: new THREE.SphereGeometry(0.07, 12, 8),
      leg, arm, baseRing, pulseRing,
      skin: TONE.skin.map(color => lambert(color)),
      hairTones: TONE.hair.map(color => lambert(color)),
      legTones: TONE.legs.map(color => lambert(color)),
      shoe: lambert(TONE.shoe),
    };
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.15, 20), basic(INK));
    this.marker.rotation.x = Math.PI;
    this.marker.visible = false;
    this.scene.add(this.marker);
  }

  #makeFigure(visitor) {
    const assets = this.assets, style = this.routeStyle.get(visitor.routeId);
    const cast = mesh => { mesh.castShadow = true; return mesh; };
    const root = new THREE.Group(), body = new THREE.Group(), head = new THREE.Group();
    root.userData.visitorId = visitor.id;
    const torso = cast(new THREE.Mesh(assets.torso, style.body));
    torso.position.y = 1.02;
    torso.scale.set(1.14, 1, 0.76);
    head.position.y = 1.5;
    const face = cast(new THREE.Mesh(assets.head, assets.skin[0])), hair = cast(new THREE.Mesh(assets.hair, assets.hairTones[0]));
    hair.rotation.x = -0.42;
    head.add(face, hair);
    const limb = (geometry, material, x, y, lean) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      pivot.rotation.z = lean;
      pivot.add(cast(new THREE.Mesh(geometry, material)));
      body.add(pivot);
      return pivot;
    };
    const legs = [limb(assets.leg, assets.legTones[0], 0.078, 0.72, 0), limb(assets.leg, assets.legTones[0], -0.078, 0.72, 0)];
    for (const pivot of legs) {
      const foot = new THREE.Mesh(assets.foot, assets.shoe);
      foot.position.set(0, -0.655, 0.045);
      foot.scale.set(0.9, 0.55, 1.55);
      pivot.add(foot);
    }
    const arms = [limb(assets.arm, style.body, 0.21, 1.27, 0.1), limb(assets.arm, style.body, -0.21, 1.27, -0.1)];
    body.add(torso, head);
    const ring = new THREE.Mesh(assets.baseRing, style.ring), pulse = new THREE.Mesh(assets.pulseRing, style.pulse);
    ring.position.y = 0.026; pulse.position.y = 0.028;
    ring.renderOrder = pulse.renderOrder = 6;
    root.add(body, ring, pulse);
    this.figureGroup.add(root);
    // A stable per-visitor offset keeps idle motion from moving in unison.
    const offset = [...visitor.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) * 1.7;
    return { root, body, head, face, hair, legs, arms, pulse, generation: -1, offset, height: 1 };
  }

  #syncFigures(snapshot, clock) {
    const assets = this.assets, present = new Set();
    for (const visitor of snapshot.visitors) {
      present.add(visitor.id);
      let figure = this.figures.get(visitor.id);
      if (!figure) { figure = this.#makeFigure(visitor); this.figures.set(visitor.id, figure); }
      figure.root.visible = visitor.visible;
      if (!visitor.visible) continue;
      if (figure.generation !== visitor.generation) {
        figure.generation = visitor.generation;
        const mix = (value, salt, count) => Math.floor((value * salt) % 1 * count);
        figure.face.material = assets.skin[mix(visitor.tone, 1, assets.skin.length)];
        figure.hair.material = assets.hairTones[mix(visitor.tone, 7.3, assets.hairTones.length)];
        const legTone = assets.legTones[mix(visitor.build, 5.7, assets.legTones.length)];
        for (const pivot of figure.legs) pivot.children[0].material = legTone;
        figure.height = 0.95 + visitor.build * 0.16;
      }
      const moving = smooth(visitor.speed / 0.55), swing = Math.sin(visitor.phase) * 0.62 * moving;
      const dwelling = visitor.state === 'dwelling', idle = clock * 1.3 + figure.offset;
      figure.root.position.set(visitor.x, 0, visitor.y);
      figure.root.rotation.y = Math.PI / 2 - visitor.heading;
      figure.root.scale.setScalar(Math.max(0.001, popIn(visitor.appear) * figure.height));
      figure.legs[0].rotation.x = swing; figure.legs[1].rotation.x = -swing;
      figure.arms[0].rotation.x = -swing * 0.8; figure.arms[1].rotation.x = swing * 0.8;
      figure.body.position.y = Math.abs(Math.cos(visitor.phase)) * 0.03 * moving;
      figure.body.rotation.x = 0.07 * moving;
      figure.body.rotation.z = dwelling ? Math.sin(idle) * 0.03 : 0;
      figure.head.rotation.y = dwelling ? Math.sin(idle * 0.7) * 0.32 : 0;
      figure.pulse.visible = dwelling;
      if (dwelling) figure.pulse.scale.setScalar(1.08 + Math.sin(clock * 3.2 + figure.offset) * 0.14);
    }
    for (const [id, figure] of this.figures) {
      if (present.has(id)) continue;
      this.figureGroup.remove(figure.root);
      this.figures.delete(id);
    }
  }

  #buildLabels() {
    this.labels = ZONES.map(zone => {
      const el = document.createElement('div'), p = planToWorld(zone.label.x, zone.label.y);
      el.className = 'flow-label';
      el.dataset.zone = zone.id;
      const swatch = document.createElement('i'), id = document.createElement('b'), name = document.createElement('span');
      swatch.style.background = zone.deep;
      id.textContent = zone.id;
      name.textContent = zone.name;
      el.append(swatch, id, name);
      this.labelHost.append(el);
      return { el, position: new THREE.Vector3(p.x, zone.label.h, p.y) };
    });
    const exitLabel = document.createElement('div'), exit = planToWorld(EXIT.x - 45, EXIT.y - 55);
    exitLabel.className = 'flow-label flow-exit-label';
    exitLabel.textContent = '← Exit';
    this.labelHost.append(exitLabel);
    this.labels.push({ el: exitLabel, position: new THREE.Vector3(exit.x, 0.15, exit.y) });
    this.projected = new THREE.Vector3();
  }

  #place({ theta, phi, radius, target }) {
    this.controls.target.copy(target);
    this.camera.position.setFromSphericalCoords(radius, phi, theta).add(target);
    this.camera.lookAt(target);
    this.dirty = true;
  }

  #current() {
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    return { theta: s.theta, phi: s.phi, radius: s.radius, target: this.controls.target.clone() };
  }

  // Closest framing (orbit distance and pivot) that keeps the whole booth clear of the stage's UI bands.
  #fit(view) {
    const { theta, phi } = VIEWS[view], probe = new THREE.PerspectiveCamera(this.camera.fov, this.width / this.height, 0.5, 400);
    const direction = new THREE.Vector3().setFromSphericalCoords(1, phi, theta), target = HOME_TARGET.clone(), point = new THREE.Vector3();
    const limitX = Math.max(0.25, 1 - 2 * this.pad.side / this.width), limitY = Math.max(0.25, (this.height - this.pad.top - this.pad.bottom) / this.height);
    const hw = PLAN.width * PLAN.unit / 2 + 0.1, hd = PLAN.height * PLAN.unit / 2 + 0.1;
    const left = planToWorld(EXIT.endX - 55, EXIT.y).x;
    const measure = radius => {
      probe.position.copy(target).addScaledVector(direction, radius);
      probe.lookAt(target);
      probe.updateMatrixWorld();
      const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (const x of [left, hw]) for (const y of [-0.14, 1.7]) for (const z of [-hd, hd]) {
        point.set(x, y, z).project(probe);
        box.minX = Math.min(box.minX, point.x); box.maxX = Math.max(box.maxX, point.x);
        box.minY = Math.min(box.minY, point.y); box.maxY = Math.max(box.maxY, point.y);
      }
      return box;
    };
    let radius = 30;
    // Alternate between sizing and re-centring: perspective makes the booth's outline lopsided.
    for (let pass = 0; pass < 3; pass += 1) {
      let near = 4, far = 200;
      for (let i = 0; i < 22; i += 1) {
        const mid = (near + far) / 2, box = measure(mid);
        if (box.maxX - box.minX <= 2 * limitX && box.maxY - box.minY <= 2 * limitY) far = mid; else near = mid;
      }
      radius = far;
      const box = measure(radius), halfHeight = radius * Math.tan(this.camera.fov * Math.PI / 360);
      target.addScaledVector(new THREE.Vector3().setFromMatrixColumn(probe.matrixWorld, 0), (box.minX + box.maxX) / 2 * halfHeight * probe.aspect)
        .addScaledVector(new THREE.Vector3().setFromMatrixColumn(probe.matrixWorld, 1), (box.minY + box.maxY) / 2 * halfHeight);
    }
    return { radius, target };
  }

  setSize(width, height, pad = {}) {
    if (!(width > 0 && height > 0)) return;
    this.width = width; this.height = height;
    this.pad = { top: pad.top ?? 64, bottom: pad.bottom ?? 96, side: pad.side ?? 56 };
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // Shift the picture so the booth sits between the route pills and the dock.
    this.camera.setViewOffset(width, height, 0, (this.pad.bottom - this.pad.top) / 2, width, height);
    this.home = { perspective: this.#fit('perspective'), plan: this.#fit('plan') };
    this.controls.maxDistance = Math.max(this.home.perspective.radius, this.home.plan.radius) * 1.6;
    if (this.tween) Object.assign(this.tween.to, this.followId ? { radius: this.#followRadius() } : this.home[this.view]);
    else if (!this.userMoved && !this.followId) this.#place({ ...VIEWS[this.view], ...this.home[this.view] });
    this.dirty = true;
  }

  #followRadius() {
    return Math.max(10, this.home[this.view].radius * 0.6);
  }

  setView(view, { immediate = false } = {}) {
    if (!VIEWS[view]) return;
    this.view = view;
    this.userMoved = false;
    // The plan is a fixed top view: dragging pans it instead of orbiting.
    const plan = view === 'plan';
    this.controls.enableRotate = !plan;
    this.controls.mouseButtons.LEFT = plan ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    this.controls.touches.ONE = plan ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    const to = this.followId
      ? { ...VIEWS[view], radius: this.#followRadius(), target: this.controls.target.clone() }
      : { ...VIEWS[view], radius: this.home[view].radius, target: this.home[view].target.clone() };
    if (immediate || this.reducedMotion) { this.tween = null; this.#place(to); return; }
    this.tween = { from: this.#current(), to, t: 0, duration: 0.95 };
  }

  setActiveRoutes(ids) {
    for (const [id, style] of this.routeStyle) style.group.visible = ids.includes(id);
    this.dirty = true;
  }

  setSourcePlan(show, onError) {
    if (show && !this.planFloor.material.map) {
      const texture = new THREE.TextureLoader().load(this.sourcePlanUrl, () => { this.dirty = true; }, undefined, () => {
        this.planFloor.material.map = null;
        texture.dispose();
        this.setSourcePlan(false);
        onError?.();
      });
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.planFloor.material.map = texture;
      this.planFloor.material.needsUpdate = true;
    }
    this.planFloor.visible = show;
    this.zoneFloors.visible = !show;
    this.dirty = true;
  }

  setFollow(id) {
    const was = this.followId;
    this.followId = id || null;
    if (this.followId && !was) { this.tween = null; this.followZoom = true; }
    if (!this.followId && was) { this.followZoom = false; this.marker.visible = false; this.setView(this.view); }
    this.dirty = true;
  }

  /** Visitor id under a canvas-relative point, or null. */
  pick(x, y) {
    this.raycaster.setFromCamera(new THREE.Vector2(x / this.width * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    for (const hit of this.raycaster.intersectObjects(this.figureGroup.children, true)) {
      let node = hit.object;
      while (node && !node.userData.visitorId) node = node.parent;
      // Raycasting ignores visibility, so skip figures that are waiting off-stage.
      if (node?.visible) return node.userData.visitorId;
    }
    return null;
  }

  /** Advances camera motion. Returns true when a redraw is needed. */
  step(dt) {
    if (this.tween) {
      const tween = this.tween;
      tween.t = Math.min(1, tween.t + dt / tween.duration);
      const e = smooth(tween.t), { from, to } = tween;
      this.#place({
        theta: from.theta + (((to.theta - from.theta + Math.PI * 3) % TAU) - Math.PI) * e,
        phi: from.phi + (to.phi - from.phi) * e,
        radius: from.radius + (to.radius - from.radius) * e,
        target: from.target.clone().lerp(to.target, e),
      });
      if (tween.t >= 1) this.tween = null;
    }
    const figure = this.followId ? this.figures.get(this.followId) : null;
    if (figure?.root.visible) {
      const target = this.controls.target, delta = new THREE.Vector3(figure.root.position.x, 0.6, figure.root.position.z).sub(target).multiplyScalar(1 - Math.exp(-dt * 5));
      target.add(delta);
      this.camera.position.add(delta);
      if (this.followZoom) {
        const offset = this.camera.position.clone().sub(target), goal = this.#followRadius();
        const radius = offset.length() + (goal - offset.length()) * (1 - Math.exp(-dt * 3));
        this.camera.position.copy(target).add(offset.setLength(radius));
        if (Math.abs(radius - goal) < 0.05) this.followZoom = false;
      }
      this.marker.visible = true;
      this.marker.position.set(figure.root.position.x, 1.98 * figure.height, figure.root.position.z);
      this.dirty = true;
    } else if (this.marker.visible) {
      this.marker.visible = false;
      this.dirty = true;
    }
    this.controls.update();
    return this.dirty;
  }

  /** Applies a simulation snapshot. `clock` is simulation time, so it freezes on pause. */
  update(snapshot, clock) {
    this.#syncFigures(snapshot, clock);
    this.dashTexture.offset.x = -((clock * 0.9 / DASH_PERIOD) % 1);
    const pausedAtCentre = snapshot.visitors.reduce((count, visitor) => count + (visitor.at === 'S3' ? 1 : 0), 0);
    this.halo.scale.setScalar(1 + Math.sin(clock * 1.6) * 0.035 + Math.min(4, pausedAtCentre) * 0.045);
    this.halo.position.y = 1.4 + Math.sin(clock * 1.6) * 0.03;
    this.dirty = true;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    for (const label of this.labels) {
      const p = this.projected.copy(label.position).project(this.camera);
      const visible = p.z > -1 && p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
      label.el.hidden = !visible;
      if (visible) label.el.style.transform = `translate(${Math.round((p.x + 1) / 2 * this.width)}px,${Math.round((1 - p.y) / 2 * this.height)}px) translate(-50%,-50%)`;
    }
    this.dirty = false;
  }

  dispose() {
    this.controls.removeEventListener('start', this.onControlStart);
    this.controls.removeEventListener('change', this.onControlChange);
    this.controls.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    const release = object => {
      object.geometry?.dispose();
      for (const material of [].concat(object.material ?? [])) { material.map?.dispose(); material.dispose(); }
    };
    this.scene.traverse(release);
    for (const value of Object.values(this.assets)) for (const item of [].concat(value)) item.dispose?.();
    for (const style of this.routeStyle.values()) for (const item of Object.values(style)) item.dispose?.();
    this.dashTexture.dispose();
    this.renderer.dispose();
    // Each visit to the step builds a fresh renderer, so release the GL context now.
    this.renderer.forceContextLoss();
    this.canvas.remove();
    for (const label of this.labels) label.el.remove();
    this.figures.clear();
  }
}
