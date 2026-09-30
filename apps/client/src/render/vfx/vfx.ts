import { Color, DoubleSide, Group, Mesh, MeshBasicMaterial, AdditiveBlending, PlaneGeometry, RingGeometry, SphereGeometry, Vector3, type Camera, type IUniform, type Material, type Scene, type ShaderMaterial, type WebGLRenderer } from 'three';
import { RENDER_ORDER } from '../config.js';
import { darkness, type NightMode } from '../daylight.js';
import { emitLight, entityLightKey, lightKey } from '../lights.js';
import { ParticleBudget } from './budget.js';
import { auraMaterial, hostileMaterial, novaMaterial, orbMaterial, plainAreaMaterial, tetherMaterial, zoneMaterial, type NovaUniforms, type SharedUniforms } from './materials.js';
import { PALETTE, STYLES, type StylePalette, type VfxStyle } from './palette.js';
import { ParticleLayer } from './particleLayer.js';
import { emptySpec, SHAPE, type ParticleSpec } from './pool.js';
import { QUALITY, type QualityLevel, type VfxQuality } from './quality.js';
import { RibbonBatch } from './ribbons.js';
import { WorldFires, type FireHost } from './worldFires.js';

interface Wave {
  mesh: Mesh<PlaneGeometry | RingGeometry, ShaderMaterial | MeshBasicMaterial>;
  /** The nova shader's uniforms; null for the flat Low ring. */
  u: NovaUniforms | null;
  basic: MeshBasicMaterial | null;
  style: VfxStyle | null;
  age: number;
  duration: number;
  radius: number;
  busy: boolean;
}

const MAX_WAVES = 32;
/** Short light bursts alive at once; the oldest is replaced. */
const MAX_FLASHES = 24;
/** x, y, height, colour, intensity, radius, age, duration, day share. */
const FLASH_FIELDS = 9;
/** Share of a spell's light kept by full day, so a fireball still lights the ground at noon. */
export const SPELL_DAY_LIGHT = 0.35;
/** Lightning keeps less: its pale yellow light washed the sunlit ground out. */
export const LIGHTNING_DAY_LIGHT = 0.2;
/** Chill glints are pale grey ice, not the cold body blue, which read as sparks. */
const CHILL_GLINT = new Color(0xbfd8e8);
/**
 * Poison: a bile green drip and a low murky mist. Kept dark and yellowed (swamp water, not neon
 * slime) so it reads at night by the hero's light without glowing like a spell.
 */
const POISON_DRIP = new Color(0x7c9436);
const POISON_DRIP_DEEP = new Color(0x3a4a18);
const POISON_MIST = new Color(0x4a5a2c);

export function dayLightOf(style: VfxStyle | null): number {
  return style === 'lightning' ? LIGHTNING_DAY_LIGHT : SPELL_DAY_LIGHT;
}
/** Zones remembered per frame for sharing glow between stacked copies. */
const MAX_ZONE_CLAIMS = 128;
const TAU = Math.PI * 2;
const tmpColor = new Color();
const camDir = new Vector3();

/** A distance from a disk's centre that spreads points evenly over its area. */
function inDisk(r: number): number {
  return Math.sqrt(Math.random()) * r * 0.92;
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/**
 * The spell effects system: two particle layers (additive glow, alpha smoke), a ground decal
 * layer (scorch marks), spell light through the shared light budget, the ribbon trails, a pool of shockwave meshes, the
 * particle budget and the quality level. Spell views and events call the emitters below; nothing
 * here allocates per frame.
 */
export class Vfx implements FireHost {
  quality: VfxQuality;
  level: QualityLevel;
  readonly shared: SharedUniforms = { uTime: { value: 0 }, uNight: { value: 0 } };
  readonly budget: ParticleBudget;
  private glow: ParticleLayer;
  private smoke: ParticleLayer;
  private groundDark: ParticleLayer;
  ribbons: RibbonBatch;
  /** Torches, lamps and camp fires of the world on screen; kept across quality changes. */
  readonly fires: WorldFires;
  private readonly waves: Wave[] = [];
  private readonly spec: ParticleSpec = emptySpec();
  private readonly waveGeo = new PlaneGeometry(2, 2);
  private readonly ringGeo = new RingGeometry(0.8, 1, 48);
  private readonly warmGeo = new SphereGeometry(1, 4, 3);
  private begun = false;
  private nightMode: NightMode = 'outdoors';
  /** Ground point the camera looks at and a generous radius around it, for skipping off-screen emitters. */
  private readonly focus = { x: 0, y: 0, r: 900 };
  /** Night factor, 0 to 1. Underground counts as night (effects are the light there), flat maps as day. */
  night = 0;
  /** This frame's zones: x, y, r, style, weight. See zoneShare. */
  private readonly claims = new Float32Array(MAX_ZONE_CLAIMS * 5);
  private claimCount = 0;
  private readonly flashes = new Float64Array(MAX_FLASHES * FLASH_FIELDS);
  private readonly flashKeys = Array.from({ length: MAX_FLASHES }, () => lightKey());
  private flashCursor = 0;
  /**
   * Materials that compiled this level's programs ahead of time. Kept alive, never drawn: three
   * frees a program when the last material using it is disposed, and the next spell would then
   * compile it again mid-fight.
   */
  private warmMats: Material[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    quality: VfxQuality,
  ) {
    this.quality = quality;
    this.level = QUALITY[quality];
    this.budget = new ParticleBudget(this.level);
    const layers = this.makeLayers(this.level);
    this.glow = layers.glow;
    this.smoke = layers.smoke;
    this.groundDark = layers.groundDark;
    this.ribbons = new RibbonBatch(this.level.ribbons ? 256 : 1, this.shared.uTime);
    this.fires = new WorldFires(camera, this.shared.uTime);
    this.scene.add(this.fires.mesh);
    this.addLayers();
  }

  private makeLayers(level: QualityLevel): { glow: ParticleLayer; smoke: ParticleLayer; groundDark: ParticleLayer } {
    const t = this.shared.uTime;
    return {
      glow: new ParticleLayer(level.glowCapacity, Math.max(400, Math.round(level.glowCapacity / 2)), true, t),
      smoke: new ParticleLayer(level.smokeCapacity, 400, false, t),
      groundDark: new ParticleLayer(Math.max(1, level.groundCapacity), 16, false, t, true),
    };
  }

  private addLayers(): void {
    this.scene.add(this.groundDark.mesh, this.smoke.mesh, this.glow.mesh, this.ribbons.mesh);
  }

  private removeLayers(): void {
    this.scene.remove(this.groundDark.mesh, this.smoke.mesh, this.glow.mesh, this.ribbons.mesh);
    for (const l of [this.glow, this.smoke, this.groundDark]) l.dispose();
    this.ribbons.dispose();
  }

  /**
   * Rebuilds the pools for a new quality. Live particles are dropped; spell views rebuild themselves.
   * Returns whether the quality changed.
   */
  setQuality(q: VfxQuality): boolean {
    if (q === this.quality) return false;
    this.removeLayers();
    this.quality = q;
    this.level = QUALITY[q];
    this.budget.setLevel(this.level);
    const layers = this.makeLayers(this.level);
    this.glow = layers.glow;
    this.smoke = layers.smoke;
    this.groundDark = layers.groundDark;
    this.ribbons = new RibbonBatch(this.level.ribbons ? 256 : 1, this.shared.uTime);
    this.addLayers();
    for (const w of this.waves) {
      this.scene.remove(w.mesh);
      w.mesh.material.dispose();
    }
    this.waves.length = 0;
    return true;
  }

  /**
   * Compiles every spell shader this quality can draw, by kind and style, before the fight needs
   * them: each first appearance of a (kind, style) otherwise stalled a frame for its compile. Call
   * when a room is built and after a quality change. Throwaway meshes are added for the compile
   * only; their materials are kept (see warmMats).
   */
  warm(renderer: WebGLRenderer): void {
    for (const m of this.warmMats) m.dispose();
    const mats: Material[] = [];
    if (this.level.shaders) {
      for (const style of STYLES) {
        mats.push(zoneMaterial(style, this.shared).material, novaMaterial(style, this.shared).material, orbMaterial(style, this.shared).material, auraMaterial(style, this.shared).material);
      }
      mats.push(tetherMaterial(this.shared).material);
    } else {
      mats.push(plainAreaMaterial(0xffffff, 0.9).material);
    }
    mats.push(hostileMaterial('circle', 0xffffff).material, hostileMaterial('line', 0xffffff).material);
    this.warmMats = mats;
    const group = new Group();
    // Tiny and under the ground, in case a frame draws before the compile finishes.
    group.position.set(this.focus.x, -50, this.focus.y);
    group.scale.setScalar(1e-3);
    for (const m of mats) group.add(new Mesh(this.warmGeo, m));
    this.scene.add(group);
    const done = (): void => {
      this.scene.remove(group);
    };
    renderer.compileAsync(this.scene, this.camera).then(done, done);
  }

  /** Day and night for the map on screen (`nightModeOf`); set by Effects from the world scene. */
  setNightMode(mode: NightMode): void {
    this.nightMode = mode;
  }

  /**
   * Starts a frame: advances the clock, steps the pools and sets the budget. Sprites written after
   * this are drawn this frame. Safe to call more than once a frame; only the first call counts.
   */
  begin(dt: number): void {
    if (this.begun) return;
    this.begun = true;
    this.claimCount = 0;
    this.shared.uTime.value += dt;
    this.night = darkness(this.nightMode);
    this.shared.uNight.value = this.night;
    this.budget.beginFrame(dt, Math.max(this.glow.fullness, this.smoke.fullness));
    this.glow.step(dt);
    this.smoke.step(dt);
    this.groundDark.step(dt);
    this.updateFocus();
    this.updateWaves(dt);
    this.updateFlashes(dt);
    this.fires.update(dt, this);
    // Glows are brighter at night, where they are the light; by day they back off so they never clip.
    const gain = 0.55 + 0.3 * this.night;
    this.glow.uniforms.uGain.value = gain;
    this.ribbons.uniforms.uGain.value = gain;
  }

  /** Ends a frame: uploads the particle buffers and builds the ribbons. */
  commit(): void {
    if (!this.begun) this.begin(0);
    this.begun = false;
    this.glow.commit();
    this.smoke.commit();
    this.groundDark.commit();
    if (this.level.ribbons) this.ribbons.update(this.time, this.camera);
  }

  get time(): number {
    return this.shared.uTime.value;
  }

  get focusX(): number {
    return this.focus.x;
  }

  get focusY(): number {
    return this.focus.y;
  }

  spawnGlow(s: ParticleSpec): boolean {
    return this.glow.pool.spawn(s);
  }

  spawnSmoke(s: ParticleSpec): boolean {
    return this.smoke.pool.spawn(s);
  }

  get particleCount(): number {
    return this.glow.pool.count + this.smoke.pool.count;
  }

  private updateFocus(): void {
    const cam = this.camera;
    cam.getWorldDirection(camDir);
    if (Math.abs(camDir.y) < 1e-4) return;
    const t = -cam.position.y / camDir.y;
    this.focus.x = cam.position.x + camDir.x * t;
    this.focus.y = cam.position.z + camDir.z * t;
  }

  /** Whether a point is near enough to the screen to be worth emitting ambient particles for. */
  onScreen(x: number, y: number, margin = 0): boolean {
    const dx = x - this.focus.x;
    const dy = y - this.focus.y;
    const r = this.focus.r + margin;
    return dx * dx + dy * dy < r * r;
  }

  // -------------------------------------------------------------------------------------------
  // Low-level spawning

  private colours(start: Color, startScale: number, a0: number, end: Color, endScale: number, a1: number): void {
    const s = this.spec;
    s.r0 = start.r * startScale;
    s.g0 = start.g * startScale;
    s.b0 = start.b * startScale;
    s.a0 = a0;
    s.r1 = end.r * endScale;
    s.g1 = end.g * endScale;
    s.b1 = end.b * endScale;
    s.a1 = a1;
  }

  private motion(x: number, h: number, y: number, vx: number, vh: number, vy: number, gravity: number, drag: number): void {
    const s = this.spec;
    s.x = x;
    s.y = h;
    s.z = y;
    s.vx = vx;
    s.vy = vh;
    s.vz = vy;
    s.gravity = gravity;
    s.drag = drag;
  }

  private look(life: number, size0: number, size1: number, shape: number, stretch = 0): void {
    const s = this.spec;
    s.life = life;
    s.size0 = size0;
    s.size1 = size1;
    s.shape = shape;
    s.stretch = stretch;
  }

  /** A one-frame sprite in the alpha layer: solid shapes that must read on bright ground. */
  solidSprite(x: number, h: number, y: number, size: number, color: Color, alpha: number, shape: number = SHAPE.disc): void {
    writeSprite(this.smoke, x, h, y, size, color, alpha, shape);
  }

  /** A one-frame sprite in the glow layer: projectile cores, halos, flashes. */
  glowSprite(x: number, h: number, y: number, size: number, color: Color, intensity: number, shape: number = SHAPE.glow): void {
    writeSprite(this.glow, x, h, y, size, color, intensity, shape);
  }

  /**
   * Light from a spell this frame, through the shared light budget (render/lights.ts): the few
   * strongest near the camera become real lights, the rest pools on the ground. `key` must stay the
   * same for a source across frames (entityLightKey) so its light fades instead of popping. Spells
   * keep a third of their light by day. Low quality sends none.
   */
  light(key: number, x: number, y: number, height: number, color: Color, intensity: number, radius: number, style: VfxStyle | null = null): void {
    if (!this.level.groundLight || intensity <= 0.01) return;
    emitLight(key, x, y, height, color.getHex(), intensity, radius, 0, dayLightOf(style));
  }

  /** A short burst of light that dies out over `duration`: impacts, explosions, lightning. */
  flash(x: number, y: number, height: number, color: Color, intensity: number, radius: number, duration: number, style: VfxStyle | null = null): void {
    if (!this.level.groundLight) return;
    const i = this.flashCursor;
    this.flashCursor = (i + 1) % MAX_FLASHES;
    const f = this.flashes;
    const o = i * FLASH_FIELDS;
    f[o] = x;
    f[o + 1] = y;
    f[o + 2] = height;
    f[o + 3] = color.getHex();
    f[o + 4] = intensity;
    f[o + 5] = radius;
    f[o + 6] = 0;
    f[o + 7] = duration;
    f[o + 8] = dayLightOf(style);
  }

  private updateFlashes(dt: number): void {
    const f = this.flashes;
    for (let i = 0; i < MAX_FLASHES; i++) {
      const o = i * FLASH_FIELDS;
      const dur = f[o + 7] ?? 0;
      if (dur <= 0) continue;
      const age = (f[o + 6] ?? 0) + dt;
      if (age >= dur) {
        f[o + 7] = 0;
        continue;
      }
      f[o + 6] = age;
      const k = 1 - age / dur;
      emitLight(this.flashKeys[i] ?? 0, f[o] ?? 0, f[o + 1] ?? 0, f[o + 2] ?? 0, f[o + 3] ?? 0xffffff, (f[o + 4] ?? 0) * k * k, f[o + 5] ?? 100, 0, f[o + 8] ?? SPELL_DAY_LIGHT);
    }
  }

  /**
   * How much of its glow a zone should show, 0 to 1. A caster recasting a zone in place stacks ten
   * copies on one spot, and ten additive glows burned to white; copies of one style on nearly the
   * same spot share one zone's worth of glow instead. Views are visited oldest first, so a fading
   * copy hands its share to the newer one smoothly.
   */
  zoneShare(style: number, x: number, y: number, r: number, fade: number): number {
    let taken = 0;
    const c = this.claims;
    for (let i = 0; i < this.claimCount; i++) {
      const o = i * 5;
      if (c[o + 3] !== style) continue;
      const dx = (c[o] ?? 0) - x;
      const dy = (c[o + 1] ?? 0) - y;
      const reach = 0.45 * Math.min(r, c[o + 2] ?? r);
      if (dx * dx + dy * dy < reach * reach) taken += c[o + 4] ?? 0;
    }
    const share = Math.max(0, 1 - taken);
    if (this.claimCount < MAX_ZONE_CLAIMS) {
      const o = this.claimCount++ * 5;
      c[o] = x;
      c[o + 1] = y;
      c[o + 2] = r;
      c[o + 3] = style;
      c[o + 4] = share * fade;
    }
    return share;
  }

  // -------------------------------------------------------------------------------------------
  // Emitters. `rate` arguments are particles per second at High; the budget scales them.

  /** Per-frame trail behind a player projectile or orb. `orb` trails are heavier and come off the rim. */
  trail(style: VfxStyle, x: number, y: number, h: number, radius: number, dt: number, orb: boolean): void {
    if (!this.onScreen(x, y, 60)) return;
    const p = PALETTE[style];
    const k = orb ? 1.8 : 1;
    const spread = orb ? radius : radius * 0.4;
    switch (style) {
      case 'fire': {
        for (let n = this.budget.take(40 * k * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          this.motion(x + Math.cos(a) * spread, h + rand(-4, 4), y + Math.sin(a) * spread, Math.cos(a) * 20, rand(15, 40), Math.sin(a) * 20, -50, 1.5);
          this.look(rand(0.3, 0.6), rand(2.5, 4.5) * (orb ? 1.3 : 1), 0.8, SHAPE.glow);
          this.colours(p.core, 1.3, 1, p.deep, 0.8, 0);
          this.glow.pool.spawn(this.spec);
        }
        for (let n = this.budget.take(10 * k * dt); n > 0; n--) {
          this.motion(x + rand(-spread, spread), h + rand(0, 6), y + rand(-spread, spread), rand(-8, 8), rand(18, 34), rand(-8, 8), -10, 0.8);
          this.look(rand(0.8, 1.3), radius * (orb ? 0.9 : 1.2) + 5, radius * 2.2 + 16, SHAPE.smoke);
          this.colours(p.smoke, 1, 0.34, p.smoke, 0.7, 0);
          this.smoke.pool.spawn(this.spec);
        }
        break;
      }
      case 'cold': {
        for (let n = this.budget.take(14 * k * dt); n > 0; n--) {
          this.motion(x + rand(-spread, spread), h + rand(-4, 2), y + rand(-spread, spread), rand(-6, 6), rand(-6, 4), rand(-6, 6), 4, 1.2);
          this.look(rand(0.6, 1), radius * 0.9 + 5, radius * 2 + 12, SHAPE.smoke);
          this.colours(p.smoke, 1.1, 0.22, p.body, 0.8, 0);
          this.smoke.pool.spawn(this.spec);
        }
        for (let n = this.budget.take(7 * k * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          this.motion(x + Math.cos(a) * spread, h, y + Math.sin(a) * spread, Math.cos(a) * 25, rand(10, 40), Math.sin(a) * 25, 90, 0.5);
          this.look(rand(0.35, 0.6), rand(2.5, 4), 1.2, SHAPE.shard);
          this.colours(p.body, 1, 1, p.deep, 1, 0);
          this.glow.pool.spawn(this.spec);
        }
        break;
      }
      case 'lightning': {
        for (let n = this.budget.take(34 * k * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          const sp = rand(60, 180);
          this.motion(x + Math.cos(a) * spread * 0.6, h + rand(-3, 3), y + Math.sin(a) * spread * 0.6, Math.cos(a) * sp, rand(-40, 80), Math.sin(a) * sp, 120, 3);
          this.look(rand(0.12, 0.25), rand(1.8, 2.8), 0.8, SHAPE.spark, 1.6);
          this.colours(p.core, 1.3, 1, p.body, 1, 0);
          this.glow.pool.spawn(this.spec);
        }
        break;
      }
      case 'plain': {
        for (let n = this.budget.take(10 * k * dt); n > 0; n--) {
          this.motion(x + rand(-spread, spread), h + rand(-4, 4), y + rand(-spread, spread), rand(-6, 6), rand(4, 14), rand(-6, 6), 0, 1);
          this.look(rand(0.5, 0.8), radius * 0.8 + 4, radius * 1.6 + 10, SHAPE.smoke);
          this.colours(p.smoke, 1, 0.22, p.smoke, 0.8, 0);
          this.smoke.pool.spawn(this.spec);
        }
        for (let n = this.budget.take(10 * k * dt); n > 0; n--) {
          this.motion(x + rand(-spread, spread), h, y + rand(-spread, spread), rand(-10, 10), rand(0, 20), rand(-10, 10), 30, 1);
          this.look(rand(0.25, 0.4), rand(1.5, 2.5), 0.5, SHAPE.glow);
          this.colours(p.core, 0.7, 1, p.body, 0.5, 0);
          this.glow.pool.spawn(this.spec);
        }
        break;
      }
      default: {
        for (let n = this.budget.take(18 * k * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          this.motion(x + Math.cos(a) * spread, h + rand(-4, 4), y + Math.sin(a) * spread, Math.cos(a) * 10, rand(20, 45), Math.sin(a) * 10, -20, 1);
          this.look(rand(0.5, 0.9), rand(2.5, 4), 0.8, SHAPE.mote);
          this.colours(p.core, 1, 1, p.body, 0.8, 0);
          this.glow.pool.spawn(this.spec);
        }
      }
    }
  }

  /** The Low trail: a sparse puff per emission, the old look with fewer particles. */
  plainTrail(x: number, y: number, h: number, color: Color, size: number): void {
    if (this.budget.take(1) === 0) return;
    this.motion(x + rand(-2, 2), h, y + rand(-2, 2), 0, 10, 0, 0, 0);
    this.look(0.22, size * 1.4, size * 0.3, SHAPE.glow);
    this.colours(color, 1, 0.9, color, 1, 0);
    this.glow.pool.spawn(this.spec);
  }

  /** A hit: a spray in the style of the element that dealt it. `style` null is a physical hit. */
  impact(style: VfxStyle | null, x: number, y: number, strong: boolean): void {
    if (!this.onScreen(x, y, 80)) return;
    const h = 18;
    const scale = strong ? 1.6 : 1;
    if (style === null) {
      const blood = tmpColor.setRGB(0.16, 0.02, 0.015);
      for (let n = this.budget.take(4 * scale, true); n > 0; n--) {
        const a = Math.random() * TAU;
        const sp = rand(40, 110);
        this.motion(x, h + rand(-4, 6), y, Math.cos(a) * sp, rand(60, 140), Math.sin(a) * sp, 520, 0.5);
        this.look(rand(0.4, 0.7), rand(2, 3.5), rand(1.5, 2.5), SHAPE.chunk);
        this.colours(blood, 1, 1, blood, 0.7, 0.8);
        this.smoke.pool.spawn(this.spec);
      }
      const p = PALETTE.plain;
      for (let n = this.budget.take(2 * scale, true); n > 0; n--) {
        this.motion(x + rand(-6, 6), h * 0.6, y + rand(-6, 6), rand(-10, 10), rand(8, 20), rand(-10, 10), 0, 1.5);
        this.look(rand(0.4, 0.6), 6, 16, SHAPE.smoke);
        this.colours(p.smoke, 1, 0.3, p.smoke, 1, 0);
        this.smoke.pool.spawn(this.spec);
      }
      return;
    }
    const p = PALETTE[style];
    switch (style) {
      case 'fire':
        this.flash(x, y, 24, p.body, 1.4 * scale, 120, 0.18);
        this.spray(p, x, h, y, 7 * scale, 70, 150, SHAPE.glow, 0.25, 0.5, 3, 4.5, 260, 0);
        this.puff(p.smoke, x, h, y, 2 * scale, 0.35, 0.8, 8, 22, -15);
        break;
      case 'cold':
        this.spray(p, x, h, y, 6 * scale, 60, 150, SHAPE.shard, 0.35, 0.6, 3, 4.5, 420, 0);
        this.puff(p.smoke, x, h, y, 1.5 * scale, 0.28, 0.7, 10, 24, 0);
        break;
      case 'lightning':
        this.flash(x, y, 30, p.body, 2.2 * scale, 140, 0.1, style);
        this.spray(p, x, h, y, 8 * scale, 120, 260, SHAPE.spark, 0.1, 0.22, 2, 3, 200, 1.8);
        if (this.budget.take(1, true) > 0) {
          this.motion(x, h, y, 0, 0, 0, 0, 0);
          this.look(0.1, 26 * scale, 14, SHAPE.core);
          this.colours(p.core, 1.2, 1, p.body, 1, 0);
          this.glow.pool.spawn(this.spec);
        }
        break;
      default:
        this.spray(p, x, h, y, 5 * scale, 40, 100, SHAPE.mote, 0.3, 0.6, 2.5, 4, -40, 0);
    }
  }

  /** Death burst: an element's end (ash and embers, a shatter, a scorch) or, without one, a heap of gore and dust. */
  death(style: VfxStyle | null, x: number, y: number, bodyColor: Color, big: boolean): void {
    const k = big ? 2 : 1;
    const h = 16;
    this.shockwave(x, y, big ? 120 : 60, style ?? 'plain', big ? 0.55 : 0.4);
    if (style !== null && style !== 'plain') this.flash(x, y, 30, PALETTE[style].body, (style === 'cold' ? 1 : 2.4) * k, 150 + 40 * k, style === 'lightning' ? 0.2 : 0.35, style);
    if (style === 'fire') {
      this.spray(PALETTE.fire, x, h, y, 22 * k, 60, 200, SHAPE.glow, 0.4, 0.9, 3, 5, 200, 0);
      this.puff(PALETTE.fire.smoke, x, h, y, 8 * k, 0.4, 1.4, 14, 40, -25);
      this.scorch(x, y, big ? 70 : 40, 0.55);
    } else if (style === 'cold') {
      // A shatter: heavy ice chunks that fall and settle, and a cold breath.
      this.spray(PALETTE.cold, x, h + 6, y, 20 * k, 70, 210, SHAPE.shard, 0.6, 1.1, 3.5, 6, 560, 0);
      this.puff(PALETTE.cold.smoke, x, h, y, 5 * k, 0.3, 1, 16, 40, 0);
    } else if (style === 'lightning') {
      this.spray(PALETTE.lightning, x, h, y, 20 * k, 140, 320, SHAPE.spark, 0.12, 0.3, 2, 3.2, 150, 2);
      this.puff(PALETTE.lightning.smoke, x, h, y, 4 * k, 0.3, 0.9, 12, 30, -20);
      this.scorch(x, y, big ? 60 : 34, 0.45);
    } else {
      const dark = tmpColor.copy(bodyColor).multiplyScalar(0.35);
      for (let n = this.budget.take(14 * k, true); n > 0; n--) {
        const a = Math.random() * TAU;
        const sp = rand(60, 180);
        this.motion(x, h + rand(0, 10), y, Math.cos(a) * sp, rand(80, 220), Math.sin(a) * sp, 620, 0.4);
        this.look(rand(0.7, 1.2), rand(3, 5.5) * (big ? 1.3 : 1), rand(2, 3), SHAPE.chunk);
        this.colours(dark, 1, 1, dark, 0.6, 0.9);
        this.smoke.pool.spawn(this.spec);
      }
      this.puff(PALETTE.plain.smoke, x, h * 0.5, y, 5 * k, 0.28, 1, 14, 38, -8);
      this.scorch(x, y, big ? 50 : 30, 0.35);
    }
  }

  /** A monster or minion blowing up: a flash, a fireball, smoke and a scorch mark. */
  explosion(x: number, y: number, r: number): void {
    const p = PALETTE.fire;
    this.motion(x, 24, y, 0, 0, 0, 0, 0);
    this.look(0.18, r * 1.4, r * 2, SHAPE.core);
    this.colours(p.core, 1.3, 1, p.body, 1, 0);
    this.glow.pool.spawn(this.spec);
    this.shockwave(x, y, r, 'fire', 0.45);
    this.flash(x, y, 40, p.body, 5, r * 2.5 + 100, 0.5);
    this.spray(p, x, 16, y, 30, 100, 300, SHAPE.glow, 0.4, 0.9, 3, 5.5, 240, 0);
    this.spray(p, x, 16, y, 10, 150, 340, SHAPE.spark, 0.2, 0.4, 2, 3, 200, 1.4);
    this.puff(p.smoke, x, 20, y, 12, 0.45, 1.8, r * 0.3 + 10, r * 0.8 + 20, -30);
    this.scorch(x, y, r * 0.9, 0.6);
  }

  /** The flash at a caster's hands. */
  cast(style: VfxStyle, x: number, y: number): void {
    const p = PALETTE[style];
    if (style !== 'plain') this.flash(x, y, 34, p.body, 1, 110, 0.14, style);
    this.spray(p, x, 26, y, 7, 30, 80, style === 'lightning' ? SHAPE.spark : style === 'cold' ? SHAPE.shard : SHAPE.mote, 0.25, 0.45, 2.5, 3.5, -30, style === 'lightning' ? 1.5 : 0);
  }

  /** A monster casting: a small dark puff at its hands, no light. */
  enemyCast(x: number, y: number): void {
    this.puff(PALETTE.plain.smoke, x, 26, y, 3, 0.3, 0.6, 8, 20, -20);
  }

  /** Healing motes rising off a target. */
  heal(x: number, y: number): void {
    this.spray(PALETTE.restore, x, 12, y, 6, 10, 40, SHAPE.mote, 0.5, 0.9, 2.5, 4, -80, 0);
  }

  /** A dud or a misfire: grey smoke, or a sputter of red sparks. */
  fizzle(x: number, y: number, misfire: boolean): void {
    if (misfire) this.spray(PALETTE.fire, x, 24, y, 12, 60, 160, SHAPE.spark, 0.15, 0.35, 2, 3, 200, 1.2);
    this.puff(PALETTE.plain.smoke, x, 24, y, 6, 0.4, 0.9, 10, 26, -30);
  }

  /** Coins and gold glints. */
  glints(x: number, y: number, color: Color, count: number): void {
    for (let n = this.budget.take(count, true); n > 0; n--) {
      const a = Math.random() * TAU;
      this.motion(x, 16, y, Math.cos(a) * rand(20, 60), rand(120, 220), Math.sin(a) * rand(20, 60), 240, 0.5);
      this.look(rand(0.5, 0.8), rand(2.5, 4), 1, SHAPE.mote);
      this.colours(color, 1, 1, color, 0.6, 0);
      this.glow.pool.spawn(this.spec);
    }
  }

  /** A generic coloured burst, for callers that only know a colour (level up, legacy events). */
  burst(x: number, y: number, color: Color, count: number, speed: number, up: number, size: number, life: number, gravity: number): void {
    for (let n = this.budget.take(count, true); n > 0; n--) {
      const a = Math.random() * TAU;
      const s = speed * rand(0.4, 1);
      this.motion(x, 14 + Math.random() * 10, y, Math.cos(a) * s, up * rand(0.5, 1.5), Math.sin(a) * s, gravity, 0.3);
      this.look(life * rand(0.6, 1.2), size * rand(0.7, 1.4), size * 0.3, SHAPE.glow);
      this.colours(color, 1, 1, color, 0.6, 0);
      this.glow.pool.spawn(this.spec);
    }
  }

  /** Ambient particles over a zone, per frame. `fade` is 0 to 1 as the zone ends. */
  zone(style: VfxStyle, x: number, y: number, r: number, dt: number, fade: number): void {
    if (!this.onScreen(x, y, r)) return;
    const p = PALETTE[style];
    const area = Math.min(4, (r * r) / 3600) * fade;
    switch (style) {
      case 'fire': {
        for (let n = this.budget.take(14 * area * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          const d = inDisk(r);
          this.motion(x + Math.cos(a) * d, rand(2, 8), y + Math.sin(a) * d, rand(-6, 6), rand(20, 50), rand(-6, 6), -40, 0.8);
          this.look(rand(0.5, 1), rand(2, 3.5), 0.8, SHAPE.glow);
          this.colours(p.core, 1.1, 1, p.deep, 0.8, 0);
          this.glow.pool.spawn(this.spec);
        }
        for (let n = this.budget.take(6 * area * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          const d = inDisk(r) * 0.85;
          this.motion(x + Math.cos(a) * d, rand(4, 8), y + Math.sin(a) * d, 0, rand(8, 20), 0, -20, 0.5);
          this.look(rand(0.35, 0.6), rand(9, 15), rand(4, 7), SHAPE.flame);
          this.colours(p.body, 1.1, 1, p.deep, 1, 0);
          this.glow.pool.spawn(this.spec);
        }
        for (let n = this.budget.take(5 * area * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          const d = inDisk(r);
          this.motion(x + Math.cos(a) * d, rand(10, 20), y + Math.sin(a) * d, rand(-5, 5), rand(15, 30), rand(-5, 5), -8, 0.3);
          this.look(rand(1.2, 2), rand(12, 18), rand(26, 40), SHAPE.smoke);
          this.colours(p.smoke, 1, 0.3, p.smoke, 0.6, 0);
          this.smoke.pool.spawn(this.spec);
        }
        break;
      }
      case 'cold': {
        for (let n = this.budget.take(4 * area * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          const d = inDisk(r);
          this.motion(x + Math.cos(a) * d, rand(2, 6), y + Math.sin(a) * d, rand(-5, 5), rand(0, 4), rand(-5, 5), 0, 0.5);
          this.look(rand(1.2, 2), rand(14, 22), rand(24, 34), SHAPE.smoke);
          this.colours(p.smoke, 1, 0.14, p.smoke, 1, 0);
          this.smoke.pool.spawn(this.spec);
        }
        // Glints on the crystals at the rim.
        for (let n = this.budget.take(10 * area * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          const d = r * rand(0.82, 0.97);
          this.motion(x + Math.cos(a) * d, rand(3, 9), y + Math.sin(a) * d, 0, rand(2, 8), 0, 0, 0);
          this.look(rand(0.3, 0.6), rand(2.5, 4), 0.5, SHAPE.mote);
          this.colours(p.core, 1.2, 1, p.body, 1, 0);
          this.glow.pool.spawn(this.spec);
        }
        break;
      }
      case 'lightning': {
        for (let n = this.budget.take(24 * area * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          const d = inDisk(r);
          const sa = Math.random() * TAU;
          const sp = rand(60, 200);
          this.motion(x + Math.cos(a) * d, rand(1, 6), y + Math.sin(a) * d, Math.cos(sa) * sp, rand(30, 120), Math.sin(sa) * sp, 300, 3);
          this.look(rand(0.1, 0.22), rand(2.6, 3.6), 0.8, SHAPE.spark, 1.6);
          this.colours(p.core, 1.3, 1, p.body, 1, 0);
          this.glow.pool.spawn(this.spec);
        }
        break;
      }
      case 'plain': {
        for (let n = this.budget.take(8 * area * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          const d = inDisk(r);
          this.motion(x + Math.cos(a) * d, rand(2, 8), y + Math.sin(a) * d, -Math.sin(a) * 20, rand(4, 12), Math.cos(a) * 20, 0, 0.4);
          this.look(rand(0.9, 1.5), rand(10, 16), rand(20, 30), SHAPE.smoke);
          this.colours(p.smoke, 1, 0.26, p.smoke, 1, 0);
          this.smoke.pool.spawn(this.spec);
        }
        break;
      }
      default: {
        for (let n = this.budget.take(14 * area * dt); n > 0; n--) {
          const a = Math.random() * TAU;
          const d = inDisk(r);
          this.motion(x + Math.cos(a) * d, rand(2, 10), y + Math.sin(a) * d, 0, rand(14, 30), 0, -6, 0.2);
          this.look(rand(1, 1.8), rand(2.5, 4), 1, SHAPE.mote);
          this.colours(p.core, 1, 1, p.body, 0.8, 0);
          this.glow.pool.spawn(this.spec);
        }
      }
    }
  }

  /** Debris thrown off a nova's expanding front, per frame. */
  novaFront(style: VfxStyle, x: number, y: number, r: number, dt: number, life: number): void {
    if (!this.onScreen(x, y, r)) return;
    const p = PALETTE[style];
    const around = Math.min(3, r / 60) * life;
    const heavy = style === 'plain';
    const shape = style === 'cold' ? SHAPE.shard : style === 'lightning' ? SHAPE.spark : style === 'fire' ? SHAPE.glow : heavy ? SHAPE.chunk : SHAPE.mote;
    for (let n = this.budget.take(60 * around * dt); n > 0; n--) {
      const a = Math.random() * TAU;
      const sp = rand(40, 120);
      this.motion(x + Math.cos(a) * r, rand(2, 10), y + Math.sin(a) * r, Math.cos(a) * sp, rand(30, 110), Math.sin(a) * sp, heavy ? 500 : style === 'fire' ? -30 : 200, 1.5);
      this.look(rand(0.25, 0.5), rand(2.2, 3.8), 0.8, shape, style === 'lightning' ? 1.6 : 0);
      if (heavy) {
        this.colours(p.deep, 1, 1, p.deep, 0.7, 0.6);
        this.smoke.pool.spawn(this.spec);
      } else {
        this.colours(p.core, 1.2, 1, p.body, 0.8, 0);
        this.glow.pool.spawn(this.spec);
      }
    }
    for (let n = this.budget.take((heavy ? 22 : 8) * around * dt); n > 0; n--) {
      const a = Math.random() * TAU;
      this.motion(x + Math.cos(a) * r, rand(3, 8), y + Math.sin(a) * r, Math.cos(a) * 30, rand(5, 15), Math.sin(a) * 30, 0, 1.5);
      this.look(rand(0.5, 0.9), rand(10, 14), rand(22, 32), SHAPE.smoke);
      this.colours(p.smoke, 1, heavy ? 0.36 : 0.22, p.smoke, 0.8, 0);
      this.smoke.pool.spawn(this.spec);
    }
  }

  /** Motes drifting up inside an aura, per frame. */
  aura(style: VfxStyle, x: number, y: number, r: number, dt: number): void {
    if (!this.onScreen(x, y, r)) return;
    const p = PALETTE[style];
    for (let n = this.budget.take(6 * Math.min(3, r / 90) * dt); n > 0; n--) {
      const a = Math.random() * TAU;
      const d = r * Math.sqrt(Math.random()) * 0.95;
      this.motion(x + Math.cos(a) * d, rand(2, 8), y + Math.sin(a) * d, 0, rand(10, 24), 0, -4, 0.3);
      const shape = style === 'fire' ? SHAPE.glow : style === 'lightning' ? SHAPE.spark : style === 'cold' ? SHAPE.shard : SHAPE.mote;
      this.look(rand(1, 1.8), rand(2, 3.2), 0.8, shape, style === 'lightning' ? 0.8 : 0);
      this.colours(p.core, 0.9, 0.85, p.body, 0.7, 0);
      this.glow.pool.spawn(this.spec);
    }
  }

  /** Motes running along a bond, per frame. */
  tether(ax: number, ay: number, bx: number, by: number, h: number, dt: number): void {
    const p = PALETTE.ward;
    const len = Math.hypot(bx - ax, by - ay);
    for (let n = this.budget.take((len / 40) * 3 * dt); n > 0; n--) {
      const t = Math.random();
      this.motion(ax + (bx - ax) * t, h + rand(-3, 3), ay + (by - ay) * t, rand(-6, 6), rand(-4, 10), rand(-6, 6), 0, 1);
      this.look(rand(0.4, 0.8), rand(2, 3), 0.6, SHAPE.mote);
      this.colours(p.core, 1, 1, p.body, 0.8, 0);
      this.glow.pool.spawn(this.spec);
    }
  }

  /** Burning, chilled, shocked and poisoned bodies, per frame. `height` is about the top of the model. */
  status(id: number, x: number, y: number, r: number, height: number, burn: boolean, chill: boolean, shock: boolean, poison: boolean, dt: number): void {
    if (!this.level.statusParticles || !this.onScreen(x, y, 40)) return;
    const size = Math.max(0.6, Math.min(2, r / 14));
    if (burn) {
      const p = PALETTE.fire;
      for (let n = this.budget.take(14 * size * dt); n > 0; n--) {
        const a = Math.random() * TAU;
        const d = r * rand(0.2, 0.8);
        this.motion(x + Math.cos(a) * d, height * rand(0.15, 0.75), y + Math.sin(a) * d, 0, rand(15, 35), 0, -60, 0.5);
        this.look(rand(0.3, 0.5), r * rand(0.5, 0.8), r * 0.25, SHAPE.flame);
        this.colours(p.body, 1.1, 1, p.deep, 1, 0);
        this.glow.pool.spawn(this.spec);
      }
      for (let n = this.budget.take(4 * size * dt); n > 0; n--) {
        this.motion(x + rand(-r, r) * 0.5, height * 0.8, y + rand(-r, r) * 0.5, rand(-6, 6), rand(20, 36), rand(-6, 6), -10, 0.4);
        this.look(rand(0.8, 1.3), r * 0.7, r * 1.5, SHAPE.smoke);
        this.colours(p.smoke, 1, 0.28, p.smoke, 1, 0);
        this.smoke.pool.spawn(this.spec);
      }
      // Two slow sines, not a per-frame random: a burning body flickers like a torch, never strobes.
      const t = this.time + id * 0.37;
      this.light(entityLightKey(id, 1), x, y, height * 0.6, p.body, 1.05 + Math.sin(t * 7.3) * 0.09 + Math.sin(t * 12.9) * 0.06, 110 + r * 3, 'fire');
    }
    if (chill) {
      const p = PALETTE.cold;
      for (let n = this.budget.take(5 * size * dt); n > 0; n--) {
        const a = Math.random() * TAU;
        this.motion(x + Math.cos(a) * r * 0.6, rand(2, 6), y + Math.sin(a) * r * 0.6, Math.cos(a) * 8, rand(0, 3), Math.sin(a) * 8, 0, 0.6);
        this.look(rand(0.9, 1.4), r * 0.9, r * 1.8, SHAPE.smoke);
        this.colours(p.smoke, 1.1, 0.24, p.smoke, 1, 0);
        this.smoke.pool.spawn(this.spec);
      }
      for (let n = this.budget.take(2 * size * dt); n > 0; n--) {
        this.motion(x + rand(-r, r) * 0.6, height * rand(0.2, 0.9), y + rand(-r, r) * 0.6, 0, rand(-10, 0), 0, 30, 0.5);
        this.look(rand(0.4, 0.7), rand(2, 3.2), 0.6, SHAPE.shard);
        this.colours(CHILL_GLINT, 1, 1, CHILL_GLINT, 0.8, 0);
        this.glow.pool.spawn(this.spec);
      }
    }
    if (poison) {
      // Drops run off the body and fall to the ground; gravity and a short life keep them drips, not sparks.
      for (let n = this.budget.take(14 * size * dt); n > 0; n--) {
        const a = Math.random() * TAU;
        const d = r * rand(0.2, 0.7);
        this.motion(x + Math.cos(a) * d, height * rand(0.35, 0.8), y + Math.sin(a) * d, 0, rand(-6, 4), 0, 220, 0.2);
        this.look(rand(0.35, 0.6), rand(3, 4.5), 1.8, SHAPE.mote, 1.4);
        this.colours(POISON_DRIP, 0.75, 0.9, POISON_DRIP_DEEP, 0.7, 0);
        this.glow.pool.spawn(this.spec);
      }
      for (let n = this.budget.take(4 * size * dt); n > 0; n--) {
        const a = Math.random() * TAU;
        this.motion(x + Math.cos(a) * r * 0.5, rand(3, height * 0.4), y + Math.sin(a) * r * 0.5, Math.cos(a) * 6, rand(3, 9), Math.sin(a) * 6, -2, 0.7);
        this.look(rand(1, 1.6), r * 0.8, r * 1.9, SHAPE.smoke);
        this.colours(POISON_MIST, 1.2, 0.36, POISON_MIST, 1, 0);
        this.smoke.pool.spawn(this.spec);
      }
    }
    if (shock) {
      const p = PALETTE.lightning;
      for (let n = this.budget.take(10 * size * dt); n > 0; n--) {
        const a = Math.random() * TAU;
        const sp = rand(60, 160);
        this.motion(x + Math.cos(a) * r * 0.4, height * rand(0.3, 0.9), y + Math.sin(a) * r * 0.4, Math.cos(a) * sp, rand(0, 90), Math.sin(a) * sp, 250, 3);
        this.look(rand(0.08, 0.18), rand(2.6, 3.6), 0.8, SHAPE.spark, 1.8);
        this.colours(p.core, 1.3, 1, p.body, 1, 0);
        this.glow.pool.spawn(this.spec);
      }
      if (this.budget.chance(3 * dt)) {
        this.glowSprite(x, height * 0.6, y, r * 2.4, p.core, 0.9, SHAPE.core);
        this.flash(x, y, height, p.body, 1.6, 120, 0.12, 'lightning');
      }
    }
  }

  /** Dust and a wind streak behind a dashing hero, per frame. */
  dash(x: number, y: number, dt: number): void {
    const p = PALETTE.plain;
    for (let n = this.budget.take(40 * dt, true); n > 0; n--) {
      this.motion(x + rand(-8, 8), rand(1, 6), y + rand(-8, 8), rand(-10, 10), rand(5, 16), rand(-10, 10), 0, 1.5);
      this.look(rand(0.5, 0.8), rand(8, 12), rand(18, 26), SHAPE.smoke);
      this.colours(p.smoke, 1, 0.34, p.smoke, 1, 0);
      this.smoke.pool.spawn(this.spec);
    }
    for (let n = this.budget.take(24 * dt, true); n > 0; n--) {
      this.motion(x + rand(-10, 10), rand(8, 40), y + rand(-10, 10), 0, 0, 0, 0, 0);
      this.look(rand(0.18, 0.3), rand(2, 3), 0.6, SHAPE.mote);
      this.colours(p.core, 0.8, 0.9, p.body, 0.6, 0);
      this.glow.pool.spawn(this.spec);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Building blocks

  /** Particles flung out from a point. `gravity` below zero rises. */
  private spray(p: StylePalette, x: number, h: number, y: number, count: number, minSpeed: number, maxSpeed: number, shape: number, minLife: number, maxLife: number, minSize: number, maxSize: number, gravity: number, stretch: number): void {
    for (let n = this.budget.take(count, true); n > 0; n--) {
      const a = Math.random() * TAU;
      const sp = rand(minSpeed, maxSpeed);
      this.motion(x, h + rand(-4, 4), y, Math.cos(a) * sp, rand(40, 160), Math.sin(a) * sp, gravity, 1.2);
      this.look(rand(minLife, maxLife), rand(minSize, maxSize), 0.6, shape, stretch);
      this.colours(p.core, 1.2, 1, p.body, 0.8, 0);
      this.glow.pool.spawn(this.spec);
    }
  }

  private puff(color: Color, x: number, h: number, y: number, count: number, alpha: number, life: number, size0: number, size1: number, gravity: number): void {
    for (let n = this.budget.take(count, true); n > 0; n--) {
      const a = Math.random() * TAU;
      const sp = rand(10, 40);
      this.motion(x + Math.cos(a) * 4, h, y + Math.sin(a) * 4, Math.cos(a) * sp, rand(10, 30), Math.sin(a) * sp, gravity, 1.4);
      this.look(life * rand(0.7, 1.2), size0 * rand(0.8, 1.2), size1 * rand(0.8, 1.2), SHAPE.smoke);
      this.colours(color, 1, alpha, color, 0.8, 0);
      this.smoke.pool.spawn(this.spec);
    }
  }

  /** A dark mark on the ground that fades over a few seconds. */
  scorch(x: number, y: number, r: number, alpha: number): void {
    if (this.level.groundCapacity === 0) return;
    this.motion(x, 0.8, y, 0, 0, 0, 0, 0);
    this.look(rand(3.5, 5), r * 1.4, r * 1.6, SHAPE.smoke);
    tmpColor.setRGB(0.02, 0.015, 0.012);
    this.colours(tmpColor, 1, alpha, tmpColor, 1, 0);
    this.groundDark.pool.spawn(this.spec);
  }

  /** An expanding ring on the ground: the nova shader on Medium and High, a flat additive ring on Low. */
  shockwave(x: number, y: number, radius: number, style: VfxStyle, duration: number): void {
    const want = this.level.shaders ? style : null;
    let w = this.waves.find((v) => !v.busy && v.style === want);
    if (!w) {
      if (this.waves.length >= MAX_WAVES) return;
      let u: NovaUniforms | null = null;
      let basic: MeshBasicMaterial | null = null;
      let mesh: Wave['mesh'];
      if (want === null) {
        basic = new MeshBasicMaterial({ color: PALETTE[style].body.clone(), transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
        mesh = new Mesh(this.ringGeo, basic);
      } else {
        const shaded = novaMaterial(want, this.shared);
        u = shaded.u;
        mesh = new Mesh(this.waveGeo, shaded.material);
      }
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = RENDER_ORDER.groundEffect;
      w = { mesh, u, basic, style: want, age: 0, duration, radius, busy: false };
      this.waves.push(w);
    }
    w.busy = true;
    w.age = 0;
    w.duration = duration;
    w.radius = radius;
    if (w.basic) w.basic.color.copy(PALETTE[style].body);
    if (w.u) w.u.uSeed.value = Math.random();
    w.mesh.position.set(x, 3, y);
    this.scene.add(w.mesh);
  }

  private updateWaves(dt: number): void {
    for (const w of this.waves) {
      if (!w.busy) continue;
      w.age += dt;
      const k = w.age / w.duration;
      if (k >= 1) {
        w.busy = false;
        this.scene.remove(w.mesh);
        continue;
      }
      const grow = 0.2 + 0.8 * Math.sqrt(k);
      if (w.basic) {
        w.mesh.scale.setScalar(Math.max(1, w.radius * grow));
        w.basic.opacity = 0.8 * (1 - k);
      }
      if (w.u) {
        // The nova quad spans 1.15x the ring radius (its geometry is 2 wide, so scale is the radius).
        w.mesh.scale.setScalar(Math.max(1, w.radius * grow * 1.15));
        w.u.uProgress.value = k;
      }
    }
  }

  dispose(): void {
    this.removeLayers();
    this.scene.remove(this.fires.mesh);
    this.fires.dispose();
    for (const w of this.waves) {
      this.scene.remove(w.mesh);
      w.mesh.material.dispose();
    }
    this.waves.length = 0;
    this.waveGeo.dispose();
    this.ringGeo.dispose();
    for (const m of this.warmMats) m.dispose();
    this.warmMats = [];
    this.warmGeo.dispose();
  }
}

function writeSprite(layer: ParticleLayer, x: number, h: number, y: number, size: number, color: Color, intensity: number, shape: number): void {
  const o = layer.spriteSlot();
  if (o < 0) return;
  const d = layer.buffer32;
  d[o] = x;
  d[o + 1] = h;
  d[o + 2] = y;
  d[o + 3] = size;
  d[o + 4] = color.r;
  d[o + 5] = color.g;
  d[o + 6] = color.b;
  d[o + 7] = intensity;
  d[o + 8] = 0;
  d[o + 9] = 0;
  d[o + 10] = 0;
  d[o + 11] = 0;
  d[o + 12] = shape;
  // A fixed seed per spot keeps a sprite from spinning between frames.
  d[o + 13] = ((x * 0.013 + y * 0.029) % 1 + 1) % 1;
}

