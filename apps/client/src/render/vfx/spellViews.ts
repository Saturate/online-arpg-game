import type { EntitySnap } from '@rune/shared';
import {
  AdditiveBlending,
  BackSide,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  type Material,
} from 'three';
import { COLORS, ELEMENT_COLORS, FX, fxColor, RENDER_ORDER } from '../config.js';
import { orbMaterial, novaMaterial, plainAreaMaterial, zoneMaterial, type NovaUniforms, type OrbUniforms, type PlainAreaUniforms, type ZoneUniforms } from './materials.js';
import { PALETTE, STYLE_INDEX, styleOf, type StylePalette, type VfxStyle } from './palette.js';
import { entityLightKey } from '../lights.js';
import { SHAPE } from './pool.js';
import { HeldJitter } from './jitter.js';
import type { Vfx } from './vfx.js';

export type SpellSnapKind = Extract<EntitySnap, { k: 'projectile' | 'nova' | 'zone' }>;

/** A drawn spell entity. `update` runs every frame with the interpolated position. */
export interface SpellView {
  readonly root: Group;
  update(s: SpellSnapKind, x: number, y: number, dt: number): void;
  dispose(): void;
}

const GEO = {
  sphere: new SphereGeometry(1, 16, 12),
  ring: new RingGeometry(0.86, 1, 48),
  thinRing: new RingGeometry(0.95, 1, 64),
  disk: new CircleGeometry(1, 48),
  torus: new TorusGeometry(1, 0.12, 8, 24),
  /** 2 x 2, so a scale of r covers a circle of radius r. */
  quad: new PlaneGeometry(2, 2),
};

/** Materials shared by every view that never changes them. */
const sharedMats = new Map<string, MeshBasicMaterial>();

function basic(color: number, opacity = 1, additive = false): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: opacity < 1 || additive, opacity, depthWrite: false, side: DoubleSide, ...(additive ? { blending: AdditiveBlending } : {}) });
}

function sharedBasic(color: number, opacity = 1, additive = false): MeshBasicMaterial {
  const key = `${color}|${opacity}|${additive}`;
  let m = sharedMats.get(key);
  if (!m) {
    m = basic(color, opacity, additive);
    sharedMats.set(key, m);
  }
  return m;
}

/** The Low fill of zones and novas; low enough that monsters inside keep their colours. */
const LOW_FILL = 0.07;
/** Spell light reaches this far past a zone's edge, as a share of its radius, and no further. */
const ZONE_LIGHT_REACH = 1.2;

function flat(mesh: Mesh, y: number): Mesh {
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.renderOrder = RENDER_ORDER.groundEffect;
  return mesh;
}

function flatColor(s: SpellSnapKind): number {
  if (s.k === 'projectile') return s.el ? ELEMENT_COLORS[s.el] : s.fx === 'damage' ? COLORS.playerProjectile : fxColor(s.fx, null);
  return fxColor(s.fx, s.el);
}

/**
 * Builds the view for a spell entity. Enemy bullets always get the same crisp look so they can never
 * be mistaken for a player's spell; player spells get the shader look when the quality has shaders,
 * and the plain shapes (with a thin trail) otherwise.
 */
export function makeSpellView(s: SpellSnapKind, vfx: Vfx | null): SpellView {
  if (s.k === 'projectile' && s.team === 'enemies') return new EnemyBulletView(s, vfx);
  if (!vfx || !vfx.level.shaders) return new PlainSpellView(s, vfx);
  const style = styleOf(s.el, s.fx);
  if (s.k === 'projectile') return s.orb ? new OrbView(s, style, vfx) : new BoltView(s, style, vfx);
  if (s.k === 'nova') return new NovaView(style, vfx);
  return new ZoneView(style, vfx);
}

/** Fixed-rate trail emission, so trail density does not follow the refresh rate. */
class TrailClock {
  private t = Math.random() / FX.trailHz;
  due(dt: number): boolean {
    this.t += dt;
    const step = 1 / FX.trailHz;
    if (this.t < step) return false;
    this.t %= step;
    return true;
  }
}

class EnemyBulletView implements SpellView {
  readonly root = new Group();
  private readonly clock = new TrailClock();
  private readonly color = new Color(COLORS.enemyBullet);

  constructor(
    s: SpellSnapKind,
    private readonly vfx: Vfx | null,
  ) {
    const core = new Mesh(GEO.sphere, shared('bullet', () => new MeshBasicMaterial({ color: COLORS.enemyBullet })));
    core.scale.setScalar(s.r);
    const outline = new Mesh(GEO.sphere, shared('bullet-outline', () => new MeshBasicMaterial({ color: COLORS.enemyBulletOutline, side: BackSide })));
    outline.scale.setScalar(s.r * 1.4);
    const g = new Group();
    g.add(core, outline);
    g.position.y = 18;
    this.root.add(g);
  }

  update(s: SpellSnapKind, x: number, y: number, dt: number): void {
    if (this.vfx && this.clock.due(dt)) this.vfx.plainTrail(x, y, 18, this.color, s.r * 0.8);
  }

  dispose(): void {}
}

function shared(key: string, make: () => MeshBasicMaterial): MeshBasicMaterial {
  let m = sharedMats.get(key);
  if (!m) {
    m = make();
    sharedMats.set(key, m);
  }
  return m;
}

/** The Low look: the flat readable shapes spells had before the effects work. */
class PlainSpellView implements SpellView {
  readonly root = new Group();
  private readonly owned: Material[] = [];
  private readonly clock = new TrailClock();
  private readonly trailColor: Color;
  private fill: Mesh | null = null;
  private area: PlainAreaUniforms | null = null;
  private shell: Mesh | null = null;
  private band: Mesh | null = null;
  private readonly styleIndex: number;
  /** A bolt drawn as sprites instead of meshes. */
  private sprites = false;
  private time = Math.random() * 10;

  constructor(
    s: SpellSnapKind,
    private readonly vfx: Vfx | null,
  ) {
    const color = flatColor(s);
    this.trailColor = new Color(color);
    this.styleIndex = s.k === 'projectile' ? 0 : STYLE_INDEX[styleOf(s.el, s.fx)];
    if (s.k === 'projectile' && s.orb) {
      const ember = new Color(color).multiplyScalar(0.18).getHex();
      const core = new Mesh(GEO.sphere, sharedBasic(ember, 1));
      core.scale.setScalar(s.r * 0.72);
      const shellMat = this.own(basic(color, 0.18, true));
      this.shell = new Mesh(GEO.sphere, shellMat);
      this.shell.scale.setScalar(s.r);
      this.band = new Mesh(GEO.torus, sharedBasic(color, 0.85, true));
      this.band.scale.setScalar(s.r * 0.86);
      const g = new Group();
      g.add(core, this.shell, this.band);
      g.position.y = 20;
      const pool = flat(new Mesh(GEO.disk, sharedBasic(color, 0.1, true)), 1.2);
      pool.scale.setScalar(s.r * 2.4);
      this.root.add(g, pool);
    } else if (s.k === 'projectile') {
      // The old solid core and faint halo, as two sprites: seen from the fixed camera a sphere is a
      // disc anyway, and a volley of shards no longer costs two draw calls each.
      this.sprites = vfx !== null;
      if (!vfx) {
        const core = new Mesh(GEO.sphere, sharedBasic(color, 0.9));
        core.scale.setScalar(s.r * 0.8);
        const halo = new Mesh(GEO.sphere, sharedBasic(color, 0.25, true));
        halo.scale.setScalar(s.r * 1.4);
        const g = new Group();
        g.add(core, halo);
        g.position.y = 18;
        this.root.add(g);
      }
    } else {
      // The old additive fill and edge ring (0.86 wide for a nova, 0.95 for a zone), as one quad.
      const shaded = plainAreaMaterial(color, s.k === 'nova' ? 0.86 : 0.95);
      this.own(shaded.material);
      this.area = shaded.u;
      this.fill = flat(new Mesh(GEO.quad, shaded.material), s.k === 'nova' ? 3 : 1.5);
      this.fill.scale.setScalar(Math.max(1, s.r));
      this.root.add(this.fill);
    }
  }

  private own<T extends Material>(m: T): T {
    this.owned.push(m);
    return m;
  }

  update(s: SpellSnapKind, x: number, y: number, dt: number): void {
    this.time += dt;
    const t = this.time;
    if (s.k === 'projectile') {
      if (this.band) {
        this.band.rotation.x += dt * 2.6;
        this.band.rotation.y += dt * 1.1;
      }
      const shellMat = this.shell?.material;
      if (shellMat instanceof MeshBasicMaterial) shellMat.opacity = 0.16 + Math.sin(t * 6) * 0.05;
      if (this.sprites && this.vfx) {
        this.vfx.solidSprite(x, 18, y, s.r * 1.6, this.trailColor, 0.9);
        this.vfx.glowSprite(x, 18, y, s.r * 2.8, this.trailColor, 0.25);
      }
      if (this.vfx && this.clock.due(dt)) this.vfx.plainTrail(x, y, 18, this.trailColor, s.orb ? s.r * 0.4 : s.r * 0.9);
      return;
    }
    const area = this.area;
    if (!area) return;
    if (s.k === 'nova') {
      const k = s.maxR > 0 ? s.r / s.maxR : 1;
      this.fill?.scale.setScalar(Math.max(1, s.r));
      area.uRing.value = 0.9 * (1 - k * 0.6);
      area.uFill.value = LOW_FILL * (1 - k * 0.6);
      return;
    }
    const fade = Math.min(1, s.left * 4);
    // A zone recast in place stacks copies on one spot; only one of them draws (see Vfx.zoneShare).
    const share = this.vfx ? this.vfx.zoneShare(this.styleIndex, x, y, s.r, fade) : 1;
    this.root.visible = share > 0.02;
    this.fill?.scale.setScalar(s.r);
    area.uFill.value = LOW_FILL * (1 + Math.sin(t * 5) * 0.2) * fade * share;
    area.uRing.value = 0.85 * fade * share;
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
  }
}

/** A player bolt: a hot core with falloff, a halo, a ribbon, its element's trail and a pool of light. */
class BoltView implements SpellView {
  readonly root = new Group();
  private readonly ribbon: number;
  private readonly p: StylePalette;
  private readonly jitter = new HeldJitter();

  constructor(
    s: SpellSnapKind,
    private readonly style: VfxStyle,
    private readonly vfx: Vfx,
  ) {
    this.p = PALETTE[style];
    const b = this.p.body;
    const w = style === 'lightning' ? s.r * 0.8 : s.r * 0.75;
    this.ribbon = vfx.level.ribbons ? vfx.ribbons.acquire(b.r * 0.9, b.g * 0.9, b.b * 0.9, w, style === 'lightning' ? 0.14 : 0.22, STYLE_INDEX[style]) : -1;
  }

  update(s: SpellSnapKind, x: number, y: number, dt: number): void {
    const v = this.vfx;
    const h = 18;
    const flicker = this.style === 'lightning' || this.style === 'fire' ? this.jitter.next(dt) : 1;
    v.glowSprite(x, h, y, s.r * 2.8, this.p.body, 0.85 * flicker, SHAPE.core);
    v.glowSprite(x, h, y, s.r * 6, this.p.deep, 0.35 * flicker, SHAPE.glow);
    v.light(entityLightKey(s.id), x, y, h, this.p.body, 1.3 * flicker, 150, this.style);
    v.trail(this.style, x, y, h, s.r, dt, false);
    v.ribbons.push(this.ribbon, x, h, y, v.time);
  }

  dispose(): void {
    this.vfx.ribbons.release(this.ribbon);
  }
}

/** A player orb: a heavy shaded ball rolling in its element's surface, a halo, a wide smoky ribbon. */
class OrbView implements SpellView {
  readonly root = new Group();
  private readonly ball: Mesh;
  private readonly u: OrbUniforms;
  private readonly ribbon: number;
  private readonly p: StylePalette;
  private lastX = NaN;
  private lastY = NaN;
  private readonly jitter = new HeldJitter();

  constructor(
    s: SpellSnapKind,
    private readonly style: VfxStyle,
    private readonly vfx: Vfx,
  ) {
    this.p = PALETTE[style];
    const shaded = orbMaterial(style, vfx.shared);
    this.u = shaded.u;
    this.ball = new Mesh(GEO.sphere, shaded.material);
    this.ball.scale.setScalar(s.r * 0.82);
    this.ball.position.y = 20;
    this.root.add(this.ball);
    const b = this.p.body;
    this.ribbon = vfx.level.ribbons ? vfx.ribbons.acquire(b.r * 0.7, b.g * 0.7, b.b * 0.7, s.r * 0.9, 0.32, STYLE_INDEX[style]) : -1;
  }

  update(s: SpellSnapKind, x: number, y: number, dt: number): void {
    const v = this.vfx;
    // Roll with the ground covered, so a slow orb turns slowly.
    if (!Number.isNaN(this.lastX)) {
      const moved = Math.hypot(x - this.lastX, y - this.lastY);
      this.u.uSpin.value.x += (moved / Math.max(1, s.r)) * 0.9;
      this.u.uSpin.value.y += dt * 0.7;
    }
    this.lastX = x;
    this.lastY = y;
    this.ball.scale.setScalar(s.r * 0.82);
    const flicker = this.jitter.next(dt);
    v.glowSprite(x, 20, y, s.r * 2.8, this.p.body, 0.45 * flicker, SHAPE.glow);
    v.light(entityLightKey(s.id), x, y, 24, this.p.body, 2 * flicker, 220, this.style);
    v.trail(this.style, x, y, 20, s.r, dt, true);
    v.ribbons.push(this.ribbon, x, 20, y, v.time);
  }

  dispose(): void {
    this.vfx.ribbons.release(this.ribbon);
    const m = this.ball.material;
    if (!Array.isArray(m)) m.dispose();
  }
}

/** A nova: the shockwave shader grows with the snapshot radius and throws debris off its front. */
class NovaView implements SpellView {
  readonly root = new Group();
  private readonly mesh: Mesh;
  private readonly u: NovaUniforms;

  constructor(
    private readonly style: VfxStyle,
    private readonly vfx: Vfx,
  ) {
    const shaded = novaMaterial(style, vfx.shared);
    this.u = shaded.u;
    this.mesh = flat(new Mesh(GEO.quad, shaded.material), 3);
    this.root.add(this.mesh);
  }

  update(s: SpellSnapKind, x: number, y: number, dt: number): void {
    if (s.k !== 'nova') return;
    const k = s.maxR > 0 ? Math.min(1, s.r / s.maxR) : 1;
    this.mesh.scale.setScalar(Math.max(1, s.r * 1.15));
    this.u.uProgress.value = k;
    this.vfx.novaFront(this.style, x, y, s.r, dt, 1 - k);
    this.vfx.light(entityLightKey(s.id), x, y, 20, PALETTE[this.style].body, 2.4 * (1 - k), s.r * 1.4 + 60, this.style);
  }

  dispose(): void {
    const m = this.mesh.material;
    if (!Array.isArray(m)) m.dispose();
  }
}

/** A zone: the ground shader for its style, with a crisp ring at the edge, and its ambient particles. */
class ZoneView implements SpellView {
  readonly root = new Group();
  private readonly mesh: Mesh;
  private readonly u: ZoneUniforms;
  private age = 0;
  private readonly jitter = new HeldJitter();

  constructor(
    private readonly style: VfxStyle,
    private readonly vfx: Vfx,
  ) {
    const shaded = zoneMaterial(style, vfx.shared);
    this.u = shaded.u;
    this.mesh = flat(new Mesh(GEO.quad, shaded.material), 1.5);
    this.root.add(this.mesh);
  }

  update(s: SpellSnapKind, x: number, y: number, dt: number): void {
    if (s.k !== 'zone') return;
    this.age += dt;
    const fade = Math.min(1, s.left * 4) * Math.min(1, this.age * 5);
    const share = this.vfx.zoneShare(STYLE_INDEX[this.style], x, y, s.r, fade);
    const glow = fade * share;
    this.mesh.visible = share > 0.02;
    this.mesh.scale.setScalar(s.r);
    // Stacked copies still darken a little, so the patch never looks thinner than one zone.
    this.u.uFade.value = fade * (0.3 + 0.7 * share);
    this.u.uGlow.value = glow;
    this.u.uRadius.value = s.r;
    if (glow < 0.02) return;
    this.vfx.zone(this.style, x, y, s.r, dt, glow);
    const p = PALETTE[this.style];
    const key = entityLightKey(s.id);
    // Burning ground is a campfire; a storm patch crackles; runic light is a soft steady glow. The
    // light stops a little past the edge, so a zone does not light ground it does not cover.
    const reach = s.r * ZONE_LIGHT_REACH;
    if (this.style === 'fire') this.vfx.light(key, x, y, 30, p.body, (1.4 + Math.sin(this.age * 9) * 0.1) * this.jitter.next(dt) * glow, reach, this.style);
    else if (this.style === 'lightning') this.vfx.light(key, x, y, 30, p.body, 1.1 * this.jitter.next(dt) * glow, reach, this.style);
    else if (this.style === 'cold') this.vfx.light(key, x, y, 30, p.body, 0.7 * glow, reach, this.style);
    else if (this.style !== 'plain') this.vfx.light(key, x, y, 30, p.body, 0.8 * glow, reach, this.style);
  }

  dispose(): void {
    const m = this.mesh.material;
    if (!Array.isArray(m)) m.dispose();
  }
}
