import * as THREE from 'three';

// Web-only material refinement for the studio render. The GLB exporter flattens
// every finish to metalness 0, so known finishes are restored here by exact
// material name. Geometry, base colours, alpha and source textures are never
// modified; unidentified names are left exactly as exported.

const PREFIX = /^WEB \| /;
const FLOOR_NAME = 'Oak Wood2';
const ARTWORK = /\| art |^Timeline \| (blue|sepia) \|/;

// Exact names of mapped artwork confirmed to be displays (satin glass).
// Empty on purpose: the inventory does not say which artwork is a screen.
const SCREEN_NAMES = new Set([]);

const DEFAULTS = {
  floorRepeat: 6,
  floorRotation: 0,
  floorBumpScale: 0.0006,
  stoneBumpScale: 0.006,
  earthBumpScale: 0.002,
  screenRoughness: 0.34,
};

const FINISHES = new Map([
  // Brass / champagne trim
  ['INTERIOR | satin brass', { metalness: 0.86, roughness: 0.32 }],
  ['S2 PROCESS | satin champagne', { metalness: 0.84, roughness: 0.34 }],
  ['Timeline | champagne edge trim', { metalness: 0.82, roughness: 0.36 }],
  // Dark housing and paint
  ['AV housing - graphite', { roughness: 0.55 }],
  ['S2 PROCESS | display bezel', { roughness: 0.5 }],
  ['EXTERIOR Jeddah | muted painted timber', { roughness: 0.64 }],
  ['EXTERIOR Rijal | muted painted timber', { roughness: 0.64 }],
  // Plaster, earth and stone
  ['INTERIOR | sandstone relief', { roughness: 0.88 }],
  ['INTERIOR | chalk plaster', { roughness: 0.9 }],
  ['S2 PROCESS | cream plaster', { roughness: 0.9 }],
  ['Timeline | warm mineral plaster', { roughness: 0.9 }],
  ['BASE | Plain warm white plaster', { roughness: 0.88 }],
  ['EXTERIOR Diriyah | rounded earthen edge', { roughness: 0.92 }],
  ['EXTERIOR Jeddah | lime and quartz', { roughness: 0.9 }],
  ['EXTERIOR Rijal | lime and quartz', { roughness: 0.9 }],
  ['EXTERIOR Rijal | dark stone coping', { roughness: 0.92 }],
  // Facade albedo doubles as a subtle bump; it is not a measured height map.
  ['EXTERIOR Diriyah | generated wall albedo', { roughness: 0.92, bump: 'earth' }],
  ['EXTERIOR Jeddah | generated wall albedo', { roughness: 0.9, bump: 'earth' }],
  ['EXTERIOR Rijal | generated wall albedo', { roughness: 0.92, bump: 'stone' }],
  // Timber
  ['EXTERIOR Diriyah | aged timber', { roughness: 0.7 }],
  ['EXTERIOR Jeddah | aged timber', { roughness: 0.7 }],
  ['EXTERIOR Rijal | aged timber', { roughness: 0.7 }],
  ['EXTERIOR Jeddah | timber carved edge', { roughness: 0.64 }],
  [FLOOR_NAME, { roughness: 0.6 }],
]);

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

// Light, near-neutral plank grain that tiles in both axes. It multiplies the
// floor's existing base colour, so it stays close to white.
function makeOakGrainCanvas(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(0x0a4b27);
  const planks = 4;
  const plankHeight = size / planks;

  for (let p = 0; p < planks; p++) {
    const tone = 234 + Math.floor(rand() * 16);
    ctx.fillStyle = `rgb(${tone},${tone - 3},${tone - 8})`;
    ctx.fillRect(0, p * plankHeight, size, plankHeight);
  }

  for (let i = 0; i < 260; i++) {
    const y = rand() * size;
    const amplitude = 0.6 + rand() * 2.2;
    const cycles = 1 + Math.floor(rand() * 3); // whole cycles keep X seamless
    const phase = rand() * Math.PI * 2;
    ctx.strokeStyle = rand() < 0.75
      ? `rgba(96,72,48,${0.04 + rand() * 0.07})`
      : `rgba(255,250,240,${0.05 + rand() * 0.06})`;
    ctx.lineWidth = 0.6 + rand() * 1.4;
    for (const wrap of [-size, 0, size]) {
      ctx.beginPath();
      for (let x = 0; x <= size; x += 8) {
        const yy = y + wrap + Math.sin((x / size) * Math.PI * 2 * cycles + phase) * amplitude;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
  }

  ctx.fillStyle = 'rgba(60,42,28,0.22)';
  for (let p = 0; p < planks; p++) {
    ctx.fillRect(0, p * plankHeight, size, 1.5);
    ctx.fillRect(Math.floor(rand() * size), p * plankHeight, 1.5, plankHeight);
  }
  return canvas;
}

export class StudioMaterials {
  constructor(renderer, options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this._anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
    this._seen = new WeakSet();
    this._restores = [];
    this._textures = [];
    this._floor = undefined;
  }

  prepare(root) {
    if (!root) return;
    root.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) this._prepareMaterial(material);
    });
  }

  dispose() {
    for (const { material, original } of this._restores) {
      Object.assign(material, original);
      material.needsUpdate = true;
    }
    for (const texture of this._textures) texture.dispose();
    this._restores = [];
    this._textures = [];
    this._seen = new WeakSet();
    this._floor = undefined;
  }

  _prepareMaterial(material) {
    if (!material || !material.isMeshStandardMaterial || this._seen.has(material)) return;
    this._seen.add(material);
    // Already physically metallic (e.g. the VIP gold overrides): leave untouched.
    if (material.metalness > 0.5) return;

    const name = (material.name || '').replace(PREFIX, '');
    const finish = FINISHES.get(name);
    const props = {};

    if (finish) {
      if (finish.metalness !== undefined) props.metalness = finish.metalness;
      if (finish.roughness !== undefined) props.roughness = finish.roughness;
      if (finish.bump && material.map && !material.bumpMap && !material.normalMap) {
        props.bumpMap = this._bumpCopy(material.map);
        props.bumpScale = finish.bump === 'stone'
          ? this.options.stoneBumpScale
          : this.options.earthBumpScale;
      }
    }

    if (name === FLOOR_NAME && !material.map) {
      const floor = this._floorTextures();
      if (floor) {
        props.map = floor.map;
        if (!material.bumpMap && !material.normalMap) {
          props.bumpMap = floor.bump;
          props.bumpScale = this.options.floorBumpScale;
        }
      }
    }

    // Constant emission washes artwork out; make it follow the art instead.
    // Emissive colour and intensity are preserved as exported.
    if (ARTWORK.test(name) && material.map && !material.emissiveMap) {
      const { r, g, b } = material.emissive;
      if (r + g + b > 0 && material.emissiveIntensity > 0) props.emissiveMap = material.map;
      if (SCREEN_NAMES.has(name)) props.roughness = this.options.screenRoughness;
    }

    if (Object.keys(props).length === 0) return;
    const original = {};
    for (const key of Object.keys(props)) original[key] = material[key];
    Object.assign(material, props);
    material.needsUpdate = true;
    this._restores.push({ material, original });
  }

  // Tracked copy sharing the source image; the source texture's colour space
  // and pixels are not touched.
  _bumpCopy(source) {
    const bump = source.clone();
    bump.colorSpace = THREE.NoColorSpace;
    bump.needsUpdate = true;
    this._textures.push(bump);
    return bump;
  }

  _floorTextures() {
    if (this._floor !== undefined) return this._floor;
    this._floor = null;
    if (typeof document === 'undefined') return null;
    const map = new THREE.CanvasTexture(makeOakGrainCanvas());
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.setScalar(this.options.floorRepeat);
    map.rotation = this.options.floorRotation;
    map.anisotropy = this._anisotropy;
    this._textures.push(map);
    this._floor = { map, bump: this._bumpCopy(map) };
    return this._floor;
  }
}
