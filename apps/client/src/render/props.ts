import { lookHash as hash, pickHouseModel, pickPillarModel, Rng, ZONES, type Decor, type Obstacle, type Shape, type WorldMap, type WorldPlan, type ZoneWorld } from '@rune/shared';
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
  Vector3,
  type Texture,
} from 'three';
import { COLORS } from './config.js';
import { assetById } from './assets.js';
import { mat } from './models.js';
import { withOccluderFade } from './occluderFade.js';
import { staticFlicker, type StaticLight } from './lights.js';
import { chunkCoord, chunkKey, CHUNK_SIZE, streamRadii } from './chunks.js';
import type { Placer } from './propBatch.js';
import { WorldChunks, type Anim } from './worldChunks.js';
import { treeGeometry, type TreeKind } from './trees.js';
import type { FireKind, FireSpot } from './vfx/worldFires.js';

export interface BuiltWorld {
  group: Group;
  /**
   * Per-frame: streams the chunks around the camera focus (`footprint` is how far the view reaches
   * on the ground, see `viewFootprint`) and animates water, portals, fires and canopy fading.
   */
  update(t: number, playerX: number, playerY: number, footprint?: number): void;
  /** Stops pending asset loads from adding meshes to a world that has been replaced. */
  dispose(): void;
  /** Torches, lanterns, fires, portals and waypoints, for the scene's light budget. */
  lights: readonly StaticLight[];
  /** Every flame in the world, drawn by the effects system (`vfx/worldFires.ts`). */
  fires: readonly FireSpot[];
  /** Resolves once the models near the start have been built, for the world bench's load time. */
  ready: Promise<void>;
  /** Chunk counts, for the world bench and the perf readout. */
  stats: WorldChunks['stats'];
}

type LightLook = Omit<StaticLight, 'x' | 'y'>;
/**
 * Warm flame colours; heights are where the light sits. A torch's light hangs well above its
 * flame: a real light 16 units over the bowl lit the iron prongs about 4.5 times as bright as the
 * floor below and burned them white up close, and at 100 they get about 1.9 times.
 */
const TORCH: LightLook = { height: 100, color: 0xff9a4a, intensity: 3, radius: 400, flicker: 0.1, priority: 0, day: 0 };
const LANTERN: LightLook = { height: 64, color: 0xffb060, intensity: 2.8, radius: 340, flicker: 0.05, priority: 0, day: 0 };
const CANDLE: LightLook = { height: 14, color: 0xffb060, intensity: 0.9, radius: 170, flicker: 0.12, priority: 0, day: 0 };
const FIRE: LightLook = { height: 40, color: 0xff9040, intensity: 3.2, radius: 520, flicker: 0.12, priority: 0, day: 0 };

/** Decor that is itself a flame or a lamp, and the light it casts, per unit of scale. */
const LIT_DECOR: Record<string, LightLook> = {
  dungeon_torch_lit: TORCH,
  dungeon_candle_lit: CANDLE,
  dungeon_candle_thin_lit: CANDLE,
  grave_lantern_standing: { ...LANTERN, height: 38, intensity: 1.4, radius: 300 },
  grave_post_lantern: LANTERN,
  grave_shrine_candles: { ...CANDLE, height: 30, intensity: 1.2, radius: 220 },
  grave_candle: { ...CANDLE, height: 16 },
  grave_candle_melted: CANDLE,
  grave_candle_thin: { ...CANDLE, height: 16 },
  grave_candle_triple: { ...CANDLE, height: 16, intensity: 1.1, radius: 200 },
  grave_skull_candle: { ...CANDLE, height: 18 },
  grave_plaque_candles: { ...CANDLE, height: 22, intensity: 1.3, radius: 230 },
  campfire: FIRE,
  // A brazier is a small fire held up at waist height: a little less light than a camp fire.
  brazier: { ...FIRE, height: 44, intensity: 2.6, radius: 440 },
};

/** Whether a decor asset is a lamp or flame, for the town editor's layer groups. */
export function isLitDecor(asset: string): boolean {
  return Object.hasOwn(LIT_DECOR, asset);
}

/** Decor built in code rather than loaded from a file: the fires. Placed like any other decor. */
export const PROCEDURAL_DECOR: Readonly<Record<string, { label: string; height: number }>> = {
  campfire: { label: 'Camp fire', height: 20 },
  brazier: { label: 'Brazier', height: 44 },
};

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
  // The Halloween candles have wicks but no flame; these sit on the wick tips (the top of each
  // small separate wick mesh, measured at the registered heights).
  dungeon_candle_thin_lit: [{ kind: 'candle', x: 0, h: 8, z: 0, size: 0.8, pull: 0 }],
  grave_candle: [{ kind: 'candle', x: 0, h: 12, z: 0, size: 0.9, pull: 0 }],
  grave_candle_melted: [{ kind: 'candle', x: 0.1, h: 10, z: 0, size: 0.9, pull: 0 }],
  grave_candle_thin: [{ kind: 'candle', x: 0, h: 12, z: 0, size: 0.8, pull: 0 }],
  grave_candle_triple: [
    { kind: 'candle', x: 3.3, h: 12, z: -0.7, size: 0.8, pull: 0 },
    { kind: 'candle', x: -0.1, h: 9.6, z: 0, size: 0.8, pull: 0 },
    { kind: 'candle', x: 2.8, h: 8.7, z: 1.8, size: 0.8, pull: 0 },
  ],
  grave_skull_candle: [
    { kind: 'candle', x: 1.2, h: 14, z: -2.8, size: 0.7, pull: 0 },
    { kind: 'candle', x: -0.9, h: 12.2, z: -0.3, size: 0.7, pull: 0 },
    { kind: 'candle', x: 1.7, h: 11.6, z: -0.1, size: 0.7, pull: 0 },
  ],
  grave_plaque_candles: [
    { kind: 'candle', x: 6.3, h: 20, z: 1.9, size: 0.9, pull: 0 },
    { kind: 'candle', x: -5.1, h: 18.1, z: -2.4, size: 0.9, pull: 0 },
    { kind: 'candle', x: 2.4, h: 17.3, z: 2.7, size: 0.9, pull: 0 },
    { kind: 'candle', x: 5.7, h: 16.2, z: 4.8, size: 0.9, pull: 0 },
    { kind: 'candle', x: -14.4, h: 15.2, z: 3.8, size: 0.9, pull: 0 },
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

/** GPU resources a built world made for itself, freed with it (the town editor rebuilds the world on every edit). */
type Owned = { dispose(): void }[];

function repeatTexture(c: HTMLCanvasElement, repeatX: number, repeatY: number, owned: Owned): Texture {
  const tex = new CanvasTexture(c);
  owned.push(tex);
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

/**
 * The static world of a map, registered by chunk (`WorldChunks`). A generated zone (`zone`, world
 * streaming step 3) registers its plan here and each chunk's trees, rocks and bones the first time
 * that chunk is about to be built, generating them then from the zone's seed.
 */
/**
 * Bleak places get more dead trees: in the world by the region a tree stands in, set up by
 * `buildWorld` for its map; on any other map by the map's name, as zones always had it.
 */
const bleakness = new WeakMap<WorldMap, (x: number, y: number) => boolean>();

function bleakAt(def: WorldMap, x: number, y: number): boolean {
  return bleakness.get(def)?.(x, y) ?? /Ashen|Gloom/.test(def.name);
}

export function buildWorld(def: WorldMap, zone: ZoneWorld | null = null): BuiltWorld {
  const plan = zone?.plan;
  if (plan) bleakness.set(def, (x, y) => ZONES[plan.regionAt(x, y)].bleak);
  const group = new Group();
  const chunks = new WorldChunks();
  group.add(chunks.group);
  const animated: Anim[] = [];
  const lights: StaticLight[] = [];
  const fires: FireSpot[] = [];
  const owned: Owned = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };
  const { width, height } = def;

  // The Arena pit is an underground colosseum carved like a dungeon, lit the same way by torches.
  const underground = def.theme === 'dungeon' || def.theme === 'staging' || def.theme === 'arena';
  // Outdoors the grass runs on under the border forest, so the camera never looks past it into the void.
  const margin = underground ? 0 : BORDER_DEPTH;
  const gw = width + margin * 2;
  const gh = height + margin * 2;
  // Ground. Underground it is the rock itself: near black, with the carved floor laid on top.
  const groundMat = own(
    underground ? new MeshStandardMaterial({ color: 0x0c0a09, roughness: 1 }) : new MeshStandardMaterial({ map: repeatTexture(grassCanvas(), 1, 1, owned), color: def.groundTint, roughness: 1 }),
  );
  // In the world each region keeps the ground colour its zone had, blended over a few hundred units at the borders.
  const tint = plan && !underground ? (x: number, y: number) => regionTint(plan, x, y) : null;
  if (tint) groundMat.color.set(0xffffff);
  if (tint) groundMat.vertexColors = true;
  addGroundTiles(chunks, groundMat, -margin, -margin, gw, gh, tint);
  const voidPlane = new Mesh(new PlaneGeometry(gw * 3, gh * 3), own(new MeshBasicMaterial({ color: COLORS.background })));
  voidPlane.rotation.x = -Math.PI / 2;
  voidPlane.position.set(width / 2, -3, height / 2);
  group.add(voidPlane);

  const stoneTex = repeatTexture(stoneCanvas(), 1, 1, owned);
  const dirtTex = repeatTexture(dirtCanvas(), 1, 1, owned);
  // Every road segment draws the same: one material for all of them, not one per segment and chunk build.
  const roadMat = own(new MeshStandardMaterial({ map: dirtTex, roughness: 1, transparent: true, opacity: 0.85 }));
  if (underground) addUnderground(chunks, def, owned);
  for (const patch of def.ground) {
    if (patch.kind === 'floor') continue;
    const s = patch.shape;
    if (s.type === 'circle') {
      // Made once per patch, not per build: a chunk is rebuilt every time it comes back into range.
      const tex = own((patch.kind === 'plaza' ? stoneTex : dirtTex).clone());
      tex.repeat.set(s.r / 90, s.r / 90);
      const patchMat = own(new MeshStandardMaterial({ map: tex, roughness: 0.95 }));
      chunks.build(s.x, s.y, s.r, (g) => {
        const m = new Mesh(new CircleGeometry(s.r, 48), patchMat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(s.x, 0.4 + (patch.kind === 'plaza' ? 0.2 : 0), s.y);
        m.receiveShadow = true;
        g.add(m);
      });
    } else if (s.type === 'capsule') {
      const cx = (s.ax + s.bx) / 2;
      const cy = (s.ay + s.by) / 2;
      chunks.build(cx, cy, Math.hypot(s.bx - s.ax, s.by - s.ay) / 2 + s.r, (g) => {
        const geo = ribbon(
          [
            { x: s.ax, y: s.ay },
            { x: s.bx, y: s.by },
          ],
          s.r,
          0.3,
          120,
        );
        const m = new Mesh(geo, roadMat);
        m.receiveShadow = true;
        g.add(m);
        const cap = new Mesh(new CircleGeometry(s.r, 20), roadMat);
        cap.rotation.x = -Math.PI / 2;
        cap.position.set(s.bx, 0.3, s.by);
        g.add(cap);
      });
    }
  }

  // Rivers: a muddy bank ribbon under a translucent, flowing water ribbon. A river crosses the whole
  // map as a few hundred vertices in two draws, so it stays whole rather than being cut into chunks.
  const waterTex = repeatTexture(waterCanvas(), 1, 1, owned);
  for (const river of def.rivers) {
    const bank = new Mesh(ribbon(river.path, river.width / 2 + 16, 0.5, 200), own(new MeshStandardMaterial({ color: 0x3a3022, roughness: 1 })));
    bank.receiveShadow = true;
    const waterMat = own(new MeshStandardMaterial({ map: waterTex, color: 0x9fd0ff, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.88 }));
    const water = new Mesh(ribbon(river.path, river.width / 2 + 2, 1.2, 160), waterMat);
    group.add(bank, water);
    animated.push((t) => {
      waterTex.offset.y = -t * 0.35;
    });
  }
  for (const b of def.bridges) chunks.build(b.x, b.y, b.length / 2 + b.width, (g) => g.add(bridge(b.x, b.y, b.angle, b.length, b.width)));

  addObstacles(chunks, def.obstacles, def);
  const addFire = (fire: BuiltFire, x: number, y: number): void => {
    chunks.attach(x, y, 60, fire.group, fire.update);
    lights.push(fire.light);
    fires.push(fire.fire);
  };
  for (const d of def.decor) {
    const fire = d.asset === 'campfire' ? campfire(d.x, d.y, false, d.scale, d.angle) : d.asset === 'brazier' ? brazier(d.x, d.y, d.scale, d.angle) : null;
    if (fire) {
      addFire(fire, d.x, d.y);
      continue;
    }
    addDecorPiece(chunks, d);
    const look = LIT_DECOR[d.asset];
    const light = look ? lightAt(look, d.x, d.y, d.scale) : null;
    if (light) lights.push(light);
    flamesOf(d.asset, d.x, d.y, d.angle, d.scale, light, fires);
  }
  // A zone's chunks: generated and registered when first near. Chunk decor is never a light or a
  // flame (zoneChunks.test.ts in the client checks), since the light budget is fixed at load.
  if (zone) {
    for (let cy = 0; cy < zone.rows; cy++) {
      for (let cx = 0; cx < zone.cols; cx++) {
        chunks.lazy(cx, cy, () => {
          addObstacles(chunks, zone.obstacles(cx, cy), def, false);
          for (const d of zone.decor(cx, cy)) addDecorPiece(chunks, d);
        });
      }
    }
  }
  for (const l of def.lamps ?? []) {
    const asset = underground ? 'dungeon_torch_lit' : 'grave_post_lantern';
    chunks.add(asset, { x: l.x, y: l.y, angle: 0, fit: { height: underground ? 50 : 80 } });
    const light = lightAt(underground ? TORCH : LANTERN, l.x, l.y);
    lights.push(light);
    // The asset heights are 50 (torch) and 70 (post lantern); lamps are fitted to 50 and 80.
    flamesOf(asset, l.x, l.y, 0, underground ? 1 : 80 / 70, light, fires);
  }
  if (!underground) addBorder(chunks, def, owned);

  const PORTAL_COLORS = { town: 0x6bb6ff, arena: 0xff7a3a, wilds: 0xb49cff, staging: 0xd04a3a, dungeon: 0xffb347, waypoint: 0x5ff0e0 } as const;
  for (const p of def.portals) {
    // In town the way to the Arena is a building, walked into; elsewhere 'arena' is still a portal.
    const arenaEntrance = p.target === 'arena' && (def.theme === 'town' || !!def.safeZones?.length);
    const built = p.target === 'waypoint' ? waypoint(p.x, p.y, p.r) : arenaEntrance ? arenaBuilding(p.x, p.y, p.r) : portal(p.x, p.y, p.r, PORTAL_COLORS[p.target]);
    chunks.attach(p.x, p.y, p.r * 2, built.group, built.update);
    lights.push(...built.lights);
    fires.push(...built.fires);
  }
  // The forge's fire, beside its weapon rack, so the spot reads as a smithy at night too.
  if (def.forge) addFire(campfire(def.forge.x + 38, def.forge.y + 22, true), def.forge.x + 38, def.forge.y + 22);
  // Zones with a town arrive in the town; only a bare Wilds gets a camp with a fire.
  if (def.theme === 'wilds' && !def.safeZones?.length) addFire(campfire(def.spawn.x + 40, def.spawn.y + 60, false), def.spawn.x + 40, def.spawn.y + 60);
  if (!underground) addGrass(chunks, def, zone);

  return {
    group,
    update(t, px, py, footprint = DEFAULT_FOOTPRINT) {
      chunks.update(t, px, py, streamRadii(footprint));
      for (const a of animated) a(t, px, py);
    },
    dispose() {
      chunks.dispose();
      for (const o of owned) o.dispose();
      TREE_MATERIALS.get(chunks)?.dispose();
    },
    lights,
    fires,
    ready: chunks.ready,
    stats: chunks.stats,
  };
}

/** The view's ground footprint at the game's own camera on a 16:9 screen, for callers that do not pass one. */
const DEFAULT_FOOTPRINT = 600;

/** Decor drawn from a model, placed like any other prop. */
function addDecorPiece(chunks: WorldChunks, d: Decor): void {
  chunks.add(d.asset, { x: d.x, y: d.y, angle: d.angle, fit: { scale: d.scale }, fade: fadesDecor(d.asset) });
}

/**
 * The model a house obstacle is drawn with: a town prop's own (`look`, fixed by the layout in town
 * coordinates, so the town looks the same in the world and in the editor), else the pick by world
 * position. Null for other kinds.
 */
export function houseModel(o: Obstacle): string | null {
  if (o.kind !== 'house' || o.shape.type !== 'box') return null;
  return o.look?.model ?? pickHouseModel(lookSeed(o), o.shape.hw, o.shape.hh);
}

/** A pillar's model, chosen like a house's (`houseModel`). */
export function pillarModel(o: Obstacle): string | null {
  if (o.kind !== 'pillar' || o.shape.type !== 'circle') return null;
  return o.look?.model ?? pickPillarModel(lookSeed(o));
}

/** The hash an obstacle's look varies by: a town prop's own, in town coordinates, else its world position's. */
export function lookSeed(o: Obstacle): number {
  if (o.look) return o.look.seed;
  const s = o.shape;
  return s.type === 'capsule' ? hash(s.ax, s.ay) : hash(s.x, s.y);
}

const STALL_CLOTHS = [0xc0392b, 0x2e86c1, 0xd4ac0d, 0x7d3c98];

export function stallCloth(o: Obstacle): number {
  return STALL_CLOTHS[lookSeed(o) % STALL_CLOTHS.length] ?? 0xc0392b;
}

/** Registers obstacles, grouped by kind so the common ones can be instanced. */
function addObstacles(chunks: WorldChunks, obstacles: readonly Obstacle[], def: WorldMap, placed = true): void {
  const byKind = new Map<string, Obstacle[]>();
  for (const o of obstacles) {
    const list = byKind.get(o.kind);
    if (list) list.push(o);
    else byKind.set(o.kind, [o]);
  }
  addRocks(chunks, byKind.get('rock') ?? []);
  addTrees(chunks, byKind.get('tree') ?? [], def, placed);
  for (const o of byKind.get('pillar') ?? []) {
    if (o.shape.type !== 'circle') continue;
    const h = lookSeed(o);
    chunks.add(pillarModel(o) ?? 'dungeon_column', { x: o.shape.x, y: o.shape.y, angle: h, fit: { height: o.visual + 12 }, fade: true });
    if (o.visual < 90) chunks.add('dungeon_rubble_half', { x: o.shape.x + o.shape.r * 1.6, y: o.shape.y + o.shape.r * 0.5, angle: h, fit: { radius: 16 } });
  }
  for (const w of byKind.get('wall') ?? []) tileAlong(chunks, w, 'dungeon_wall_broken', 70, true);
  for (const f of byKind.get('fence') ?? []) tileAlong(chunks, f, 'fence_wood_straight', 44);
  for (const h of byKind.get('house') ?? []) {
    if (h.shape.type !== 'box') continue;
    chunks.add(houseModel(h) ?? 'building_home_A_red', { x: h.shape.x, y: h.shape.y, angle: h.shape.angle, fit: { box: { w: h.shape.hw * 2.3, d: h.shape.hh * 2.3 } }, fade: true });
  }
  for (const s of byKind.get('stall') ?? []) if (s.shape.type === 'box') chunks.build(s.shape.x, s.shape.y, Math.hypot(s.shape.hw, s.shape.hh) + 10, (g) => g.add(stall(s)));
  for (const w of byKind.get('well') ?? []) if (w.shape.type === 'circle') chunks.add('building_well_blue', { x: w.shape.x, y: w.shape.y, angle: 0, fit: { radius: w.shape.r * 1.5 } });
  for (const c of byKind.get('chest') ?? []) if (c.shape.type === 'box') chunks.add('dungeon_chest', { x: c.shape.x, y: c.shape.y, angle: c.shape.angle, fit: { box: { w: c.shape.hw * 2.2, d: c.shape.hh * 2.2 } } });
  for (const c of byKind.get('crate') ?? []) if (c.shape.type === 'box') chunks.add('dungeon_crates_stacked', { x: c.shape.x, y: c.shape.y, angle: c.shape.angle, fit: { box: { w: c.shape.hw * 2.4, d: c.shape.hh * 2.4 } } });
}

/**
 * The ground, one tile per chunk. UVs are in world units (one texture repeat per 420), so the
 * pattern runs on across tile edges exactly as it did over the single plane the tiles replace.
 */
/** Linear RGB of a region's ground at a spot, averaged over a 3 by 3 of samples 300 apart so borders blend. */
function regionTint(plan: WorldPlan, x: number, y: number): Color {
  const out = new Color(0, 0, 0);
  const c = new Color();
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      c.setHex(ZONES[plan.regionAt(x + i * 300, y + j * 300)].groundTint);
      out.r += c.r / 9;
      out.g += c.g / 9;
      out.b += c.b / 9;
    }
  }
  return out;
}

/** Ground tiles one per chunk; with `tint`, each tile is a grid whose corners carry the ground colour there. */
function addGroundTiles(chunks: WorldChunks, material: MeshStandardMaterial, x0: number, z0: number, gw: number, gh: number, tint: ((x: number, z: number) => Color) | null = null): void {
  const size = CHUNK_SIZE;
  const REPEAT = 420;
  const SEGMENTS = 8;
  for (let cy = chunkCoord(z0); cy * size < z0 + gh; cy++) {
    for (let cx = chunkCoord(x0); cx * size < x0 + gw; cx++) {
      const ax = Math.max(x0, cx * size);
      const bx = Math.min(x0 + gw, (cx + 1) * size);
      const az = Math.max(z0, cy * size);
      const bz = Math.min(z0 + gh, (cy + 1) * size);
      if (bx <= ax || bz <= az) continue;
      chunks.build((ax + bx) / 2, (az + bz) / 2, 0, (g) => {
        const geo = new BufferGeometry();
        const u = (x: number) => (x - x0) / REPEAT;
        const v = (z: number) => (gh - (z - z0)) / REPEAT;
        const n = tint ? SEGMENTS : 1;
        const pos: number[] = [];
        const uv: number[] = [];
        const col: number[] = [];
        const index: number[] = [];
        for (let j = 0; j <= n; j++) {
          for (let i = 0; i <= n; i++) {
            const x = ax + ((bx - ax) * i) / n;
            const z = az + ((bz - az) * j) / n;
            pos.push(x, 0, z);
            uv.push(u(x), v(z));
            if (tint) {
              const c = tint(x, z);
              col.push(c.r, c.g, c.b);
            }
          }
        }
        // Counter-clockwise seen from above, so the tile faces up.
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const a = j * (n + 1) + i;
            index.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
          }
        }
        geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
        geo.setAttribute('normal', new BufferAttribute(new Float32Array(pos.map((_, k) => (k % 3 === 1 ? 1 : 0))), 3));
        geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
        if (tint) geo.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
        geo.setIndex(index);
        geo.computeBoundingSphere();
        const tile = new Mesh(geo, material);
        tile.receiveShadow = true;
        g.add(tile);
      });
    }
  }
}

interface Landmark {
  group: Group;
  update: (t: number) => void;
  lights: StaticLight[];
  fires: FireSpot[];
}

const ROCKS = ['rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E'];

function addRocks(batch: Placer, rocks: readonly Obstacle[]): void {
  for (const o of rocks) {
    if (o.shape.type !== 'circle') continue;
    const h = lookSeed(o);
    batch.add(ROCKS[h % ROCKS.length] ?? 'rock_single_A', { x: o.shape.x, y: o.shape.y, angle: h / 160, fit: { radius: o.shape.r * 1.15 } });
  }
}

/** Repeats a straight segment asset along a capsule obstacle (walls, fences). */
function tileAlong(batch: Placer, o: Obstacle, asset: string, segment: number, fade = false): void {
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

const TREE_MATERIALS = new WeakMap<WorldChunks, MeshStandardMaterial>();

/** One material for every solid tree of a world, also for the trees a zone's chunks register later. */
function treeMaterial(chunks: WorldChunks): MeshStandardMaterial {
  let m = TREE_MATERIALS.get(chunks);
  if (!m) {
    m = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, transparent: true, opacity: 1 });
    TREE_MATERIALS.set(chunks, m);
  }
  return m;
}

/**
 * Procedural trees, one merged mesh each. Trees near the player fade out, so nobody fights hidden
 * under a canopy. Map themes shift the mix toward dead trees in bleak places. Built per chunk.
 */
/** `placed`: trees from a hand-made layout (the town), whose oaks are listed in `def.oaks`; generated trees get their look from their position. */
function addTrees(chunks: WorldChunks, trees: readonly Obstacle[], def: WorldMap, placed = true): void {
  const byChunk = new Map<number, { x: number; y: number; kind: TreeKind; h: number; size: number }[]>();
  // Shared by every tree of the world while it stands at full opacity; a tree near the hero fades on a copy of its own.
  const solid = treeMaterial(chunks);
  for (const o of trees) {
    if (o.shape.type !== 'circle') continue;
    const { x, y } = o.shape;
    const h = lookSeed(o);
    const listed = placed && def.oaks !== undefined;
    const isOak = listed ? (def.oaks ?? []).some((p) => Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5) : h % 3 === 0;
    const kind: TreeKind = !listed && h % 100 < (bleakAt(def, x, y) ? 35 : 7) ? 'dead' : isOak ? 'oak' : 'pine';
    const size = o.visual * (kind === 'pine' ? 1.05 : 1.25);
    const key = chunkKey(chunkCoord(x), chunkCoord(y));
    const list = byChunk.get(key);
    const tree = { x, y, kind, h, size };
    if (list) list.push(tree);
    else {
      byChunk.set(key, [tree]);
      chunks.build(x, y, 0, (group, anims) => {
        const fading: { x: number; y: number; mesh: Mesh<BufferGeometry, MeshStandardMaterial>; own: MeshStandardMaterial | null; opacity: number }[] = [];
        for (const t of byChunk.get(key) ?? []) {
          const geo = treeGeometry(t.kind, t.h);
          chunks.shared.add(geo);
          const mesh = new Mesh(geo, solid);
          mesh.scale.setScalar(t.size);
          mesh.position.set(t.x, 0, t.y);
          mesh.rotation.y = t.h;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
          if (t.kind !== 'dead') fading.push({ x: t.x, y: t.y, mesh, own: null, opacity: 1 });
        }
        anims.push((_t, px, py) => {
          for (const c of fading) {
            const target = Math.hypot(c.x - px, c.y - py) < 110 ? 0.3 : 1;
            if (target === 1 && c.opacity === 1) continue;
            c.opacity += (target - c.opacity) * 0.15;
            // Back to the shared material once faded in again, so a forest is not a material per tree.
            if (target === 1 && c.opacity > 0.998) {
              c.opacity = 1;
              c.mesh.material = solid;
              // Freed rather than kept: over a long walk most trees fade once and never again.
              c.own?.dispose();
              c.own = null;
              continue;
            }
            const own = c.own ?? solid.clone();
            c.own = own;
            own.opacity = c.opacity;
            own.depthWrite = c.opacity > 0.95;
            c.mesh.material = own;
          }
        });
      });
    }
    chunks.reach(x, y, size);
  }
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
  const cloth = new Mesh(new BoxGeometry(hw * 2 + 10, 4, hh * 2 + 10), mat(stallCloth(o)));
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
  const tex = sharedTexture('swirl', swirlCanvas);
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
 * Textures drawn once and shared by every portal and fire of every world, so rebuilding the world
 * (the town editor, on every edit) makes no new ones. They live as long as the page.
 */
const SHARED_TEXTURES = new Map<string, CanvasTexture>();

function sharedTexture(id: 'swirl' | 'embers', draw: () => HTMLCanvasElement): CanvasTexture {
  const have = SHARED_TEXTURES.get(id);
  if (have) return have;
  const tex = new CanvasTexture(draw());
  // The ember cracks are colour; the swirl has always been read as raw values.
  if (id === 'embers') tex.colorSpace = SRGBColorSpace;
  SHARED_TEXTURES.set(id, tex);
  return tex;
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

interface BuiltFire {
  group: Group;
  update: (t: number) => void;
  light: StaticLight;
  fire: FireSpot;
}

/** A camp fire (and the forge's fire): a ring of stones, crossed charred logs with glowing cracks, and the flames from worldFires. */
function campfire(x: number, y: number, forge: boolean, scale = 1, angle = 0): BuiltFire {
  const g = new Group();
  const stones: Matrix4[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (Math.PI * 2 * i) / 9;
    stones.push(matrix(Math.cos(a) * 22, 4, Math.sin(a) * 22, 8, 7, 8, a));
  }
  const sm = instanced(rockGeometry(3), mat(0x6a6460), stones);
  if (sm) g.add(sm);
  const embers = sharedTexture('embers', emberCanvas);
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
  g.rotation.y = -angle;
  g.scale.setScalar(scale);
  const light = lightAt(FIRE, x, y, scale);
  return {
    group: g,
    update: (t) => {
      bark.emissiveIntensity = 0.9 * staticFlicker(t, x, y, FIRE.flicker * 2);
    },
    light,
    fire: { kind: 'bonfire', x, y, h: 3 * scale, size: (forge ? 0.9 : 1) * scale, pull: 0, lightX: x, lightY: y, flicker: FIRE.flicker, forge },
  };
}

/** Where a brazier's fire burns, at scale 1: the coals in its bowl. */
const BRAZIER_COALS = 33;

/**
 * An iron fire bowl on three splayed legs, for a square or a gate. Its coals glow through the same
 * ember cracks as the camp fire's logs, and the world fires burn on top of them.
 */
function brazier(x: number, y: number, scale = 1, angle = 0): BuiltFire {
  const g = new Group();
  const iron = new MeshStandardMaterial({ color: 0x24211e, roughness: 0.75, metalness: 0.55, side: DoubleSide });
  const legs: Matrix4[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (Math.PI * 2 * i) / 3;
    // Each leg leans out about its own tangent, so the bowl stands on a wide tripod.
    const tilt = new Matrix4().makeRotationAxis(new Vector3(-Math.sin(a), 0, Math.cos(a)), -0.28);
    legs.push(new Matrix4().makeTranslation(Math.cos(a) * 8, 15, Math.sin(a) * 8).multiply(tilt));
  }
  const lm = instanced(new CylinderGeometry(1.2, 1.6, 32, 5), iron, legs);
  if (lm) g.add(lm);
  const bowl = new Mesh(new CylinderGeometry(15, 7, 10, 12, 1, true), iron);
  bowl.position.y = BRAZIER_COALS - 3;
  bowl.castShadow = true;
  const base = new Mesh(new CircleGeometry(7, 12), iron);
  base.rotation.x = -Math.PI / 2;
  base.position.y = BRAZIER_COALS - 8;
  const rim = new Mesh(new TorusGeometry(15, 1.3, 5, 14), iron);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = BRAZIER_COALS + 2;
  const embers = sharedTexture('embers', emberCanvas);
  const coalMat = new MeshStandardMaterial({ color: 0x1a120c, roughness: 1, emissive: 0xff5a1a, emissiveMap: embers, emissiveIntensity: 1, flatShading: true });
  const coals = new Mesh(rockGeometry(11), coalMat);
  coals.scale.set(12, 3, 12);
  coals.position.y = BRAZIER_COALS - 1;
  g.add(bowl, base, rim, coals);
  g.position.set(x, 0, y);
  g.rotation.y = -angle;
  g.scale.setScalar(scale);
  const look = LIT_DECOR.brazier ?? FIRE;
  const light = lightAt(look, x, y, scale);
  return {
    group: g,
    update: (t) => {
      coalMat.emissiveIntensity = 0.9 * staticFlicker(t, x, y, look.flicker * 2);
    },
    light,
    fire: { kind: 'bonfire', x, y, h: BRAZIER_COALS * scale, size: 0.55 * scale, pull: 0, lightX: x, lightY: y, flicker: look.flicker, forge: false },
  };
}

/** Tall decor (a building, a wall, a crypt) cuts a see-through hole when it stands between the camera and the hero. */
function fadesDecor(asset: string): boolean {
  const def = assetById(asset);
  if (!def) return false;
  return def.category === 'building' || def.category === 'wall' || (def.category === 'graveyard' && def.height >= 90);
}

/**
 * A model of something the town editor places that is built in code (the fires, the market stall,
 * the procedural trees), standing at the origin, for the palette's thumbnails. Null for anything
 * that comes from a model file.
 */
export function previewObject(id: string): Object3D | null {
  if (id === 'campfire') return campfire(0, 0, false).group;
  if (id === 'brazier') return brazier(0, 0).group;
  if (id === 'prop:stall') return stall({ kind: 'stall', shape: { type: 'box', x: 0, y: 0, hw: 42, hh: 26, angle: 0 }, blocksMove: true, blocksShots: true, visual: 45 });
  if (id === 'prop:pine' || id === 'prop:oak') {
    const kind: TreeKind = id === 'prop:pine' ? 'pine' : 'oak';
    const tree = new Mesh(treeGeometry(kind, 7), new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }));
    tree.scale.setScalar(kind === 'pine' ? 63 : 77);
    return tree;
  }
  return null;
}

/** A band of big rocks and trees just outside the playable edge, so the map ends in wilderness, not a cliff of nothing. */
function addBorder(chunks: WorldChunks, def: WorldMap, owned: Owned): void {
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
    if (rng.next() < 0.5 && def.theme !== 'town') rocks.push({ kind: 'rock', shape: { type: 'circle', x, y, r: rng.range(40, 70) }, blocksMove: true, blocksShots: true, visual: rng.range(40, 90) });
    else trees.push({ kind: 'tree', shape: { type: 'circle', x, y, r: 16 }, blocksMove: true, blocksShots: true, visual: rng.range(55, 80) });
  }
  addRocks(chunks, rocks);
  addTrees(chunks, trees, def);
  addWildBorder(chunks, def, rng, owned);
}

/** How far the scenery runs past the map edge; the camera sees about this far from the edge. */
const BORDER_DEPTH = 1500;
const BORDER_PEAKS = ['mountain_A_grass_trees', 'mountain_B_grass', 'mountain_C', 'hills_A_trees', 'hills_B'];

/**
 * Forest, rocks and mountains filling the band outside the playable area, so the edge of the world
 * reads as wilderness you cannot cross rather than black. Out of reach, so the trees never need the
 * see-through fade and are instanced per variant: a few draw calls for thousands of trees.
 */
function addWildBorder(chunks: WorldChunks, def: WorldMap, rng: Rng, owned: Owned): void {
  const { width: w, height: h } = def;
  /** Distance outside the map, 0 inside it. */
  const outside = (x: number, y: number): number => Math.max(-x, x - w, -y, y - h, 0);
  // Per chunk, the transforms of each tree variant; each chunk draws one instanced mesh per variant.
  const byChunk = new Map<number, Map<BufferGeometry, Matrix4[]>>();
  const treeMat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
  owned.push(treeMat);
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
      if (roll < 0.05 && def.theme !== 'town') {
        rocks.push({ kind: 'rock', shape: { type: 'circle', x: px, y: py, r: rng.range(35, 75) }, blocksMove: false, blocksShots: false, visual: 60 });
        continue;
      }
      // Thins out far away, where mountains and fog take over.
      if (roll > (d < 700 ? 0.85 : 0.45)) continue;
      const k = hash(px, py);
      const kind: TreeKind = k % 100 < (bleakAt(def, px, py) ? 35 : 6) ? 'dead' : k % 3 === 0 ? 'oak' : 'pine';
      const size = rng.range(55, 90) * (kind === 'pine' ? 1.05 : 1.25);
      const geo = treeGeometry(kind, k);
      chunks.shared.add(geo);
      const key = chunkKey(chunkCoord(px), chunkCoord(py));
      let variants = byChunk.get(key);
      if (!variants) {
        const own = new Map<BufferGeometry, Matrix4[]>();
        variants = own;
        byChunk.set(key, own);
        chunks.build(px, py, 0, (group) => {
          for (const [g, transforms] of own) {
            const m = instanced(g, treeMat, transforms);
            if (!m) continue;
            // Shadows this far out are off-screen or under fog, and thousands of casters are not free.
            m.castShadow = false;
            m.computeBoundingSphere();
            group.add(m);
          }
        });
      }
      const list = variants.get(geo);
      const t = matrix(px, 0, py, size, size, size, k);
      if (list) list.push(t);
      else variants.set(geo, [t]);
      chunks.reach(px, py, size);
    }
  }
  addRocks(chunks, rocks);

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
      chunks.add(asset, { x: at.x + rng.range(-60, 60), y: at.y + rng.range(-60, 60), angle: rng.range(0, 6), fit: { radius: rng.range(depth < 1000 ? 200 : 280, depth < 1000 ? 300 : 420) } });
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

/**
 * Grass tufts, flowers and pebbles: thousands of instances, no collision, placed away from obstacles.
 * Generated per chunk when it is built, from a seed of its own, so a zone's grass costs what is near
 * the camera, and a chunk rebuilt after a release grows the same grass again.
 */
function addGrass(chunks: WorldChunks, def: WorldMap, zone: ZoneWorld | null): void {
  if (def.theme === 'flat') return;
  const palette = [0xf5e663, 0xffffff, 0xe06070, 0x9fb4ff];
  const plazas = def.ground.filter((g) => g.kind === 'plaza' && g.shape.type === 'circle');
  const onPatch = (x: number, y: number): boolean => plazas.some((g) => g.shape.type === 'circle' && Math.hypot(x - g.shape.x, y - g.shape.y) < g.shape.r);
  // The map's own obstacles by the chunk their centre is in; a zone's chunks add theirs when built.
  const planByChunk = new Map<number, Obstacle[]>();
  for (const o of def.obstacles) {
    const c = shapeCentre(o.shape);
    const key = chunkKey(chunkCoord(c.x), chunkCoord(c.y));
    const list = planByChunk.get(key);
    if (list) list.push(o);
    else planByChunk.set(key, [o]);
  }
  const grassColor = new Color(def.groundTint).offsetHSL(0.01, -0.02, 0.02).getHex();
  // Shared by every chunk, so a chunk released and rebuilt reuses them.
  const cone = new ConeGeometry(1, 1, 3);
  const ico = new IcosahedronGeometry(1, 0);
  chunks.shared.add(cone);
  chunks.shared.add(ico);
  const grassMat = mat(grassColor, { rough: 1 });
  // In the world, tufts take the colour of the region their chunk is in.
  const plan = zone?.plan;
  const grassAt = (x: number, y: number) => (plan ? mat(new Color(ZONES[plan.regionAt(x, y)].groundTint).offsetHSL(0.01, -0.02, 0.02).getHex(), { rough: 1 }) : grassMat);
  const flowerMat = mat(0xffffff, { emissive: 0x202020 });
  const pebbleMat = mat(0x7a7468);
  const size = CHUNK_SIZE;
  for (let cy = 0; cy * size < def.height; cy++) {
    for (let cx = 0; cx * size < def.width; cx++) {
      const x0 = Math.max(20, cx * size);
      const x1 = Math.min(def.width - 20, (cx + 1) * size);
      const y0 = Math.max(20, cy * size);
      const y1 = Math.min(def.height - 20, (cy + 1) * size);
      if (x1 <= x0 || y1 <= y0) continue;
      // One tuft, flower or pebble roll per 9000 square units, as across the whole map before.
      const count = Math.floor(((x1 - x0) * (y1 - y0)) / 9000);
      chunks.build((x0 + x1) / 2, (y0 + y1) / 2, 0, (group) => {
        // Obstacles whose centre is within 70 of the chunk: the map's and, in a zone, those of the
        // chunk and its neighbours (no chunk's trees stand further out than that).
        const near: Obstacle[] = [];
        for (let j = cy - 1; j <= cy + 1; j++) {
          for (let i = cx - 1; i <= cx + 1; i++) {
            near.push(...(planByChunk.get(chunkKey(i, j)) ?? []));
            if (zone) near.push(...zone.obstacles(i, j));
          }
        }
        const nearObstacle = obstacleGrid(near, 70);
        const rng = new Rng((Math.imul(cx + 7919, 73856093) ^ Math.imul(cy + 104729, 19349663) ^ Math.imul(def.width, 83492791)) >>> 0);
        const grass: Matrix4[] = [];
        const flowers: Matrix4[] = [];
        const flowerColors: Color[] = [];
        const pebbles: Matrix4[] = [];
        for (let i = 0; i < count; i++) {
          const x = rng.range(x0, x1);
          const y = rng.range(y0, y1);
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
        for (const m of [instanced(cone, grassAt((x0 + x1) / 2, (y0 + y1) / 2), grass), instanced(ico, flowerMat, flowers, flowerColors), instanced(ico, pebbleMat, pebbles)]) {
          if (!m) continue;
          // Decor is too small to cast useful shadows and there are thousands of instances.
          m.castShadow = false;
          m.computeBoundingSphere();
          group.add(m);
        }
      });
    }
  }
}

/**
 * Whether any obstacle's centre is within `d` on both axes of a point: the same test as a scan over
 * every obstacle, answered from a grid of `d`-sized cells, so decor placement stays linear in zone size.
 */
function obstacleGrid(obstacles: readonly Obstacle[], d: number): (x: number, y: number) => boolean {
  const cells = new Map<number, { x: number; y: number }[]>();
  const keyOf = (cx: number, cy: number) => chunkKey(cx, cy);
  for (const o of obstacles) {
    const c = shapeCentre(o.shape);
    const key = keyOf(Math.floor(c.x / d), Math.floor(c.y / d));
    const list = cells.get(key);
    if (list) list.push(c);
    else cells.set(key, [c]);
  }
  return (x, y) => {
    const cx = Math.floor(x / d);
    const cy = Math.floor(y / d);
    for (let j = cy - 1; j <= cy + 1; j++) {
      for (let i = cx - 1; i <= cx + 1; i++) {
        for (const c of cells.get(keyOf(i, j)) ?? []) if (Math.abs(c.x - x) < d && Math.abs(c.y - y) < d) return true;
      }
    }
    return false;
  };
}

// ---------------------------------------------------------------------------------------------
// Dungeons

/**
 * Flagstone quads and rock wall boxes, merged into one floor and one wall mesh per chunk, with UVs
 * in world space so the texture never stretches and runs on across chunk edges.
 */
function addUnderground(chunks: WorldChunks, def: WorldMap, owned: Owned): void {
  const floorMat = new MeshStandardMaterial({ map: repeatTexture(stoneCanvas(), 1, 1, owned), color: 0xd0c4b4, roughness: 0.95 });
  const wallMat = withOccluderFade(new MeshStandardMaterial({ map: repeatTexture(stoneCanvas(), 1, 1, owned), color: 0x8a7e72, roughness: 1, side: DoubleSide }));
  owned.push(floorMat, wallMat);
  const byChunk = new Map<number, { floors: Extract<Shape, { type: 'box' }>[]; walls: Extract<Shape, { type: 'box' }>[] }>();
  const at = (x: number, y: number, reach: number) => {
    const key = chunkKey(chunkCoord(x), chunkCoord(y));
    let c = byChunk.get(key);
    if (!c) {
      const own: { floors: Extract<Shape, { type: 'box' }>[]; walls: Extract<Shape, { type: 'box' }>[] } = { floors: [], walls: [] };
      c = own;
      byChunk.set(key, own);
      chunks.build(x, y, 0, (group) => buildUnderground(group, own.floors, own.walls, floorMat, wallMat));
    }
    chunks.reach(x, y, reach);
    return c;
  };
  for (const patch of def.ground) {
    if (patch.kind !== 'floor' || patch.shape.type !== 'box') continue;
    at(patch.shape.x, patch.shape.y, Math.hypot(patch.shape.hw, patch.shape.hh)).floors.push(patch.shape);
  }
  for (const o of def.obstacles) {
    if (o.kind !== 'cavewall' || o.shape.type !== 'box') continue;
    at(o.shape.x, o.shape.y, Math.hypot(o.shape.hw, o.shape.hh)).walls.push(o.shape);
  }
}

function buildUnderground(group: Group, floors: readonly Extract<Shape, { type: 'box' }>[], walls: readonly Extract<Shape, { type: 'box' }>[], floorMat: MeshStandardMaterial, wallMat: MeshStandardMaterial): void {
  const tile = 160;
  const floorPos: number[] = [];
  const floorUv: number[] = [];
  const floorIdx: number[] = [];
  for (const { x, y, hw, hh } of floors) {
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
  if (floorIdx.length > 0) {
    const floorGeo = new BufferGeometry();
    floorGeo.setAttribute('position', new BufferAttribute(new Float32Array(floorPos), 3));
    floorGeo.setAttribute('uv', new BufferAttribute(new Float32Array(floorUv), 2));
    floorGeo.setIndex(floorIdx);
    floorGeo.computeVertexNormals();
    const floor = new Mesh(floorGeo, floorMat);
    floor.receiveShadow = true;
    group.add(floor);
  }

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
  for (const { x, y, hw, hh } of walls) {
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
  if (idx.length === 0) return;
  const wallGeo = new BufferGeometry();
  wallGeo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  wallGeo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  wallGeo.setIndex(idx);
  wallGeo.computeVertexNormals();
  const wallMesh = new Mesh(wallGeo, wallMat);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  group.add(wallMesh);
}
