import { Rng, type Obstacle, type Shape, type WorldMap } from '@rune/shared';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  RingGeometry,
  Shape as ThreeShape,
  SRGBColorSpace,
  TorusGeometry,
  type Texture,
} from 'three';
import { COLORS } from './config.js';
import { mat } from './models.js';
import { withOccluderFade } from './occluderFade.js';
import { staticFlicker, type StaticLight } from './lights.js';
import { PropBatch } from './propBatch.js';
import { treeGeometry, type TreeKind } from './trees.js';
import type { FireKind, FireSpot } from './vfx/worldFires.js';

export interface BuiltWorld {
  group: Group;
  /** Per-frame animation: water, portals, fires, canopy fading around the player. */
  update(t: number, playerX: number, playerY: number): void;
  /** Stops pending asset loads from adding meshes to a world that has been replaced. */
  dispose(): void;
  /** Torches, lanterns, fires, portals and waypoints, for the scene's light budget. */
  lights: readonly StaticLight[];
  /** Every flame in the world, drawn by the effects system (`vfx/worldFires.ts`). */
  fires: readonly FireSpot[];
}

type LightLook = Omit<StaticLight, 'x' | 'y'>;
/** Warm flame colours; heights are where the flame sits, so the pool centres under it. */
const TORCH: LightLook = { height: 56, color: 0xff9a4a, intensity: 3, radius: 400, flicker: 0.1, priority: 0, day: 0 };
const LANTERN: LightLook = { height: 64, color: 0xffb060, intensity: 2.8, radius: 340, flicker: 0.05, priority: 0, day: 0 };
const CANDLE: LightLook = { height: 14, color: 0xffb060, intensity: 0.9, radius: 170, flicker: 0.12, priority: 0, day: 0 };
const FIRE: LightLook = { height: 40, color: 0xff9040, intensity: 3.2, radius: 520, flicker: 0.12, priority: 0, day: 0 };

/** Decor that is itself a flame or a lamp, and the light it casts, per unit of scale. */
const LIT_DECOR: Record<string, LightLook> = {
  dungeon_torch_lit: TORCH,
  dungeon_candle_lit: CANDLE,
  grave_lantern_standing: { ...LANTERN, height: 38, intensity: 1.4, radius: 300 },
  grave_post_lantern: LANTERN,
  grave_shrine_candles: { ...CANDLE, height: 30, intensity: 1.2, radius: 220 },
};

/** Whether a decor asset is a lamp or flame, for the town editor's layer groups. */
export function isLitDecor(asset: string): boolean {
  return Object.hasOwn(LIT_DECOR, asset);
}

function lightAt(look: LightLook, x: number, y: number, scale = 1): StaticLight {
  return { ...look, x, y, height: look.height * scale, radius: look.radius * Math.sqrt(scale) };
}

/** A flame on a lit asset, in world units at scale 1 of the placed model (x and z before its turn). */
interface FlameAt {
  kind: FireKind;
  x: number;
  h: number;
  z: number;
  size: number;
  /** Toward the camera, past the glass of a lantern. */
  pull: number;
}

/**
 * Where the flames sit on each lit asset, measured from the KayKit meshes: the torch bowl's rim,
 * the candle wicks and the lantern glass. The models' own baked flames are cut out when they are
 * batched (`BAKED_FLAMES` in propBatch.ts), so these replace them.
 */
const FLAMES: Record<string, readonly FlameAt[]> = {
  dungeon_torch_lit: [{ kind: 'torch', x: 0, h: 40, z: 0, size: 1, pull: 0 }],
  dungeon_candle_lit: [{ kind: 'candle', x: 0, h: 8, z: 0, size: 1, pull: 0 }],
  grave_lantern_standing: [{ kind: 'lantern', x: 0, h: 9, z: 0, size: 1, pull: 16 }],
  grave_post_lantern: [{ kind: 'lantern', x: 0, h: 40.5, z: 21.2, size: 0.6, pull: 12 }],
  grave_shrine_candles: [
    { kind: 'candle', x: -1.4, h: 46.9, z: 0.75, size: 0.9, pull: 0 },
    { kind: 'candle', x: 0.7, h: 49.9, z: -2.9, size: 0.9, pull: 0 },
    { kind: 'candle', x: 2.7, h: 45.7, z: -0.3, size: 0.9, pull: 0 },
    { kind: 'candle', x: -2.5, h: 33.2, z: 8.8, size: 0.9, pull: 0 },
  ],
};

/** The flames of one placed lit asset, turned and scaled like the model; `light` is the lamp's light, for a shared flicker. */
function flamesOf(asset: string, x: number, y: number, angle: number, scale: number, light: StaticLight | null, out: FireSpot[]): void {
  const list = FLAMES[asset];
  if (!list) return;
  // PropBatch turns models by -angle about the vertical.
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  for (const f of list) {
    out.push({
      kind: f.kind,
      x: x + (f.x * c + f.z * s) * scale,
      y: y + (-f.x * s + f.z * c) * scale,
      h: f.h * scale,
      size: f.size * scale,
      pull: f.pull * scale,
      lightX: light?.x ?? x,
      lightY: light?.y ?? y,
      flicker: light?.flicker ?? 0.1,
      forge: false,
    });
  }
}

const dummy = new Object3D();

// ---------------------------------------------------------------------------------------------
// Procedural textures

function canvas(size: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D | null } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return { c, g: c.getContext('2d') };
}

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function repeatTexture(c: HTMLCanvasElement, repeatX: number, repeatY: number): Texture {
  const tex = new CanvasTexture(c);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Grass and dirt noise; tinted per map by the material colour. */
function grassCanvas(): HTMLCanvasElement {
  const { c, g } = canvas(512);
  if (!g) return c;
  const rand = lcg(4242);
  g.fillStyle = '#c4c4b0';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 150 + Math.floor(rand() * 80);
    g.fillStyle = `rgba(${v}, ${v + 10}, ${v - 20}, ${0.12 + rand() * 0.2})`;
    const s = 1 + rand() * 4;
    g.fillRect(rand() * 512, rand() * 512, s, s);
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(90, 70, 50, ${0.02 + rand() * 0.03})`;
    g.beginPath();
    g.arc(rand() * 512, rand() * 512, 20 + rand() * 50, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

function stoneCanvas(): HTMLCanvasElement {
  const { c, g } = canvas(512);
  if (!g) return c;
  const rand = lcg(1234567);
  const tiles = 8;
  const t = 512 / tiles;
  g.fillStyle = '#2a2620';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const shade = 88 + Math.floor(rand() * 34);
      g.fillStyle = `rgb(${shade + 6}, ${shade}, ${shade - 10})`;
      const off = j % 2 === 0 ? 0 : t / 2;
      g.fillRect(((i * t + off) % 512) + 2, j * t + 2, t - 4, t - 4);
    }
  }
  return c;
}

function dirtCanvas(): HTMLCanvasElement {
  const { c, g } = canvas(256);
  if (!g) return c;
  const rand = lcg(99);
  g.fillStyle = '#7a6448';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3000; i++) {
    const v = 90 + Math.floor(rand() * 60);
    g.fillStyle = `rgba(${v + 20}, ${v}, ${v - 25}, 0.35)`;
    g.fillRect(rand() * 256, rand() * 256, 1 + rand() * 3, 1 + rand() * 3);
  }
  return c;
}

function waterCanvas(): HTMLCanvasElement {
  const { c, g } = canvas(256);
  if (!g) return c;
  const rand = lcg(7);
  g.fillStyle = '#1d4a6a';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = `rgba(160, 210, 255, ${0.15 + rand() * 0.2})`;
    g.lineWidth = 1 + rand() * 2;
    g.beginPath();
    const x = rand() * 256;
    const y = rand() * 256;
    g.moveTo(x, y);
    g.quadraticCurveTo(x + 20, y + (rand() - 0.5) * 10, x + 40 + rand() * 30, y);
    g.stroke();
  }
  return c;
}

function swirlCanvas(): HTMLCanvasElement {
  const { c, g } = canvas(256);
  if (!g) return c;
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(120,160,255,0.8)');
  grad.addColorStop(1, 'rgba(40,20,120,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.lineWidth = 6;
  for (let arm = 0; arm < 4; arm++) {
    g.beginPath();
    for (let k = 0; k < 60; k++) {
      const a = arm * (Math.PI / 2) + k * 0.12;
      const r = k * 2;
      const x = 128 + Math.cos(a) * r;
      const y = 128 + Math.sin(a) * r;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

/** A flat ribbon following a path, for rivers, banks and roads. */
function ribbon(path: { x: number; y: number }[], width: number, height: number, uvScale: number): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let dist = 0;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    if (!p || !prev || !next) continue;
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    if (i > 0 && prev) dist += Math.hypot(p.x - prev.x, p.y - prev.y);
    pos.push(p.x + nx * width, height, p.y + ny * width, p.x - nx * width, height, p.y - ny * width);
    uv.push(0, dist / uvScale, 1, dist / uvScale);
    if (i < path.length - 1) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Deterministically lumpy icosahedron, so rocks are not perfect spheres. */
function rockGeometry(seed: number): BufferGeometry {
  const geo = new IcosahedronGeometry(1, 1);
  const rand = lcg(seed);
  const p = geo.getAttribute('position');
  const seen = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let k = seen.get(key);
    if (k === undefined) {
      k = 0.75 + rand() * 0.45;
      seen.set(key, k);
    }
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.8, p.getZ(i) * k);
  }
  geo.computeVertexNormals();
  return geo;
}

function hash(x: number, y: number): number {
  return Math.abs(Math.floor(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453)) % 1000;
}

function instanced(geo: BufferGeometry, material: MeshStandardMaterial, transforms: Matrix4[], colors?: Color[]): InstancedMesh | null {
  if (transforms.length === 0) return null;
  const m = new InstancedMesh(geo, material, transforms.length);
  transforms.forEach((t, i) => {
    m.setMatrixAt(i, t);
    const c = colors?.[i];
    if (c) m.setColorAt(i, c);
  });
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function matrix(x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0, rotX = 0, rotZ = 0): Matrix4 {
  dummy.position.set(x, y, z);
  dummy.rotation.set(rotX, rotY, rotZ);
  dummy.scale.set(sx, sy, sz);
  dummy.updateMatrix();
  return dummy.matrix.clone();
}

function shapeCentre(s: Shape): { x: number; y: number } {
  if (s.type === 'capsule') return { x: (s.ax + s.bx) / 2, y: (s.ay + s.by) / 2 };
  return { x: s.x, y: s.y };
}

// ---------------------------------------------------------------------------------------------
// Builders

export function buildWorld(def: WorldMap): BuiltWorld {
  const group = new Group();
  const animated: ((t: number, px: number, py: number) => void)[] = [];
  const disposers: (() => void)[] = [];
  const lights: StaticLight[] = [];
  const fires: FireSpot[] = [];
  const { width, height } = def;

  // The Arena pit is an underground colosseum carved like a dungeon, lit the same way by torches.
  const underground = def.theme === 'dungeon' || def.theme === 'staging' || def.theme === 'arena';
  // Outdoors the grass runs on under the border forest, so the camera never looks past it into the void.
  const margin = underground ? 0 : BORDER_DEPTH;
  const gw = width + margin * 2;
  const gh = height + margin * 2;
  // Ground. Underground it is the rock itself: near black, with the carved floor laid on top.
  const groundMat = underground
    ? new MeshStandardMaterial({ color: 0x0c0a09, roughness: 1 })
    : new MeshStandardMaterial({ map: repeatTexture(grassCanvas(), gw / 420, gh / 420), color: def.groundTint, roughness: 1 });
  const ground = new Mesh(new PlaneGeometry(gw, gh), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(width / 2, 0, height / 2);
  ground.receiveShadow = true;
  group.add(ground);
  const voidPlane = new Mesh(new PlaneGeometry(gw * 3, gh * 3), new MeshBasicMaterial({ color: COLORS.background }));
  voidPlane.rotation.x = -Math.PI / 2;
  voidPlane.position.set(width / 2, -3, height / 2);
  group.add(voidPlane);

  const stoneTex = repeatTexture(stoneCanvas(), 1, 1);
  const dirtTex = repeatTexture(dirtCanvas(), 1, 1);
  if (underground) addUnderground(group, def);
  for (const patch of def.ground) {
    if (patch.kind === 'floor') continue;
    const s = patch.shape;
    if (s.type === 'circle') {
      const tex = (patch.kind === 'plaza' ? stoneTex : dirtTex).clone();
      tex.repeat.set(s.r / 90, s.r / 90);
      const m = new Mesh(new CircleGeometry(s.r, 48), new MeshStandardMaterial({ map: tex, roughness: 0.95 }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(s.x, 0.4 + (patch.kind === 'plaza' ? 0.2 : 0), s.y);
      m.receiveShadow = true;
      group.add(m);
    } else if (s.type === 'capsule') {
      const geo = ribbon(
        [
          { x: s.ax, y: s.ay },
          { x: s.bx, y: s.by },
        ],
        s.r,
        0.3,
        120,
      );
      const tex = dirtTex.clone();
      const m = new Mesh(geo, new MeshStandardMaterial({ map: tex, roughness: 1, transparent: true, opacity: 0.85 }));
      m.receiveShadow = true;
      group.add(m);
      const cap = new Mesh(new CircleGeometry(s.r, 20), m.material);
      cap.rotation.x = -Math.PI / 2;
      cap.position.set(s.bx, 0.3, s.by);
      group.add(cap);
    }
  }

  // Rivers: a muddy bank ribbon under a translucent, flowing water ribbon.
  const waterTex = repeatTexture(waterCanvas(), 1, 1);
  for (const river of def.rivers) {
    const bank = new Mesh(ribbon(river.path, river.width / 2 + 16, 0.5, 200), new MeshStandardMaterial({ color: 0x3a3022, roughness: 1 }));
    bank.receiveShadow = true;
    const waterMat = new MeshStandardMaterial({ map: waterTex, color: 0x9fd0ff, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.88 });
    const water = new Mesh(ribbon(river.path, river.width / 2 + 2, 1.2, 160), waterMat);
    group.add(bank, water);
    animated.push((t) => {
      waterTex.offset.y = -t * 0.35;
    });
  }
  for (const b of def.bridges) group.add(bridge(b.x, b.y, b.angle, b.length, b.width));

  // Obstacles, grouped by kind so the common ones can be instanced.
  const byKind = new Map<string, Obstacle[]>();
  for (const o of def.obstacles) byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), o]);

  const batch = new PropBatch();
  addRocks(batch, byKind.get('rock') ?? []);
  animated.push(addTrees(group, byKind.get('tree') ?? [], def));
  for (const o of byKind.get('pillar') ?? []) {
    if (o.shape.type !== 'circle') continue;
    const h = hash(o.shape.x, o.shape.y);
    batch.add(h % 3 === 0 ? 'dungeon_column' : h % 3 === 1 ? 'dungeon_pillar' : 'dungeon_pillar_decorated', { x: o.shape.x, y: o.shape.y, angle: h, fit: { height: o.visual + 12 }, fade: true });
    if (o.visual < 90) batch.add('dungeon_rubble_half', { x: o.shape.x + o.shape.r * 1.6, y: o.shape.y + o.shape.r * 0.5, angle: h, fit: { radius: 16 } });
  }
  for (const w of byKind.get('wall') ?? []) tileAlong(batch, w, 'dungeon_wall_broken', 70, true);
  for (const f of byKind.get('fence') ?? []) tileAlong(batch, f, 'fence_wood_straight', 44);
  const BUILDINGS = ['building_home_A_red', 'building_home_B_red', 'building_home_A_blue', 'building_home_B_yellow', 'building_tavern_red', 'building_blacksmith_blue'];
  for (const h of byKind.get('house') ?? []) {
    if (h.shape.type !== 'box') continue;
    const k = hash(h.shape.x, h.shape.y);
    const small = Math.max(h.shape.hw, h.shape.hh) < 100;
    const id = small ? (k % 2 === 0 ? 'building_home_B_red' : 'building_home_B_yellow') : (BUILDINGS[k % BUILDINGS.length] ?? 'building_home_A_red');
    batch.add(id, { x: h.shape.x, y: h.shape.y, angle: h.shape.angle, fit: { box: { w: h.shape.hw * 2.3, d: h.shape.hh * 2.3 } }, fade: true });
  }
  for (const s of byKind.get('stall') ?? []) group.add(stall(s));
  for (const w of byKind.get('well') ?? []) if (w.shape.type === 'circle') batch.add('building_well_blue', { x: w.shape.x, y: w.shape.y, angle: 0, fit: { radius: w.shape.r * 1.5 } });
  for (const c of byKind.get('chest') ?? []) if (c.shape.type === 'box') batch.add('dungeon_chest', { x: c.shape.x, y: c.shape.y, angle: c.shape.angle, fit: { box: { w: c.shape.hw * 2.2, d: c.shape.hh * 2.2 } } });
  for (const c of byKind.get('crate') ?? []) if (c.shape.type === 'box') batch.add('dungeon_crates_stacked', { x: c.shape.x, y: c.shape.y, angle: c.shape.angle, fit: { box: { w: c.shape.hw * 2.4, d: c.shape.hh * 2.4 } } });
  for (const d of def.decor) {
    batch.add(d.asset, { x: d.x, y: d.y, angle: d.angle, fit: { scale: d.scale } });
    const look = LIT_DECOR[d.asset];
    const light = look ? lightAt(look, d.x, d.y, d.scale) : null;
    if (light) lights.push(light);
    flamesOf(d.asset, d.x, d.y, d.angle, d.scale, light, fires);
  }
  for (const l of def.lamps ?? []) {
    const asset = underground ? 'dungeon_torch_lit' : 'grave_post_lantern';
    batch.add(asset, { x: l.x, y: l.y, angle: 0, fit: { height: underground ? 50 : 80 } });
    const light = lightAt(underground ? TORCH : LANTERN, l.x, l.y);
    lights.push(light);
    // The asset heights are 50 (torch) and 70 (post lantern); lamps are fitted to 50 and 80.
    flamesOf(asset, l.x, l.y, 0, underground ? 1 : 80 / 70, light, fires);
  }
  if (!underground) addBorder(group, batch, def);
  let cancelled = false;
  void batch.build(group, () => cancelled);
  disposers.push(() => {
    cancelled = true;
  });

  const PORTAL_COLORS = { town: 0x6bb6ff, arena: 0xff7a3a, wilds: 0xb49cff, staging: 0xd04a3a, dungeon: 0xffb347, zone: 0x8fe07a, waypoint: 0x5ff0e0 } as const;
  for (const p of def.portals) {
    // Zone exits are walk-through gates (an arch and lanterns from the map's decor), not portals.
    if (p.target === 'zone') continue;
    // In town the way to the Arena is a building, walked into; elsewhere 'arena' is still a portal.
    const arenaEntrance = p.target === 'arena' && (def.theme === 'town' || !!def.safeZones?.length);
    const built = p.target === 'waypoint' ? waypoint(p.x, p.y, p.r) : arenaEntrance ? arenaBuilding(p.x, p.y, p.r) : portal(p.x, p.y, p.r, PORTAL_COLORS[p.target]);
    group.add(built.group);
    animated.push(built.update);
    lights.push(...built.lights);
    fires.push(...built.fires);
  }
  // The forge's fire, beside its weapon rack, so the spot reads as a smithy at night too.
  if (def.forge) {
    const forgeFire = campfire(def.forge.x + 38, def.forge.y + 22, true);
    group.add(forgeFire.group);
    animated.push(forgeFire.update);
    lights.push(forgeFire.light);
    fires.push(forgeFire.fire);
  }
  // Zones with a town arrive in the town; only a bare Wilds gets a camp with a fire.
  if (def.theme === 'wilds' && !def.safeZones?.length) {
    const fire = campfire(def.spawn.x + 40, def.spawn.y + 60, false);
    group.add(fire.group);
    animated.push(fire.update);
    lights.push(fire.light);
    fires.push(fire.fire);
  }
  if (!underground) addDecor(group, def);

  return {
    group,
    update(t, px, py) {
      for (const a of animated) a(t, px, py);
    },
    dispose() {
      for (const d of disposers) d();
    },
    lights,
    fires,
  };
}

interface Landmark {
  group: Group;
  update: (t: number) => void;
  lights: StaticLight[];
  fires: FireSpot[];
}

const ROCKS = ['rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E'];

function addRocks(batch: PropBatch, rocks: Obstacle[]): void {
  for (const o of rocks) {
    if (o.shape.type !== 'circle') continue;
    const h = hash(o.shape.x, o.shape.y);
    batch.add(ROCKS[h % ROCKS.length] ?? 'rock_single_A', { x: o.shape.x, y: o.shape.y, angle: h / 160, fit: { radius: o.shape.r * 1.15 } });
  }
}

/** Repeats a straight segment asset along a capsule obstacle (walls, fences). */
function tileAlong(batch: PropBatch, o: Obstacle, asset: string, segment: number, fade = false): void {
  if (o.shape.type !== 'capsule') return;
  const { ax, ay, bx, by } = o.shape;
  const len = Math.hypot(bx - ax, by - ay);
  const n = Math.max(1, Math.round(len / segment));
  const angle = Math.atan2(by - ay, bx - ax);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    batch.add(asset, { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, angle, fit: { length: len / n + 2 }, fade });
  }
}

/**
 * Procedural trees, one merged mesh each. Trees near the player fade out, so nobody fights hidden
 * under a canopy. Map themes shift the mix toward dead trees in bleak places.
 */
function addTrees(group: Group, trees: Obstacle[], def: WorldMap): (t: number, px: number, py: number) => void {
  const fading: { x: number; y: number; mat: MeshStandardMaterial }[] = [];
  const bleak = /Ashen|Gloom/.test(def.name);
  for (const o of trees) {
    if (o.shape.type !== 'circle') continue;
    const { x, y } = o.shape;
    const h = hash(x, y);
    const isOak = def.oaks ? def.oaks.some((p) => Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5) : h % 3 === 0;
    const kind: TreeKind = !def.oaks && h % 100 < (bleak ? 35 : 7) ? 'dead' : isOak ? 'oak' : 'pine';
    const material = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, transparent: true, opacity: 1 });
    const mesh = new Mesh(treeGeometry(kind, h), material);
    const size = o.visual * (kind === 'pine' ? 1.05 : 1.25);
    mesh.scale.setScalar(size);
    mesh.position.set(x, 0, y);
    mesh.rotation.y = h;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (kind !== 'dead') fading.push({ x, y, mat: material });
  }
  return (_t, px, py) => {
    for (const c of fading) {
      const target = Math.hypot(c.x - px, c.y - py) < 110 ? 0.3 : 1;
      c.mat.opacity += (target - c.mat.opacity) * 0.15;
      c.mat.depthWrite = c.mat.opacity > 0.95;
    }
  };
}

function addPillars(group: Group, pillars: Obstacle[]): void {
  const shafts: Matrix4[] = [];
  const bases: Matrix4[] = [];
  const caps: Matrix4[] = [];
  const rubble: Matrix4[] = [];
  for (const o of pillars) {
    if (o.shape.type !== 'circle') continue;
    const { x, y, r } = o.shape;
    const h = o.visual;
    const k = hash(x, y);
    bases.push(matrix(x, 6, y, r * 2.4, 12, r * 2.4));
    shafts.push(matrix(x, 12 + h / 2, y, r * 0.85, h, r * 0.85, k));
    // Tall pillars keep their capital; short ones are broken and leave rubble beside them.
    if (h > 90) caps.push(matrix(x, 12 + h + 5, y, r * 2.1, 10, r * 2.1));
    else rubble.push(matrix(x + r * 1.6, 5, y + r * 0.6, 12, 10, 16, k, 0.4));
  }
  const stone = mat(0xb8b0a0, { rough: 0.85 });
  for (const [geo, list] of [
    [new CylinderGeometry(1, 1, 1, 12), shafts],
    [new BoxGeometry(1, 1, 1), bases],
    [new BoxGeometry(1, 1, 1), caps],
    [new BoxGeometry(1, 1, 1), rubble],
  ] as const) {
    const m = instanced(geo, stone, list);
    if (m) group.add(m);
  }
}

function stoneWall(o: Obstacle): Group {
  const g = new Group();
  if (o.shape.type !== 'capsule') return g;
  const { ax, ay, bx, by, r } = o.shape;
  const len = Math.hypot(bx - ax, by - ay);
  const angle = Math.atan2(by - ay, bx - ax);
  const blocks = Math.max(1, Math.round(len / 34));
  const stone = mat(0x8a8272, { rough: 0.95 });
  for (let i = 0; i < blocks; i++) {
    const t = (i + 0.5) / blocks;
    const h = o.visual * (0.5 + (hash(ax + i, ay) % 100) / 200);
    const block = new Mesh(new BoxGeometry(len / blocks - 2, h, r * 2), stone);
    block.position.set(ax + (bx - ax) * t, h / 2, ay + (by - ay) * t);
    block.rotation.y = -angle;
    block.castShadow = true;
    block.receiveShadow = true;
    g.add(block);
  }
  return g;
}

function house(o: Obstacle): Group {
  const g = new Group();
  if (o.shape.type !== 'box') return g;
  const { x, y, hw, hh, angle } = o.shape;
  const wallH = o.visual * 0.6;
  const plaster = mat(0xd8ccb0, { rough: 0.95 });
  const timber = mat(0x4a3020, { rough: 0.9 });
  const roof = mat(0x7a3a2a, { rough: 0.85 });
  const body = new Mesh(new BoxGeometry(hw * 2, wallH, hh * 2), plaster);
  body.position.y = wallH / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // Timber framing on the corners and along the top.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const beam = new Mesh(new BoxGeometry(8, wallH, 8), timber);
      beam.position.set(sx * (hw - 3), wallH / 2, sz * (hh - 3));
      g.add(beam);
    }
  }
  const band = new Mesh(new BoxGeometry(hw * 2 + 4, 6, hh * 2 + 4), timber);
  band.position.y = wallH;
  g.add(band);
  // Gable roof: two sloped slabs meeting at a ridge along the long side, with overhang.
  const long = hw >= hh;
  const span = (long ? hh : hw) + 10;
  const length = (long ? hw : hh) * 2 + 24;
  const rise = o.visual * 0.32;
  const slope = Math.hypot(span, rise);
  const pitch = Math.atan2(rise, span);
  const roofGroup = new Group();
  for (const side of [-1, 1]) {
    const slab = new Mesh(new BoxGeometry(length, 5, slope), roof);
    slab.position.set(0, rise / 2, (side * span) / 2);
    slab.rotation.x = side * pitch;
    slab.castShadow = true;
    slab.receiveShadow = true;
    roofGroup.add(slab);
  }
  // Gable ends close the triangle so the roof does not look like floating planks.
  const tri = new ThreeShape();
  tri.moveTo(-span + 4, 0);
  tri.lineTo(span - 4, 0);
  tri.lineTo(0, rise - 2);
  tri.closePath();
  const gableGeo = new ExtrudeGeometry(tri, { depth: 3, bevelEnabled: false });
  for (const end of [-1, 1]) {
    const gable = new Mesh(gableGeo, plaster);
    // The triangle is drawn in XY; turning it about Y puts it across the roof's long (x) axis.
    gable.rotation.y = Math.PI / 2;
    gable.position.set((end * (length - 24)) / 2 - 1.5, 0, 0);
    gable.castShadow = true;
    roofGroup.add(gable);
  }
  roofGroup.position.y = wallH;
  if (!long) roofGroup.rotation.y = Math.PI / 2;
  g.add(roofGroup);
  const door = new Mesh(new BoxGeometry(4, 34, 22), timber);
  door.position.set(long ? 0 : hw + 1, 17, long ? hh + 1 : 0);
  door.rotation.y = long ? Math.PI / 2 : 0;
  g.add(door);
  const glow = mat(0xffc870, { emissive: 0xffa040, intensity: 1.4 });
  for (const s of [-1, 1]) {
    const win = new Mesh(new BoxGeometry(3, 14, 14), glow);
    win.position.set(long ? s * hw * 0.55 : hw + 1, wallH * 0.6, long ? hh + 1 : s * hh * 0.55);
    win.rotation.y = long ? Math.PI / 2 : 0;
    g.add(win);
  }
  const chimney = new Mesh(new BoxGeometry(16, 40, 16), mat(0x6a6058));
  chimney.position.set(hw * 0.5, wallH + o.visual * 0.35, -hh * 0.3);
  chimney.castShadow = true;
  g.add(chimney);
  g.position.set(x, 0, y);
  g.rotation.y = -angle;
  return g;
}

function stall(o: Obstacle): Group {
  const g = new Group();
  if (o.shape.type !== 'box') return g;
  const { x, y, hw, hh, angle } = o.shape;
  const wood = mat(0x6a4a2a);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new Mesh(new CylinderGeometry(2, 2, 44, 5), wood);
      post.position.set(sx * hw, 22, sz * hh);
      post.castShadow = true;
      g.add(post);
    }
  }
  const counter = new Mesh(new BoxGeometry(hw * 2, 18, hh * 1.2), wood);
  counter.position.y = 9;
  counter.castShadow = true;
  g.add(counter);
  const colors = [0xc0392b, 0x2e86c1, 0xd4ac0d, 0x7d3c98];
  const cloth = new Mesh(new BoxGeometry(hw * 2 + 10, 4, hh * 2 + 10), mat(colors[hash(x, y) % colors.length] ?? 0xc0392b));
  cloth.position.y = 46;
  cloth.rotation.z = 0.12;
  cloth.castShadow = true;
  g.add(cloth);
  for (let i = 0; i < 3; i++) {
    const crate = new Mesh(new BoxGeometry(12, 12, 12), mat(0x8a6a3a));
    crate.position.set(-hw + 12 + i * 16, 24, 0);
    crate.rotation.y = i;
    g.add(crate);
  }
  g.position.set(x, 0, y);
  g.rotation.y = -angle;
  return g;
}

function fence(o: Obstacle): Group {
  const g = new Group();
  if (o.shape.type !== 'capsule') return g;
  const { ax, ay, bx, by } = o.shape;
  const len = Math.hypot(bx - ax, by - ay);
  const angle = Math.atan2(by - ay, bx - ax);
  const wood = mat(0x5a4028);
  const posts = Math.max(2, Math.round(len / 40));
  const postMatrices: Matrix4[] = [];
  for (let i = 0; i <= posts; i++) {
    const t = i / posts;
    postMatrices.push(matrix(ax + (bx - ax) * t, 16, ay + (by - ay) * t, 4, 32, 4));
  }
  const pm = instanced(new BoxGeometry(1, 1, 1), wood, postMatrices);
  if (pm) g.add(pm);
  for (const h of [12, 24]) {
    const rail = new Mesh(new BoxGeometry(len, 3, 3), wood);
    rail.position.set((ax + bx) / 2, h, (ay + by) / 2);
    rail.rotation.y = -angle;
    g.add(rail);
  }
  return g;
}

function well(o: Obstacle): Group {
  const g = new Group();
  if (o.shape.type !== 'circle') return g;
  const { x, y, r } = o.shape;
  const ring = new Mesh(new CylinderGeometry(r, r, 22, 16, 1, true), new MeshStandardMaterial({ color: 0x9a9080, roughness: 0.9, flatShading: true, side: DoubleSide }));
  ring.position.y = 11;
  ring.castShadow = true;
  const water = new Mesh(new CircleGeometry(r * 0.9, 16), mat(0x1d4a6a, { rough: 0.2 }));
  water.rotation.x = -Math.PI / 2;
  water.position.y = 8;
  g.add(ring, water);
  const wood = mat(0x5a3d22);
  for (const s of [-1, 1]) {
    const post = new Mesh(new BoxGeometry(5, 50, 5), wood);
    post.position.set(s * r * 0.9, 25, 0);
    g.add(post);
  }
  const roof = new Mesh(new ConeGeometry(r * 1.4, 22, 4), mat(0x7a3a2a));
  roof.position.y = 60;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  g.add(roof);
  g.position.set(x, 0, y);
  return g;
}

function chest(o: Obstacle): Group {
  const g = new Group();
  if (o.shape.type !== 'box') return g;
  const { x, y, hw, hh, angle } = o.shape;
  const body = new Mesh(new BoxGeometry(hw * 2, 18, hh * 2), mat(0x6a4020));
  body.position.y = 9;
  body.castShadow = true;
  const lid = new Mesh(new BoxGeometry(hw * 2 + 2, 6, hh * 2 + 2), mat(0x7a4a24));
  lid.position.y = 20;
  const trim = new Mesh(new BoxGeometry(4, 20, hh * 2 + 3), mat(0xd8b050, { metal: 0.7, rough: 0.3 }));
  trim.position.y = 12;
  g.add(body, lid, trim);
  g.position.set(x, 0, y);
  g.rotation.y = -angle;
  return g;
}

function crates(o: Obstacle): Group {
  const g = new Group();
  if (o.shape.type !== 'box') return g;
  const { x, y, hw, angle } = o.shape;
  const wood = mat(0x8a6a3a, { rough: 0.95 });
  const s = hw * 1.1;
  const stack: [number, number, number][] = [
    [-s * 0.5, s / 2, 0],
    [s * 0.55, s / 2, s * 0.2],
    [0, s * 1.5, 0.05],
  ];
  for (const [dx, dy, dz] of stack) {
    const c = new Mesh(new BoxGeometry(s, s, s), wood);
    c.position.set(dx, dy, dz);
    c.rotation.y = dx * 0.02;
    c.castShadow = true;
    g.add(c);
  }
  g.position.set(x, 0, y);
  g.rotation.y = -angle;
  return g;
}

function bridge(x: number, y: number, angle: number, length: number, width: number): Group {
  const g = new Group();
  const wood = mat(0x7a5a38, { rough: 0.9 });
  const planks = Math.round(length / 12);
  const list: Matrix4[] = [];
  for (let i = 0; i < planks; i++) list.push(matrix(-length / 2 + (i + 0.5) * (length / planks), 4, 0, length / planks - 1.5, 4, width, 0, 0, ((i * 7) % 5) * 0.004));
  const pm = instanced(new BoxGeometry(1, 1, 1), wood, list);
  if (pm) g.add(pm);
  for (const s of [-1, 1]) {
    const rail = new Mesh(new BoxGeometry(length, 4, 4), wood);
    rail.position.set(0, 22, (s * width) / 2);
    g.add(rail);
    for (const e of [-1, 0, 1]) {
      const post = new Mesh(new BoxGeometry(6, 26, 6), wood);
      post.position.set((e * length) / 2.2, 12, (s * width) / 2);
      post.castShadow = true;
      g.add(post);
    }
  }
  g.position.set(x, 0, y);
  g.rotation.y = -angle;
  return g;
}

function portal(x: number, y: number, r: number, color: number): Landmark {
  const g = new Group();
  const stone = mat(0x6a6460);
  const base = new Mesh(new CylinderGeometry(r * 1.3, r * 1.45, 8, 20), stone);
  base.position.y = 4;
  base.receiveShadow = true;
  g.add(base);
  const ring = new Mesh(new TorusGeometry(r, 5, 8, 32), mat(color, { emissive: color, intensity: 1.2 }));
  ring.position.y = r + 14;
  g.add(ring);
  const tex = new CanvasTexture(swirlCanvas());
  const swirl = new Mesh(new CircleGeometry(r * 0.95, 32), new MeshBasicMaterial({ map: tex, color, transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }));
  swirl.position.y = r + 14;
  g.add(swirl);
  const floor = new Mesh(new RingGeometry(r * 0.5, r * 1.2, 32), new MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 8.5;
  g.add(floor);
  g.position.set(x, 0, y);
  // The portal faces the default camera direction so its swirl reads as a disc, not a line.
  g.rotation.y = Math.PI / 4;
  return {
    group: g,
    update: (t) => {
      swirl.rotation.z = -t * 1.6;
      floor.rotation.z = t * 0.5;
    },
    lights: [{ x, y, height: r + 14, color, intensity: 1.4, radius: 300, flicker: 0.08, priority: 0, day: 0 }],
    fires: [],
  };
}

/**
 * A D2-style waypoint: a raised, weathered slab with four rune stones at its corners and a dim
 * rune circle set into the top. Cold light, kept low so it marks the spot without lighting the night.
 */
function waypoint(x: number, y: number, r: number): Landmark {
  const g = new Group();
  const stone = mat(0x57524c, { rough: 0.95 });
  const dark = mat(0x3a3632, { rough: 1 });
  const side = r * 1.9;
  const base = new Mesh(new BoxGeometry(side + 14, 6, side + 14), dark);
  base.position.y = 3;
  const slab = new Mesh(new BoxGeometry(side, 6, side), stone);
  slab.position.y = 9;
  base.receiveShadow = true;
  slab.receiveShadow = true;
  g.add(base, slab);
  const glow = 0x5fd8d0;
  const runeMat = new MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false });
  const circle = new Mesh(new RingGeometry(r * 0.55, r * 0.68, 6), runeMat);
  circle.rotation.x = -Math.PI / 2;
  circle.position.y = 12.2;
  const inner = new Mesh(new RingGeometry(r * 0.2, r * 0.26, 3), runeMat);
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 12.2;
  g.add(circle, inner);
  const stones: Mesh[] = [];
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    const pillar = new Mesh(new CylinderGeometry(5, 7, 34, 4), stone);
    pillar.position.set((sx * side) / 2 - sx * 6, 12 + 17, (sz * side) / 2 - sz * 6);
    pillar.rotation.y = Math.PI / 4;
    pillar.castShadow = true;
    const mark = new Mesh(new PlaneGeometry(4, 9), runeMat);
    mark.position.set(pillar.position.x, 34, pillar.position.z);
    mark.lookAt(0, 34, 0);
    mark.position.x -= sx * 4.2;
    mark.position.z -= sz * 4.2;
    g.add(pillar, mark);
    stones.push(mark);
  }
  g.position.set(x, 0, y);
  return {
    group: g,
    update: (t) => {
      const pulse = 0.45 + Math.sin(t * 1.3) * 0.12;
      runeMat.opacity = pulse;
      circle.rotation.z = t * 0.15;
      inner.rotation.z = -t * 0.3;
    },
    // Cold and low: it marks the spot without lighting up the night.
    lights: [{ x, y, height: 30, color: glow, intensity: 0.9, radius: 260, flicker: 0.04, priority: 0, day: 0 }],
    fires: [],
  };
}

/**
 * The way down to the Arena from town: a squat round stone drum, like the top of a sunken
 * colosseum, with an archway and steps leading into the dark, and a torch either side. Walking
 * into the archway takes you down.
 */
function arenaBuilding(x: number, y: number, r: number): Landmark {
  const g = new Group();
  const stone = mat(0x5a544e, { rough: 0.95 });
  const dark = mat(0x3c3833, { rough: 1 });
  const iron = new MeshStandardMaterial({ color: 0x1c1a18, roughness: 0.7, metalness: 0.6, side: DoubleSide });
  const radius = r * 1.55;
  const segments = 12;
  // The archway faces down the screen (the camera looks from +x+z), so the way in is visible.
  const facing = Math.PI / 4;
  for (let i = 0; i < segments; i++) {
    const a = facing + (Math.PI * 2 * i) / segments;
    if (i === 0) continue;
    const seg = new Mesh(new BoxGeometry(radius * 0.55, 34 + (i % 3) * 5, 14), i % 2 ? stone : dark);
    seg.position.set(Math.cos(a) * radius, 17, Math.sin(a) * radius);
    seg.rotation.y = -a + Math.PI / 2;
    seg.castShadow = true;
    seg.receiveShadow = true;
    g.add(seg);
  }
  // The pit inside: a sand ring around a well of shadow, so it reads as a drop, not a hole in the map.
  const sand = new Mesh(new RingGeometry(radius * 0.55, radius * 0.95, 28), mat(0x5a4a36, { rough: 1 }));
  sand.rotation.x = -Math.PI / 2;
  sand.position.y = 0.9;
  sand.receiveShadow = true;
  const well = new Mesh(new CircleGeometry(radius * 0.56, 28), new MeshBasicMaterial({ color: 0x17120d }));
  well.rotation.x = -Math.PI / 2;
  well.position.y = 0.8;
  g.add(sand, well);
  for (let k = 0; k < 4; k++) {
    const step = new Mesh(new BoxGeometry(r * 1.1, 4, 12), k % 2 ? stone : dark);
    const d = radius * (0.95 - k * 0.12);
    step.position.set(Math.cos(facing) * d, 2 - k * 0.2, Math.sin(facing) * d);
    step.rotation.y = -facing + Math.PI / 2;
    step.receiveShadow = true;
    g.add(step);
  }
  const lintel = new Mesh(new BoxGeometry(r * 1.3, 10, 18), stone);
  lintel.position.set(Math.cos(facing) * radius, 44, Math.sin(facing) * radius);
  lintel.rotation.y = -facing + Math.PI / 2;
  lintel.castShadow = true;
  g.add(lintel);
  const lights: StaticLight[] = [];
  const fires: FireSpot[] = [];
  // Across the archway: perpendicular to the direction it faces.
  const sideX = -Math.sin(facing);
  const sideZ = Math.cos(facing);
  for (const s of [-1, 1]) {
    const bx = Math.cos(facing) * (radius + 14) + sideX * s * r * 0.95;
    const bz = Math.sin(facing) * (radius + 14) + sideZ * s * r * 0.95;
    const post = new Mesh(new CylinderGeometry(2.5, 3, 40, 6), dark);
    post.position.set(bx, 20, bz);
    // An iron cup on the post holds the pitch the flame burns from.
    const cup = new Mesh(new CylinderGeometry(5, 3, 5, 7, 1, true), iron);
    cup.position.set(bx, 41.5, bz);
    g.add(post, cup);
    const light: StaticLight = { ...TORCH, x: x + bx, y: y + bz, height: 46, radius: 340 };
    lights.push(light);
    fires.push({ kind: 'torch', x: x + bx, y: y + bz, h: 40, size: 0.75, pull: 0, lightX: light.x, lightY: light.y, flicker: light.flicker, forge: false });
  }
  g.position.set(x, 0, y);
  return { group: g, update: () => {}, lights, fires };
}

/**
 * Charred bark split by glowing cracks, for the logs of a camp fire; the cracks are the emissive
 * map, so the fire's flicker only has to move the emissive intensity.
 */
function emberCanvas(): HTMLCanvasElement {
  const { c, g } = canvas(64);
  if (!g) return c;
  const rand = lcg(31);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 14; i++) {
    g.strokeStyle = `rgba(255, ${120 + Math.floor(rand() * 80)}, 40, ${0.5 + rand() * 0.5})`;
    g.lineWidth = 1 + rand() * 1.5;
    g.beginPath();
    let px = rand() * 64;
    let py = rand() * 64;
    g.moveTo(px, py);
    for (let k = 0; k < 4; k++) {
      px += (rand() - 0.5) * 18;
      py += rand() * 10;
      g.lineTo(px, py);
    }
    g.stroke();
  }
  return c;
}

/** A camp fire (and the forge's fire): a ring of stones, crossed charred logs with glowing cracks, and the flames from worldFires. */
function campfire(x: number, y: number, forge: boolean): { group: Group; update: (t: number) => void; light: StaticLight; fire: FireSpot } {
  const g = new Group();
  const stones: Matrix4[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (Math.PI * 2 * i) / 9;
    stones.push(matrix(Math.cos(a) * 22, 4, Math.sin(a) * 22, 8, 7, 8, a));
  }
  const sm = instanced(rockGeometry(3), mat(0x6a6460), stones);
  if (sm) g.add(sm);
  const embers = new CanvasTexture(emberCanvas());
  embers.colorSpace = SRGBColorSpace;
  const bark = new MeshStandardMaterial({ color: 0x1e1510, roughness: 1, emissive: 0xff5a1a, emissiveMap: embers, emissiveIntensity: 1 });
  const logs: Matrix4[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI * i) / 4 + 0.3;
    // Crossed and propped on each other, each tipped a little so the heap is not flat.
    dummy.position.set(Math.cos(a) * 2, 3.5 + i * 1.2, Math.sin(a) * 2);
    dummy.rotation.set(0, a, Math.PI / 2 + (i % 2 ? 0.12 : -0.1));
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    logs.push(dummy.matrix.clone());
  }
  const lm = instanced(new CylinderGeometry(2.4, 2.9, 30, 6), bark, logs);
  if (lm) {
    lm.castShadow = false;
    g.add(lm);
  }
  g.position.set(x, 0, y);
  const light = lightAt(FIRE, x, y);
  return {
    group: g,
    update: (t) => {
      bark.emissiveIntensity = 0.9 * staticFlicker(t, x, y, FIRE.flicker * 2);
    },
    light,
    fire: { kind: 'bonfire', x, y, h: 3, size: forge ? 0.9 : 1, pull: 0, lightX: x, lightY: y, flicker: FIRE.flicker, forge },
  };
}

/** True where the scenery outside the map should open up for a zone gate's road. */
function inGateGap(def: WorldMap, x: number, y: number, depth: number): boolean {
  return def.portals.some((p) => {
    if (p.target !== 'zone') return false;
    const west = p.x < def.width / 2;
    const out = west ? -x : x - def.width;
    return out > -60 && out < depth && Math.abs(y - p.y) < 110 + out * 0.15;
  });
}

/** A band of big rocks and trees just outside the playable edge, so the map ends in wilderness, not a cliff of nothing. */
function addBorder(group: Group, batch: PropBatch, def: WorldMap): void {
  const rng = new Rng(def.width * 31 + def.height);
  const rocks: Obstacle[] = [];
  const trees: Obstacle[] = [];
  const perimeter = 2 * (def.width + def.height);
  for (let d = 0; d < perimeter; d += 70) {
    let x: number;
    let y: number;
    if (d < def.width) [x, y] = [d, -30];
    else if (d < def.width + def.height) [x, y] = [def.width + 30, d - def.width];
    else if (d < 2 * def.width + def.height) [x, y] = [2 * def.width + def.height - d, def.height + 30];
    else [x, y] = [-30, perimeter - d];
    x += rng.range(-20, 20);
    y += rng.range(-20, 20);
    if (inGateGap(def, x, y, 200)) continue;
    if (rng.next() < 0.5 && def.theme !== 'town') rocks.push({ kind: 'rock', shape: { type: 'circle', x, y, r: rng.range(40, 70) }, blocksMove: true, blocksShots: true, visual: rng.range(40, 90) });
    else trees.push({ kind: 'tree', shape: { type: 'circle', x, y, r: 16 }, blocksMove: true, blocksShots: true, visual: rng.range(55, 80) });
  }
  addRocks(batch, rocks);
  addTrees(group, trees, def);
  addWildBorder(group, batch, def, rng);
}

/** How far the scenery runs past the map edge; the camera sees about this far from the edge. */
const BORDER_DEPTH = 1500;
const BORDER_PEAKS = ['mountain_A_grass_trees', 'mountain_B_grass', 'mountain_C', 'hills_A_trees', 'hills_B'];

/**
 * Forest, rocks and mountains filling the band outside the playable area, so the edge of the world
 * reads as wilderness you cannot cross rather than black. Out of reach, so the trees never need the
 * see-through fade and are instanced per variant: a few draw calls for thousands of trees.
 */
function addWildBorder(group: Group, batch: PropBatch, def: WorldMap, rng: Rng): void {
  const { width: w, height: h } = def;
  const bleak = /Ashen|Gloom/.test(def.name);
  /** Distance outside the map, 0 inside it. */
  const outside = (x: number, y: number): number => Math.max(-x, x - w, -y, y - h, 0);
  const byGeometry = new Map<BufferGeometry, Matrix4[]>();
  const rocks: Obstacle[] = [];
  const STEP = 85;
  for (let y = -BORDER_DEPTH; y < h + BORDER_DEPTH; y += STEP) {
    for (let x = -BORDER_DEPTH; x < w + BORDER_DEPTH; x += STEP) {
      const px = x + rng.range(-STEP * 0.45, STEP * 0.45);
      const py = y + rng.range(-STEP * 0.45, STEP * 0.45);
      const d = outside(px, py);
      // The edge row itself is drawn by addBorder with fading trees the player can walk behind.
      if (d < 80) continue;
      const roll = rng.next();
      // The road out of a gate runs a little way into the forest before the trees close over it.
      if (inGateGap(def, px, py, 520)) continue;
      if (roll < 0.05 && def.theme !== 'town') {
        rocks.push({ kind: 'rock', shape: { type: 'circle', x: px, y: py, r: rng.range(35, 75) }, blocksMove: false, blocksShots: false, visual: 60 });
        continue;
      }
      // Thins out far away, where mountains and fog take over.
      if (roll > (d < 700 ? 0.85 : 0.45)) continue;
      const k = hash(px, py);
      const kind: TreeKind = k % 100 < (bleak ? 35 : 6) ? 'dead' : k % 3 === 0 ? 'oak' : 'pine';
      const size = rng.range(55, 90) * (kind === 'pine' ? 1.05 : 1.25);
      const geo = treeGeometry(kind, k);
      byGeometry.set(geo, [...(byGeometry.get(geo) ?? []), matrix(px, 0, py, size, size, size, k)]);
    }
  }
  const treeMat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
  for (const [geo, transforms] of byGeometry) {
    const m = instanced(geo, treeMat, transforms);
    if (!m) continue;
    // Shadows this far out are off-screen or under fog, and thousands of casters are not free.
    m.castShadow = false;
    group.add(m);
  }
  addRocks(batch, rocks);

  // Two staggered rings of peaks behind the forest.
  const perimeter = 2 * (w + h);
  for (const [depth, spacing] of [
    [650, 380],
    [1150, 460],
  ] as const) {
    for (let t = rng.range(0, spacing); t < perimeter + depth * 8; t += spacing * rng.range(0.8, 1.2)) {
      const at = pointAround(w, h, depth, t);
      if (!at) continue;
      const asset = BORDER_PEAKS[rng.int(0, BORDER_PEAKS.length - 1)] ?? 'mountain_C';
      batch.add(asset, { x: at.x + rng.range(-60, 60), y: at.y + rng.range(-60, 60), angle: rng.range(0, 6), fit: { radius: rng.range(depth < 1000 ? 200 : 280, depth < 1000 ? 300 : 420) } });
    }
  }
}

/** A point `depth` outside the map rectangle, `t` along its enlarged perimeter (corners included). */
function pointAround(w: number, h: number, depth: number, t: number): { x: number; y: number } | null {
  const W = w + depth * 2;
  const H = h + depth * 2;
  const total = 2 * (W + H);
  if (t >= total) return null;
  if (t < W) return { x: t - depth, y: -depth };
  if (t < W + H) return { x: w + depth, y: t - W - depth };
  if (t < 2 * W + H) return { x: w + depth - (t - W - H), y: h + depth };
  return { x: -depth, y: h + depth - (t - 2 * W - H) };
}

/** Grass tufts, flowers and pebbles: thousands of instances, no collision, placed away from obstacles. */
function addDecor(group: Group, def: WorldMap): void {
  if (def.theme === 'flat') return;
  const rng = new Rng(def.width + def.obstacles.length);
  const count = Math.floor((def.width * def.height) / 9000);
  const grass: Matrix4[] = [];
  const flowers: Matrix4[] = [];
  const flowerColors: Color[] = [];
  const pebbles: Matrix4[] = [];
  const palette = [0xf5e663, 0xffffff, 0xe06070, 0x9fb4ff];
  const onPatch = (x: number, y: number): boolean =>
    def.ground.some((g) => g.kind === 'plaza' && g.shape.type === 'circle' && Math.hypot(x - g.shape.x, y - g.shape.y) < g.shape.r);
  const nearObstacle = (x: number, y: number): boolean =>
    def.obstacles.some((o) => {
      const c = shapeCentre(o.shape);
      return Math.abs(c.x - x) < 70 && Math.abs(c.y - y) < 70;
    });
  for (let i = 0; i < count; i++) {
    const x = rng.range(20, def.width - 20);
    const y = rng.range(20, def.height - 20);
    if (onPatch(x, y)) continue;
    const roll = rng.next();
    if (roll < 0.7) {
      if (nearObstacle(x, y) && rng.next() < 0.7) continue;
      const s = rng.range(4, 9);
      grass.push(matrix(x, s / 2, y, s * 0.5, s, s * 0.5, rng.range(0, 6), rng.range(-0.3, 0.3)));
    } else if (roll < 0.85) {
      flowers.push(matrix(x, 3, y, 2.5, 2.5, 2.5));
      flowerColors.push(new Color(palette[rng.int(0, palette.length - 1)] ?? 0xffffff));
    } else {
      const s = rng.range(2, 5);
      pebbles.push(matrix(x, s * 0.3, y, s, s * 0.6, s, rng.range(0, 6)));
    }
  }
  const grassColor = new Color(def.groundTint).offsetHSL(0.01, -0.02, 0.02).getHex();
  const g1 = instanced(new ConeGeometry(1, 1, 3), mat(grassColor, { rough: 1 }), grass);
  const g2 = instanced(new IcosahedronGeometry(1, 0), mat(0xffffff, { emissive: 0x202020 }), flowers, flowerColors);
  const g3 = instanced(new IcosahedronGeometry(1, 0), mat(0x7a7468), pebbles);
  for (const m of [g1, g2, g3]) {
    if (!m) continue;
    // Decor is too small to cast useful shadows and there are thousands of instances.
    m.castShadow = false;
    group.add(m);
  }
}


// ---------------------------------------------------------------------------------------------
// Dungeons

/** Flagstone quads and rock wall boxes, each merged into one mesh, with UVs in world space so the texture never stretches. */
function addUnderground(group: Group, def: WorldMap): void {
  const tile = 160;
  const floorPos: number[] = [];
  const floorUv: number[] = [];
  const floorIdx: number[] = [];
  for (const patch of def.ground) {
    if (patch.kind !== 'floor' || patch.shape.type !== 'box') continue;
    const { x, y, hw, hh } = patch.shape;
    const base = floorPos.length / 3;
    for (const [cx, cz] of [
      [x - hw, y - hh],
      [x + hw, y - hh],
      [x + hw, y + hh],
      [x - hw, y + hh],
    ] as const) {
      floorPos.push(cx, 0.5, cz);
      floorUv.push(cx / tile, cz / tile);
    }
    floorIdx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const floorGeo = new BufferGeometry();
  floorGeo.setAttribute('position', new BufferAttribute(new Float32Array(floorPos), 3));
  floorGeo.setAttribute('uv', new BufferAttribute(new Float32Array(floorUv), 2));
  floorGeo.setIndex(floorIdx);
  floorGeo.computeVertexNormals();
  const floor = new Mesh(floorGeo, new MeshStandardMaterial({ map: repeatTexture(stoneCanvas(), 1, 1), color: 0xd0c4b4, roughness: 0.95 }));
  floor.receiveShadow = true;
  group.add(floor);

  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  // Low walls: a full-height wall on the south side of a room would hide anyone standing behind it.
  const h = 44;
  const quad = (a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[], uvs: readonly number[]) => {
    const base = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    uv.push(...uvs);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const o of def.obstacles) {
    if (o.kind !== 'cavewall' || o.shape.type !== 'box') continue;
    const { x, y, hw, hh } = o.shape;
    const x0 = x - hw;
    const x1 = x + hw;
    const z0 = y - hh;
    const z1 = y + hh;
    const t = 96;
    quad([x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0], [x0 / t, z0 / t, x0 / t, z1 / t, x1 / t, z1 / t, x1 / t, z0 / t]);
    quad([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1], [x0 / t, 0, x1 / t, 0, x1 / t, h / t, x0 / t, h / t]);
    quad([x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0], [x1 / t, 0, x0 / t, 0, x0 / t, h / t, x1 / t, h / t]);
    quad([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0], [z0 / t, 0, z1 / t, 0, z1 / t, h / t, z0 / t, h / t]);
    quad([x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1], [z1 / t, 0, z0 / t, 0, z0 / t, h / t, z1 / t, h / t]);
  }
  const wallGeo = new BufferGeometry();
  wallGeo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  wallGeo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  wallGeo.setIndex(idx);
  wallGeo.computeVertexNormals();
  const walls = new Mesh(wallGeo, withOccluderFade(new MeshStandardMaterial({ map: repeatTexture(stoneCanvas(), 1, 1), color: 0x8a7e72, roughness: 1, side: DoubleSide })));
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);
}
