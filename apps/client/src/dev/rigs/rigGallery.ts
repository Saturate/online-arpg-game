import { ENEMIES, MINION_DEFS, MINION_TYPE_IDS, type EnemyTypeId, type MinionTypeId } from '@rune/shared';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  CanvasTexture,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PointLight,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { AnimRole } from '../../render/assets.js';
import { MINION_ASSETS } from '../../render/characters.js';
import { COLORS, VIEW } from '../../render/config.js';
import { applyGrit } from '../../render/grit.js';
import { beginRigFrame, buildEnemy, buildMinion, driveRig, enemyModel, minionModel, rigAttack, rigHit, rigReset, rigSpawn, rigWindup, type Rig, type RigDrive } from '../../render/models.js';
import { PROCEDURAL_ENEMIES } from './rigBench.js';

applyGrit();

export const GALLERY_ROLES: readonly AnimRole[] = ['idle', 'walk', 'run', 'attack', 'cast', 'shoot', 'hit', 'death', 'dormant', 'awaken', 'spawn'];

export interface GalleryEntry {
  key: string;
  label: string;
  radius: number;
  speed: number;
  build: () => Rig;
  /** The same model uncompiled, one mesh per part, to check the compiled one against. */
  raw: () => Rig;
}

export const GALLERY_ENTRIES: readonly GalleryEntry[] = [
  ...PROCEDURAL_ENEMIES.map((id: EnemyTypeId): GalleryEntry => {
    const def = ENEMIES[id];
    return { key: id, label: def.name, radius: def.radius, speed: def.moveSpeed, build: () => enemyModel(id, def.color), raw: () => buildEnemy(id, def.color) };
  }),
  ...MINION_TYPE_IDS.filter((id) => MINION_ASSETS[id] === undefined).map((id: MinionTypeId): GalleryEntry => {
    const def = MINION_DEFS[id];
    return { key: `minion_${id}`, label: `${def.name} (minion)`, radius: def.radius, speed: def.moveSpeed, build: () => minionModel(id, def.color), raw: () => buildMinion(id, def.color) };
  }),
];

/**
 * The wilds rig from render/scene.ts, day and deep night at the default night brightness (0.6):
 * night keeps 0.3 + 0.7 * 0.6 of the light, then the night dim of 0.75, moonlight for the sun, and
 * the hero's light turned up into the D2 light radius.
 */
const DAY = { hemi: 1.3, ambient: 0.55, sun: 2.55, sunColor: 0xf2e4ca, exposure: 1.52, hero: 2, heroDistance: 520, heroDecay: 1.4 };
const KEEP = 0.3 + 0.7 * 0.6;
const NIGHT = {
  hemi: DAY.hemi * KEEP * 0.75,
  ambient: DAY.ambient * Math.min(1, KEEP + 0.2) * 0.75,
  sun: DAY.sun * KEEP * 0.8 * 0.75,
  sunColor: 0x7488c8,
  exposure: DAY.exposure * 0.8,
  hero: DAY.hero * 3,
  heroDistance: 700,
  heroDecay: 0.9,
};

/** Ground disc radius in collision radii: wide enough that a death view never sees past its edge. */
const GROUND = 16;
/** Cells sit this far apart in the one shared scene, so no model's light or reach spills over. */
const SPACING = 1200;
const DEG = Math.PI / 180;

interface Cell {
  entry: GalleryEntry;
  el: HTMLElement;
  rig: Rig;
  x: number;
  role: AnimRole;
  /** Seconds into the role's loop. */
  t: number;
  ground: Mesh;
  groundMat: MeshStandardMaterial;
  drive: RigDrive;
  labelEl: HTMLElement | null;
  /** Rest-pose size in root space. */
  extent: { tall: number; wide: number };
}

/** Whether a loop of `loop` seconds passed its mark `at` between two times. */
function passed(prev: number, now: number, at: number, loop: number): boolean {
  return Math.floor((prev - at) / loop) < Math.floor((now - at) / loop);
}

/** Cells start just before zero, so marks at the start of a loop fire on the first frame. */
const START = -1e-6;

/** A dirt texture with faint furrows, so the treadmill under a walking model shows its speed. */
function dirtTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#4c5236';
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 260; i++) {
      const v = 50 + Math.floor(Math.random() * 40);
      g.fillStyle = `rgba(${v}, ${v - 8}, ${v - 26}, 0.55)`;
      g.fillRect(Math.random() * 128, Math.random() * 128, 2 + Math.random() * 5, 1 + Math.random() * 3);
    }
    // Faint furrows across the direction of travel.
    g.fillStyle = 'rgba(24, 22, 14, 0.28)';
    g.fillRect(0, 0, 2, 128);
    g.fillRect(64, 0, 1, 128);
  }
  const t = new CanvasTexture(c);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  return t;
}

/**
 * Every procedural monster in its own small viewport, drawn by one renderer into one canvas with
 * a scissor per cell. Each cell loops one role through the same driver and events the game uses.
 */
export class RigGallery {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: OrthographicCamera;
  private readonly hemi: HemisphereLight;
  private readonly ambient: AmbientLight;
  private readonly sun: DirectionalLight;
  private readonly hero: PointLight;
  private readonly cells: Cell[] = [];
  private readonly offset: Vector3;
  private readonly dirt = dirtTexture();
  private raf = 0;
  private last = performance.now();
  private night = false;
  paused = false;

  constructor(
    private readonly canvasHost: HTMLElement,
    /** The scrolling viewport; cells outside it are not drawn. */
    private readonly grid: HTMLElement,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.setScissorTest(true);
    this.renderer.domElement.className = 'rigs-canvas';
    canvasHost.appendChild(this.renderer.domElement);
    this.scene.background = new Color(COLORS.background);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 1, 4000);
    const yaw = VIEW.yawDegrees * DEG;
    const pitch = VIEW.pitchDegrees * DEG;
    this.offset = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(1200);
    this.hemi = new HemisphereLight(0xa6aeb6, 0x30251a, DAY.hemi);
    this.ambient = new AmbientLight(0x505060, DAY.ambient);
    this.sun = new DirectionalLight(DAY.sunColor, DAY.sun);
    this.hero = new PointLight(0xffd6a0, DAY.hero, DAY.heroDistance, DAY.heroDecay);
    this.scene.add(this.hemi, this.ambient, this.sun, this.sun.target, this.hero);
    this.setNight(false);
    beginRigFrame(null);
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Adds a cell drawing `entry` into `el`, which the page lays out. */
  add(entry: GalleryEntry, el: HTMLElement, labelEl: HTMLElement | null, role: AnimRole, raw = false): void {
    const i = this.cells.length;
    const rig = raw ? entry.raw() : entry.build();
    rig.root.scale.multiplyScalar(entry.radius);
    const x = i * SPACING;
    rig.root.position.set(x, 0, 0);
    // Facing the camera's left, three quarters on, so strides and strikes read in profile.
    rig.root.rotation.y = -Math.PI * 0.08;
    this.scene.add(rig.root);
    const groundMat = new MeshStandardMaterial({ map: this.dirt.clone(), roughness: 1 });
    const ground = new Mesh(new CircleGeometry(entry.radius * GROUND, 32), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(x, 0, 0);
    const map = groundMat.map;
    if (map) map.repeat.set((entry.radius * GROUND) / 48, (entry.radius * GROUND) / 48);
    this.scene.add(ground);
    const stored: unknown = rig.root.userData.extent;
    const e = Array.isArray(stored) ? stored.filter((v): v is number => typeof v === 'number') : [];
    const [x0 = -1, x1 = 1, y0 = 0, y1 = 2, z0 = -1, z1 = 1] = e;
    const extent = { tall: y1 - Math.min(0, y0), wide: Math.max(x1 - x0, z1 - z0) };
    this.cells.push({ entry, el, rig, x, role, t: START, ground, groundMat, drive: { speed: 0, dead: false, dormant: false, hidden: false, dt: 0, seed: i * 1.37 }, labelEl, extent });
  }

  setRole(index: number, role: AnimRole): void {
    const c = this.cells[index];
    if (!c) return;
    c.role = role;
    c.t = START;
    rigReset(c.rig);
    c.drive.dead = false;
    c.drive.dormant = false;
  }

  setAll(role: AnimRole): void {
    for (let i = 0; i < this.cells.length; i++) this.setRole(i, role);
  }

  /**
   * Restarts every cell's role and plays it to `seconds` in fixed 60 Hz steps, then holds, so a
   * screenshot lands on the same moment every time. `play()` lets it run again.
   */
  seek(seconds: number): void {
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      if (c) this.setRole(i, c.role);
    }
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) for (const c of this.cells) this.step(c, dt);
    this.paused = true;
  }

  play(): void {
    this.paused = false;
  }

  setNight(night: boolean): void {
    this.night = night;
    const l = night ? NIGHT : DAY;
    this.hemi.intensity = l.hemi;
    this.ambient.intensity = l.ambient;
    this.sun.intensity = l.sun;
    this.sun.color.setHex(l.sunColor);
    this.hero.intensity = l.hero;
    this.hero.distance = l.heroDistance;
    this.hero.decay = l.heroDecay;
    this.renderer.toneMappingExposure = l.exposure;
  }

  get isNight(): boolean {
    return this.night;
  }

  /** Steps every cell's role loop: the inputs the game would feed the rig at that moment. */
  private step(c: Cell, dt: number): void {
    const prev = c.t;
    c.t += dt;
    const now = c.t;
    const d = c.drive;
    const crossed = (at: number, loop: number): boolean => passed(prev, now, at, loop);
    d.speed = 0;
    d.dormant = false;
    const moves = c.entry.speed > 0;
    switch (c.role) {
      case 'idle':
        break;
      case 'walk':
        // Walk at the monster's own speed, kept under the run threshold.
        d.speed = moves ? Math.min(180, Math.max(40, c.entry.speed)) : 0;
        break;
      case 'run':
        d.speed = moves ? 240 : 0;
        break;
      case 'attack':
        if (crossed(0, 2.6)) rigWindup(c.rig, 0.7, 'ability', d.seed);
        if (crossed(0.7, 2.6)) rigAttack(c.rig, d.seed);
        if (crossed(1.8, 2.6)) rigAttack(c.rig, d.seed);
        break;
      case 'cast':
        if (crossed(0, 2)) rigWindup(c.rig, 0.8, 'cast', d.seed);
        if (crossed(0.8, 2)) rigAttack(c.rig, d.seed);
        break;
      case 'shoot':
        if (crossed(0, 1.8)) rigWindup(c.rig, 0.55, 'shoot', d.seed);
        if (crossed(0.55, 1.8)) rigAttack(c.rig, d.seed);
        break;
      case 'hit':
        if (crossed(0.1, 0.9)) rigHit(c.rig, d.seed);
        break;
      case 'death':
        if (crossed(0, 4)) {
          rigReset(c.rig);
          d.dead = false;
        }
        if (crossed(0.6, 4)) d.dead = true;
        break;
      case 'dormant':
        d.dormant = true;
        break;
      case 'awaken':
        d.dormant = ((c.t % 3) + 3) % 3 < 1.4;
        break;
      case 'spawn':
        if (crossed(0.2, 2.4)) rigSpawn(c.rig, d.seed);
        break;
    }
    d.dt = dt;
    driveRig(c.rig, d);
    const map = c.groundMat.map;
    // The ground slides back under the model at its speed, like the world passing a walker.
    if (map) map.offset.x -= ((d.speed * dt) / (c.entry.radius * GROUND * 2)) * map.repeat.x;
    if (c.labelEl) c.labelEl.textContent = c.rig.motion?.label ?? c.role;
  }

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.paused) for (const c of this.cells) this.step(c, dt);
    this.draw();
  };

  private draw(): void {
    const host = this.canvasHost;
    const w = host.clientWidth;
    const h = host.clientHeight;
    const canvas = this.renderer.domElement;
    if (canvas.width !== Math.floor(w * this.renderer.getPixelRatio()) || canvas.height !== Math.floor(h * this.renderer.getPixelRatio())) this.renderer.setSize(w, h, false);
    const hostRect = host.getBoundingClientRect();
    const view = this.grid.getBoundingClientRect();
    this.renderer.setScissor(0, 0, w, h);
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.setClearColor(0x0b0a08, 1);
    this.renderer.clear();
    this.renderer.setClearColor(COLORS.background, 1);
    for (const c of this.cells) {
      const r = c.el.getBoundingClientRect();
      if (r.bottom < view.top || r.top > view.bottom || r.width <= 0) continue;
      const left = r.left - hostRect.left;
      const bottom = hostRect.bottom - r.bottom;
      this.renderer.setViewport(left, bottom, r.width, r.height);
      this.renderer.setScissor(left, bottom, r.width, r.height);
      // Framed on the model's rest size, with room for a swing or a fall.
      const s = c.rig.root.scale.y;
      const tall = c.extent.tall * s;
      const wide = c.extent.wide * s;
      // A corpse lies out along the ground, so the death view widens and follows the fall forward.
      const dying = c.role === 'death';
      const half = Math.max(tall * 0.8, wide * 0.72, 12) * (dying ? 1.15 : 1);
      const aspect = r.width / r.height;
      Object.assign(this.camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
      this.camera.updateProjectionMatrix();
      const cy = tall * 0.36;
      const ahead = dying && c.rig.profile.death === 'collapse' ? tall * 0.45 : 0;
      const fx = c.x + Math.cos(c.rig.root.rotation.y) * ahead;
      const fz = -Math.sin(c.rig.root.rotation.y) * ahead;
      this.camera.position.set(fx + this.offset.x, cy + this.offset.y, fz + this.offset.z);
      this.camera.lookAt(fx, cy, fz);
      // The hero stands at melee distance in front of each monster, its light 120 up as in scene.ts.
      this.hero.position.set(c.x + 35, 120, 45);
      this.sun.position.set(c.x - 400, 900, 250);
      this.sun.target.position.set(c.x, 0, 0);
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const c of this.cells) {
      for (const r of c.rig.owned) r.dispose();
      c.groundMat.map?.dispose();
      c.groundMat.dispose();
      c.ground.geometry.dispose();
    }
    this.dirt.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
