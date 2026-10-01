import { bodyPivot, CLASSES, ENEMIES, familyOf, MINION_DEFS, STATUS, type ClassId, type EnemyTypeId, type EntityId, type EntitySnap } from '@rune/shared';
import {
  Box3,
  AdditiveBlending,
  BoxGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Camera,
  type Object3D,
  type Scene,
} from 'three';
import { COLORS, fxColor, RENDER_ORDER, TIER_COLORS } from './config.js';
import { assetById, cloneMaterial, instantiate } from './assets.js';
import { characterAsset, characterNow, driveCharacter, loadCharacter, windupCharacter, type CharacterModel } from './characters.js';
import { beginRigFrame, driveRig, enemyModel, minionModel, playerModel, rigAttack, rigHit, rigWindup, type Rig, type RigDrive } from './models.js';
import { auraMaterial, tetherMaterial, type TetherUniforms } from './vfx/materials.js';
import { PALETTE, styleOf } from './vfx/palette.js';
import { makeSpellView, type SpellView } from './vfx/spellViews.js';
import type { Vfx } from './vfx/vfx.js';
import { entityLightKey } from './lights.js';
import type { VfxQuality } from './vfx/quality.js';
import { HeldJitter } from './vfx/jitter.js';

export interface RenderItem {
  /** `s<id>` for server entities, `l<n>` for local cosmetic effects. */
  key: string;
  snap: EntitySnap;
  x: number;
  y: number;
  isSelf: boolean;
  isAlly: boolean;
}

const FLASH_SECONDS = 0.08;
/**
 * The least time between two hit flashes on one entity. Zones tick every few frames, and a flash on
 * every tick kept monsters standing in one lit up the whole time.
 */
const FLASH_COOLDOWN = 0.3;

interface Disposable {
  dispose(): void;
}

interface View {
  root: Group;
  /** Meshes whose materials get the hit flash and status tint. */
  tintMeshes: Mesh[];
  /**
   * This view's own copies of the tint meshes' materials. Null until a flash, ailment or death first
   * changes them, so a pack that is never hit shares its materials with every other copy.
   */
  tintable: MeshStandardMaterial[] | null;
  baseEmissive: Color[];
  baseIntensity: number[];
  /** Whether the materials currently show a flash or tint that has to be undone. */
  tinted: boolean;
  /** GPU resources this view created and frees on removal. Shared geometry and cached materials are never listed. */
  owned: Set<Disposable>;
  body: Object3D | null;
  facing: Object3D | null;
  healthBar: { group: Group; fill: Mesh; width: number } | null;
  shield: Mesh | null;
  auraRings: Mesh[];
  flash: number;
  /** Renderer time of the last hit flash, for FLASH_COOLDOWN. */
  lastFlash: number;
  /** Held flicker for the shock tint, so it crackles instead of strobing. */
  shockJitter: HeldJitter;
  kind: EntitySnap['k'];
  bob: number;
  rig: Rig | null;
  lastX: number;
  lastY: number;
  speed: number;
  attack: number;
  /** glTF character once loaded; the procedural rig is the placeholder until then. */
  character: CharacterModel | null;
  attackPending: boolean;
  disposed: boolean;
  /** Dirt mound shown in place of a burrowed monster. */
  mound: Mesh | null;
  /** Monster type, so a death can tell whether it leaves a body (ghosts and totems do not). */
  typeId: EnemyTypeId | null;
  /** Projectiles, novas and zones draw through their spell view. */
  spell: SpellView | null;
  /** Ribbon behind a dashing hero, or -1. */
  dashRibbon: number;
  /** A long body's visual turning point (traits.body.pivot), in world units; null for everything else. */
  pivot: { x: number; y: number; lastX: number; lastY: number; ready: boolean } | null;
}

/** How fast a long body's drawn middle settles back onto where the sim puts it, per second. */
const PIVOT_FOLLOW = 4;

/**
 * Turns a long body about its middle instead of its collider, so a turn swings the head rather
 * than sweeping the tail through walls. The drawn middle moves with the entity and stays put
 * when it only turns, then eases onto where the sim puts the middle, so the drawn head never
 * drifts far from the collider. Only the model moves; the collider, bars and hit tests do not.
 */
function placeAboutPivot(view: View, model: Object3D, x: number, y: number, s: Extract<EntitySnap, { k: 'enemy' }>, dt: number): void {
  const p = view.pivot;
  const along = bodyPivot(s.et, s.r);
  if (!p || along === 0) return;
  const fx = Math.cos(s.a);
  const fy = Math.sin(s.a);
  const tx = x + fx * along;
  const ty = y + fy * along;
  if (!p.ready) {
    p.x = tx;
    p.y = ty;
    p.ready = true;
  } else {
    p.x += x - p.lastX;
    p.y += y - p.lastY;
    const k = Math.min(1, dt * PIVOT_FOLLOW);
    p.x += (tx - p.x) * k;
    p.y += (ty - p.y) * k;
  }
  p.lastX = x;
  p.lastY = y;
  // The model's origin is its collider point; place it so its middle lands on the drawn middle.
  model.position.set(p.x - fx * along - x, model.position.y, p.y - fy * along - y);
}

interface Corpse {
  view: View;
  age: number;
  x: number;
  y: number;
  /** Ghosts and totems leave nothing to raise; they only stay long enough to dissolve. */
  body: boolean;
}

/** Matches the server's corpse lifetime, so a shaman can only raise bodies you can still see. */
const CORPSE_SECONDS = 20;
const CORPSE_SINK_SECONDS = 1.5;
const MAX_CORPSES = 60;
/** How long a monster that leaves no body takes to dissolve before it is gone. */
const DISSOLVE_SECONDS = 1.2;

// Shared geometry: every entity of a kind reuses the same buffers.
const GEO = {
  sphere: new SphereGeometry(1, 16, 12),
  sphereLow: new SphereGeometry(1, 10, 8),
  box: new BoxGeometry(1, 1, 1),
  ring: new RingGeometry(0.86, 1, 48),
  /** Open-ended cone, wide at the ground and thin at the top, for loot light shafts. */
  beam: new CylinderGeometry(0.08, 0.5, 1, 20, 1, true),
  thinRing: new RingGeometry(0.95, 1, 64),
  disk: new CircleGeometry(1, 48),
  plane: new PlaneGeometry(1, 1),
  cone: new ConeGeometry(1, 1, 8),
  cylinder: new CylinderGeometry(1, 1, 1, 10),
  ico: new IcosahedronGeometry(1, 0),
  octa: new OctahedronGeometry(1, 0),
  dodeca: new DodecahedronGeometry(1, 0),
  torus: new TorusGeometry(1, 0.12, 8, 24),
  /** 2 x 2, so a scale of r covers a circle of radius r. */
  quad: new PlaneGeometry(2, 2),
};

/** Materials no view changes after creation, shared for the whole session and never disposed. */
const sharedMats = new Map<string, MeshBasicMaterial>();

function shared(key: string, make: () => MeshBasicMaterial): MeshBasicMaterial {
  let m = sharedMats.get(key);
  if (!m) {
    m = make();
    sharedMats.set(key, m);
  }
  return m;
}

function sharedBasic(color: number, opacity = 1, additive = false): MeshBasicMaterial {
  return shared(`basic|${color}|${opacity}|${additive}`, () => basic(color, opacity, additive));
}

const moundMat = new MeshStandardMaterial({ color: 0x6a5238, roughness: 1, flatShading: true });

function standard(color: number, extra: Partial<{ emissive: number; emissiveIntensity: number; roughness: number; metalness: number; transparent: boolean; opacity: number }> = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...extra });
}

function basic(color: number, opacity = 1, additive = false): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color,
    transparent: opacity < 1 || additive,
    opacity,
    depthWrite: false,
    side: DoubleSide,
    ...(additive ? { blending: AdditiveBlending } : {}),
  });
}

function flatOnGround(mesh: Mesh, y = 1): Mesh {
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.renderOrder = RENDER_ORDER.groundMark;
  return mesh;
}

function makeHealthBar(width: number, color: number): { group: Group; fill: Mesh; width: number } {
  const group = new Group();
  const bg = new Mesh(GEO.plane, barMaterial(0x220808, 0.85));
  bg.scale.set(width + 2, 6, 1);
  // Opacity 0.99 keeps the fill in the transparent pass, so renderOrder puts it above the background.
  const fill = new Mesh(GEO.plane, barMaterial(color, 0.99));
  fill.scale.set(width, 4, 1);
  fill.position.z = 0.1;
  bg.renderOrder = 10;
  fill.renderOrder = 11;
  group.add(bg, fill);
  return { group, fill, width };
}

function barMaterial(color: number, opacity: number): MeshBasicMaterial {
  return shared(`bar|${color}|${opacity}`, () => {
    const m = basic(color, opacity);
    m.depthTest = false;
    return m;
  });
}

function tintMeshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh && o.material instanceof MeshStandardMaterial && !o.userData.noTint) out.push(o);
  });
  return out;
}

/** Gives the view its own copies of its tint materials the first time something needs to change them. */
function ownTint(view: View): MeshStandardMaterial[] {
  if (view.tintable) return view.tintable;
  const copies = new Map<MeshStandardMaterial, MeshStandardMaterial>();
  for (const mesh of view.tintMeshes) {
    const src = mesh.material;
    if (!(src instanceof MeshStandardMaterial)) continue;
    let m = copies.get(src);
    if (!m) {
      m = src;
      if (!view.owned.has(src)) {
        m = cloneMaterial(src);
        view.owned.add(m);
      }
      copies.set(src, m);
    }
    mesh.material = m;
  }
  const out = [...copies.values()];
  for (const m of out) flashFromTexture(m);
  view.tintable = out;
  captureBase(view, out);
  return out;
}

function isBlack(c: Color): boolean {
  return c.r === 0 && c.g === 0 && c.b === 0;
}

/**
 * Textured models (KayKit) have a white material colour, so copying it into the emissive for a hit
 * flash lit the whole model flat white. With the texture as the emissive map too, a white emissive
 * brightens the model's own colours instead. Only where the material has no glow of its own: with
 * a black emissive the map adds nothing until a flash or tint writes it.
 */
function flashFromTexture(m: MeshStandardMaterial): void {
  if (!m.map || m.emissiveMap || !isBlack(m.emissive)) return;
  m.emissiveMap = m.map;
  m.needsUpdate = true;
}

function captureBase(view: View, mats: MeshStandardMaterial[]): void {
  view.baseEmissive = mats.map((m) => m.emissive.clone());
  view.baseIntensity = mats.map((m) => m.emissiveIntensity);
}

/** Trash monsters come in packs; only champions and bosses are worth a shadow pass each. */
function castsShadow(s: EntitySnap): boolean {
  return s.k !== 'enemy' || s.rare || s.boss;
}

function noShadows(root: Object3D): void {
  root.traverse((o) => {
    if (o instanceof Mesh) o.castShadow = false;
  });
}

function baseRadius(s: EntitySnap): number {
  return s.k === 'enemy' ? ENEMIES[s.et].radius : s.k === 'minion' ? MINION_DEFS[s.mt].radius : s.r;
}

/** Puts a loaded glTF character on the view; the procedural rig, if any, stays hidden as a fallback. */
function attachCharacter(view: View, cm: CharacterModel, s: EntitySnap): void {
  // Rares are bigger in the simulation; the model follows the collision radius.
  cm.root.scale.multiplyScalar(s.r / baseRadius(s));
  if (!castsShadow(s)) noShadows(cm.root);
  if (view.rig) view.rig.root.visible = false;
  view.root.add(cm.root);
  view.character = cm;
  for (const r of cm.owned) view.owned.add(r);
  view.tintMeshes = cm.tintMeshes;
  view.tintable = null;
  view.tinted = false;
}

function makeView(item: RenderItem, vfx: Vfx | null): View {
  const root = new Group();
  const s = item.snap;
  const owned = new Set<Disposable>();
  const own = <T extends Disposable>(r: T): T => {
    owned.add(r);
    return r;
  };
  let body: Object3D | null = null;
  let facing: Object3D | null = null;
  let rig: Rig | null = null;
  let healthBar: View['healthBar'] = null;
  let shield: Mesh | null = null;
  let spell: SpellView | null = null;
  // A cached glTF goes straight in; the procedural rig is only a stand-in while a file loads or if it fails.
  const asset = characterAsset(s);
  const character = asset ? characterNow(asset, s.id) : null;

  switch (s.k) {
    case 'player': {
      if (!character) {
        rig = playerModel(s.cls, CLASSES[s.cls].color);
        rig.root.scale.setScalar(s.r);
        root.add(rig.root);
      }
      const ring = flatOnGround(new Mesh(GEO.ring, sharedBasic(item.isSelf ? COLORS.selfRing : COLORS.allyRing, 0.8)));
      ring.scale.setScalar(s.r * 1.5);
      root.add(ring);
      if (!item.isSelf) {
        healthBar = makeHealthBar(34, 0x5fd35f);
        healthBar.group.position.y = s.r * 4.2;
        root.add(healthBar.group);
      }
      break;
    }
    case 'enemy': {
      const def = ENEMIES[s.et];
      if (!character) {
        rig = enemyModel(s.et, def.color);
        rig.root.scale.multiplyScalar(s.r);
        if (!castsShadow(s)) noShadows(rig.root);
        root.add(rig.root);
      }
      if (s.rare) {
        // Rares glow and wear a gold ring, so a champion is readable across the screen. Bosses get a red one.
        const ringColor = s.boss ? 0xff4030 : COLORS.rareOutline;
        const crown = flatOnGround(new Mesh(GEO.ring, sharedBasic(ringColor, 0.9)));
        crown.name = 'rare-ring';
        crown.scale.setScalar(s.r * (s.boss ? 1.9 : 1.6));
        const glow = flatOnGround(new Mesh(GEO.disk, sharedBasic(ringColor, s.boss ? 0.2 : 0.14, true)), 0.6);
        glow.name = 'rare-glow';
        glow.scale.setScalar(s.r * (s.boss ? 2.8 : 2.2));
        root.add(crown, glow);
      }
      healthBar = makeHealthBar(s.boss ? 90 : s.rare ? 54 : 30, s.boss ? 0xff4030 : s.rare ? COLORS.rareOutline : 0xe0a040);
      // Flyers and floaters sit higher, so their bar clears the model.
      const tall = s.et === 'spinner' || s.et === 'blood_bat' || s.et === 'wraith' || s.et === 'banshee' || s.et === 'bone_spire' || s.et === 'flame_totem';
      healthBar.group.position.y = s.r * (tall ? 3.6 : 2.8);
      root.add(healthBar.group);
      break;
    }
    case 'minion': {
      const def = MINION_DEFS[s.mt];
      if (!character) {
        rig = minionModel(s.mt, def.color);
        rig.root.scale.multiplyScalar(s.r);
        root.add(rig.root);
      }
      const ring = flatOnGround(new Mesh(GEO.thinRing, sharedBasic(0xb49cff, 0.7)));
      ring.scale.setScalar(s.r * 1.4);
      root.add(ring);
      healthBar = makeHealthBar(24, 0xb49cff);
      healthBar.group.position.y = s.r * 3.4;
      root.add(healthBar.group);
      break;
    }
    case 'projectile':
    case 'nova':
    case 'zone':
      spell = makeSpellView(s, vfx);
      root.add(spell.root);
      break;
    case 'loot': {
      const color = TIER_COLORS[s.tier];
      const bag = new Mesh(GEO.sphere, own(standard(0x8a6a3a, { roughness: 0.9 })));
      bag.scale.set(s.r * 0.8, s.r * 0.65, s.r * 0.8);
      bag.position.y = s.r * 0.6;
      bag.castShadow = true;
      const tie = new Mesh(GEO.cone, own(standard(color, { emissive: color, emissiveIntensity: 0.6 })));
      tie.scale.set(s.r * 0.35, s.r * 0.5, s.r * 0.35);
      tie.position.y = s.r * 1.3;
      body = new Group();
      body.add(bag, tie);
      root.add(body);
      bag.name = 'placeholder';
      tie.name = 'placeholder';
      if (s.tier !== 'common') {
        // A short tapered light shaft marks good drops across the screen without a pole sticking out of the ground.
        const strong = s.tier === 'relic' ? 1 : s.tier === 'rare' ? 0.7 : 0.4;
        const beam = new Mesh(GEO.beam, own(basic(color, 0.28 * strong, true)));
        beam.scale.set(s.r * (0.9 + strong * 0.6), 60 + strong * 80, s.r * (0.9 + strong * 0.6));
        beam.position.y = beam.scale.y / 2;
        beam.name = 'beam';
        beam.userData.base = 0.28 * strong;
        root.add(beam);
      }
      // Soft and small: a bright disk washed the sack out and read as a spell effect.
      const glow = flatOnGround(new Mesh(GEO.disk, sharedBasic(color, s.tier === 'common' ? 0.06 : 0.12, true)), 0.8);
      glow.scale.setScalar(s.r * 1.4);
      root.add(glow);
      break;
    }
  }

  if (rig) for (const r of rig.owned) owned.add(r);
  if (s.k === 'player' || s.k === 'enemy' || s.k === 'minion') {
    shield = new Mesh(GEO.sphere, own(basic(COLORS.shield, 0.18, true)));
    shield.scale.set(s.r * 1.6, s.r * 2.2, s.r * 1.6);
    shield.position.y = s.r * 1.4;
    shield.visible = false;
    root.add(shield);
  }

  const view: View = {
    root,
    tintMeshes: tintMeshes(root),
    tintable: null,
    baseEmissive: [],
    baseIntensity: [],
    tinted: false,
    owned,
    body,
    facing,
    healthBar,
    shield,
    auraRings: [],
    flash: 0,
    lastFlash: -Infinity,
    shockJitter: new HeldJitter(),
    kind: s.k,
    bob: Math.random() * Math.PI * 2,
    rig,
    lastX: item.x,
    lastY: item.y,
    speed: 0,
    attack: 0,
    character: null,
    attackPending: false,
    disposed: false,
    mound: null,
    typeId: s.k === 'enemy' ? s.et : null,
    spell,
    dashRibbon: -1,
    pivot: s.k === 'enemy' && bodyPivot(s.et, s.r) !== 0 ? { x: 0, y: 0, lastX: 0, lastY: 0, ready: false } : null,
  };
  if (character) attachCharacter(view, character, s);
  else if (rig && s.k === 'enemy' && s.rare) {
    // The glow lives on the procedural rig only; a loaded glTF champion is marked by its ring.
    const mats = ownTint(view);
    for (const m of mats) {
      if (m.emissiveIntensity < 1.5) {
        m.emissive.setHex(COLORS.rareOutline);
        m.emissiveIntensity = 0.18;
      }
    }
    captureBase(view, mats);
  }
  return view;
}

/** Scales a model so its widest horizontal extent is `width`. */
function fitFootprint(o: Object3D, width: number): void {
  const size = new Box3().setFromObject(o).getSize(new Vector3());
  const widest = Math.max(size.x, size.z);
  if (widest > 0) o.scale.multiplyScalar(width / widest);
}

/** Same rule as the server: ghosts and totems leave nothing behind. */
function leavesBody(typeId: EnemyTypeId | null): boolean {
  if (typeId === null) return false;
  const family = familyOf(typeId);
  return family !== 'ghost' && family !== 'totem';
}

const tmpColor = new Color();
/** Reused for every rig every frame, so driving them allocates nothing. */
const rigDrive: RigDrive = { speed: 0, dead: false, dormant: false, hidden: false, dt: 0, seed: 0 };

export class EntityRenderer {
  private readonly views = new Map<string, View>();
  private readonly dying = new Set<EntityId>();
  private corpses: Corpse[] = [];
  private readonly links = new Map<string, { mesh: Mesh; u: TetherUniforms | null }>();
  private readonly linkMat = basic(0x7fe0c0, 0.65, true);
  /** The quality spell views were built for; a change rebuilds them. */
  private quality: VfxQuality | null = null;
  private time = 0;
  // Reused every frame so rendering allocates nothing per entity.
  private readonly seen = new Set<string>();
  private readonly positions = new Map<number, RenderItem>();
  private readonly linkSeen = new Set<string>();
  private readonly linkFrom = new Vector3();
  private readonly linkTo = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    private readonly vfx: Vfx | null = null,
  ) {
    this.quality = vfx?.quality ?? null;
  }

  flash(key: string): void {
    const v = this.views.get(key);
    if (!v || this.time - v.lastFlash < FLASH_COOLDOWN) return;
    v.lastFlash = this.time;
    v.flash = FLASH_SECONDS;
    if (v.rig && !v.character) rigHit(v.rig, v.bob);
  }

  /** What kind of entity a view draws, or null if it is not on screen. */
  kindOf(key: string): EntitySnap['k'] | null {
    return this.views.get(key)?.kind ?? null;
  }

  /** Plays the attack swing on an entity's model. */
  attack(key: string): void {
    const v = this.views.get(key);
    if (!v) return;
    v.attack = 1;
    v.attackPending = true;
    if (v.rig && !v.character) rigAttack(v.rig, v.bob);
  }

  /** A telegraphed ability began: the model holds its wind-up until the attack lands. */
  windup(key: string, seconds: number): void {
    const v = this.views.get(key);
    if (v?.character) windupCharacter(v.character, seconds);
    else if (v?.rig) rigWindup(v.rig, seconds, 'ability', v.bob);
  }

  /** Loads the glTF model for a view and swaps it in for the procedural placeholder. */
  private upgrade(view: View, item: RenderItem): void {
    if (item.snap.k === 'loot') {
      this.upgradeLoot(view, item.snap);
      return;
    }
    const def = characterAsset(item.snap);
    if (!def || view.character) return;
    const s = item.snap;
    loadCharacter(def, s.id)
      .then((cm) => {
        if (view.disposed) {
          for (const r of cm.owned) r.dispose();
          return;
        }
        attachCharacter(view, cm, s);
      })
      .catch(() => {
        // Keep the procedural model if the file fails to load.
      });
  }

  /** Swaps the placeholder bag for the KayKit sack, with coins spilling out for the good stuff. */
  private upgradeLoot(view: View, s: Extract<EntitySnap, { k: 'loot' }>): void {
    // A gold pile is just coins; an item bag is the sack, with coins spilling out for the good stuff.
    const onlyGold = s.count === 0 && s.gold > 0;
    const sack = onlyGold ? undefined : assetById('sack');
    const coins = onlyGold || s.tier === 'rare' || s.tier === 'relic' ? assetById('dungeon_coin_stack') : undefined;
    if (!view.body || (!sack && !coins)) return;
    const body = view.body;
    Promise.all([sack ? instantiate(sack) : Promise.resolve(null), coins ? instantiate(coins) : Promise.resolve(null)])
      .then(([bag, pile]) => {
        if (view.disposed) return;
        for (const o of [...body.children]) if (o.name === 'placeholder') o.visible = false;
        if (bag) {
          // Fit by footprint, not height: the sack is a low, wide model and scaling by height made it a rug.
          fitFootprint(bag.root, s.r * 1.9);
          bag.root.rotation.y = view.bob;
          body.add(bag.root);
        }
        if (pile) {
          fitFootprint(pile.root, s.r * (onlyGold ? 1.4 : 0.9));
          if (bag) pile.root.position.set(s.r * 0.9, 0, s.r * 0.4);
          body.add(pile.root);
        }
      })
      .catch(() => {
        // Keep the placeholder bag if the model fails to load.
      });
  }

  render(items: readonly RenderItem[], dt: number): void {
    this.time += dt;
    this.vfx?.begin(dt);
    if (this.vfx && this.vfx.quality !== this.quality) this.rebuildForQuality();
    beginRigFrame(this.camera);
    const seen = this.seen;
    const positions = this.positions;
    seen.clear();
    positions.clear();

    for (const item of items) {
      seen.add(item.key);
      let view = this.views.get(item.key);
      if (!view || view.kind !== item.snap.k) {
        if (view) this.remove(item.key, view);
        view = makeView(item, this.vfx);
        this.views.set(item.key, view);
        this.scene.add(view.root);
        this.upgrade(view, item);
      }
      view.root.position.set(item.x, 0, item.y);
      if (item.key.startsWith('s')) positions.set(item.snap.id, item);
      this.update(view, item, dt);
    }

    for (const [key, view] of this.views) {
      if (seen.has(key)) continue;
      const id = Number(key.slice(1));
      if (view.kind === 'enemy' && key.startsWith('s') && this.dying.delete(id)) this.toCorpse(key, view, leavesBody(view.typeId));
      else this.remove(key, view);
    }
    this.updateCorpses(dt);
    this.renderLinks(items, positions, dt);
  }

  /** Called on the death event, just before the entity leaves the snapshot, so it falls instead of vanishing. */
  markDying(id: EntityId): void {
    this.dying.add(id);
  }

  /** A shaman raised this body; the monster that stands up replaces it. */
  removeCorpseNear(x: number, y: number): void {
    let best = -1;
    let bestD = 40;
    this.corpses.forEach((c, i) => {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const c = this.corpses[best];
    if (!c?.body) return;
    this.corpses.splice(best, 1);
    this.disposeView(c.view);
  }

  private toCorpse(key: string, view: View, body: boolean): void {
    this.views.delete(key);
    if (view.healthBar) view.healthBar.group.visible = false;
    if (view.shield) view.shield.visible = false;
    for (const r of view.auraRings) r.visible = false;
    if (view.mound) view.mound.visible = false;
    for (const name of ['ring', 'rare-ring', 'rare-glow']) {
      const o = view.root.getObjectByName(name);
      if (o) o.visible = false;
    }
    // Bodies are darker than the living and do not glow, so a fight's aftermath does not read as more monsters.
    ownTint(view).forEach((m) => {
      m.color.multiplyScalar(0.55);
      m.emissiveIntensity = 0;
    });
    this.corpses.push({ view, age: 0, x: view.root.position.x, y: view.root.position.z, body });
    while (this.corpses.length > MAX_CORPSES) {
      const old = this.corpses.shift();
      if (old) this.disposeView(old.view);
    }
  }

  private updateCorpses(dt: number): void {
    this.corpses = this.corpses.filter((c) => {
      c.age += dt;
      const v = c.view;
      if (v.character) driveCharacter(v.character, { speed: 0, attack: false, dead: true, dormant: false, dt });
      else if (v.rig) {
        rigDrive.speed = 0;
        rigDrive.dead = true;
        rigDrive.dormant = false;
        rigDrive.hidden = false;
        rigDrive.dt = dt;
        rigDrive.seed = v.bob;
        driveRig(v.rig, rigDrive);
      }
      if (!c.body) {
        if (c.age < DISSOLVE_SECONDS) return true;
        this.disposeView(v);
        return false;
      }
      if (c.age > CORPSE_SECONDS) v.root.position.y = -((c.age - CORPSE_SECONDS) / CORPSE_SINK_SECONDS) * 30;
      if (c.age < CORPSE_SECONDS + CORPSE_SINK_SECONDS) return true;
      this.disposeView(v);
      return false;
    });
  }

  private remove(key: string, view: View): void {
    this.disposeView(view);
    this.views.delete(key);
  }

  /** Spell views, auras and tethers are built per quality; drop them so they rebuild on the next frame. */
  private rebuildForQuality(): void {
    this.quality = this.vfx?.quality ?? null;
    for (const [key, view] of this.views) {
      // The ribbon batch was replaced with the quality; an old handle would release someone else's ribbon.
      view.dashRibbon = -1;
      if (view.spell) this.remove(key, view);
      else if (view.auraRings.length > 0) {
        for (const r of view.auraRings) this.dropAura(view, r);
        view.auraRings.length = 0;
      }
    }
    for (const [key, link] of this.links) this.dropLink(key, link);
  }

  private disposeView(view: View): void {
    view.disposed = true;
    view.spell?.dispose();
    view.spell = null;
    if (view.dashRibbon >= 0) this.vfx?.ribbons.release(view.dashRibbon);
    view.dashRibbon = -1;
    for (const r of view.auraRings) this.dropAura(view, r);
    this.scene.remove(view.root);
    // Only what this view created: glTF geometry, procedural shapes and cached materials are shared with other entities.
    for (const r of view.owned) r.dispose();
    view.owned.clear();
  }

  private update(view: View, item: RenderItem, dt: number): void {
    const s = item.snap;
    const t = this.time;
    if (view.facing && 'a' in s) view.facing.rotation.y = -s.a;

    const rig = view.rig;
    if ((rig || view.character) && (s.k === 'player' || s.k === 'enemy' || s.k === 'minion')) {
      // Walk cycles follow actual on-screen speed, so interpolated and predicted motion both animate right.
      const moved = Math.hypot(item.x - view.lastX, item.y - view.lastY);
      view.lastX = item.x;
      view.lastY = item.y;
      const inst = dt > 0 ? moved / dt : 0;
      view.speed += (inst - view.speed) * Math.min(1, dt * 12);
      view.attack = Math.max(0, view.attack - dt * 4);
      if (view.character) {
        view.character.root.rotation.y = -s.a;
        if (s.k === 'enemy') placeAboutPivot(view, view.character.root, item.x, item.y, s, dt);
        driveCharacter(view.character, {
          speed: view.speed,
          attack: view.attackPending,
          dead: s.k === 'player' && s.dead,
          dormant: s.k === 'enemy' && s.dormant,
          dt,
        });
        view.attackPending = false;
      } else if (rig) {
        rig.root.rotation.y = -s.a;
        if (s.k === 'enemy') placeAboutPivot(view, rig.root, item.x, item.y, s, dt);
        rigDrive.speed = view.speed;
        rigDrive.dead = s.k === 'player' && s.dead;
        rigDrive.dormant = s.k === 'enemy' && s.dormant;
        rigDrive.hidden = s.k === 'enemy' && (s.st & STATUS.hidden) !== 0;
        rigDrive.dt = dt;
        rigDrive.seed = view.bob;
        driveRig(rig, rigDrive);
      }
      if (s.k === 'player') {
        if (!view.character && rig) rig.root.position.y = s.dashing && !s.dead ? 6 : 0;
        this.syncAuras(view, s, item, dt);
        this.syncDash(view, s.dashing && !s.dead, item, dt);
      }
    } else if (view.spell && (s.k === 'projectile' || s.k === 'nova' || s.k === 'zone')) {
      view.spell.update(s, item.x, item.y, dt);
    } else if (s.k === 'loot') {
      // The bag sits on the ground like a dropped item; only the light shaft breathes.
      const beam = view.root.getObjectByName('beam');
      if (beam instanceof Mesh && beam.material instanceof MeshBasicMaterial) beam.material.opacity = beam.userData.base * (0.75 + Math.sin(t * 2.2 + view.bob) * 0.25);
    }

    if ('life' in s && view.healthBar) {
      const ratio = s.maxLife > 0 ? Math.max(0, s.life / s.maxLife) : 0;
      const hb = view.healthBar;
      hb.fill.scale.x = Math.max(0.001, hb.width * ratio);
      hb.fill.position.x = -(hb.width * (1 - ratio)) / 2;
      hb.group.quaternion.copy(this.camera.quaternion);
      // Unhurt trash hides its bar to keep the screen clean; rares and allies always show one.
      const alwaysShow = s.k !== 'enemy' || s.rare;
      hb.group.visible = !(s.k === 'player' && s.dead) && (alwaysShow || ratio < 1);
    }

    if (s.k === 'enemy') this.syncBurrow(view, s.st, s.r, t);

    if ('st' in s) {
      if (view.shield) {
        view.shield.visible = (s.st & STATUS.shield) !== 0;
        const mat = view.shield.material;
        if (mat instanceof MeshBasicMaterial) {
          mat.color.setHex((s.st & STATUS.burningShield) !== 0 ? COLORS.burningShield : COLORS.shield);
          mat.opacity = 0.14 + Math.sin(t * 6) * 0.05;
        }
      }
      this.applyTint(view, s.st, dt);
      if (this.vfx && (s.st & (STATUS.burn | STATUS.chill | STATUS.shock | STATUS.poison)) !== 0 && (s.st & STATUS.hidden) === 0 && !(s.k === 'player' && s.dead)) {
        this.vfx.status(s.id, item.x, item.y, s.r, s.r * 2.6, (s.st & STATUS.burn) !== 0, (s.st & STATUS.chill) !== 0, (s.st & STATUS.shock) !== 0, (s.st & STATUS.poison) !== 0, dt);
      }
    } else if (view.flash > 0) {
      view.flash -= dt;
    }
  }

  /** Burrowed monsters vanish into a moving dirt mound and lose their health bar. */
  private syncBurrow(view: View, st: number, r: number, t: number): void {
    const hidden = (st & STATUS.hidden) !== 0;
    if (hidden && !view.mound) {
      const mound = new Mesh(GEO.sphereLow, moundMat);
      mound.scale.set(r * 1.2, r * 0.35, r * 1.2);
      view.root.add(mound);
      view.mound = mound;
    }
    if (view.mound) {
      view.mound.visible = hidden;
      view.mound.position.y = Math.sin(t * 9) * 1.5;
    }
    const model = view.character?.root ?? view.rig?.root;
    if (model) model.visible = !hidden && (view.character !== null || model === view.rig?.root);
    if (view.character && view.rig) view.rig.root.visible = false;
    if (hidden && view.healthBar) view.healthBar.group.visible = false;
    for (const c of view.root.children) if (c !== view.mound && c !== model && c !== view.healthBar?.group && c !== view.rig?.root) c.visible = !hidden;
  }

  private applyTint(view: View, st: number, dt: number): void {
    view.flash = Math.max(0, view.flash - dt);
    let r = 0;
    let g = 0;
    let b = 0;
    let k = 0;
    // With status particles on, the flames, frost and sparks carry the status; a full tint on top
    // turned every burning monster into a flat orange silhouette.
    // On Low the tint is the only status cue, but at full strength it hid the monster under a flat
    // colour; 0.4 still reads.
    const particles = this.vfx?.level.statusParticles === true;
    const burnK = particles ? 0.11 : 0.4;
    const ailK = particles ? 0.09 : 0.4;
    if ((st & STATUS.burn) !== 0) {
      const f = 0.5 + Math.sin(this.time * 18) * 0.3;
      r += 1 * f;
      g += 0.35 * f;
      k = burnK;
    }
    if ((st & STATUS.chill) !== 0) {
      r += 0.1;
      g += 0.45;
      b += 1;
      k = Math.max(k, ailK);
    }
    if ((st & STATUS.poison) !== 0) {
      // A slow sickly pulse, the same weight as chill; the drip and mist carry it on Medium and High.
      const f = 0.8 + Math.sin(this.time * 3) * 0.2;
      r += 0.4 * f;
      g += 0.62 * f;
      b += 0.1 * f;
      k = Math.max(k, ailK);
    }
    if ((st & STATUS.cursed) !== 0) {
      // A slow purple pulse: the mummy's curse is on you and your hits are weaker.
      const f = 0.5 + Math.sin(this.time * 4) * 0.25;
      r += 0.6 * f;
      b += 1 * f;
      k = Math.max(k, 0.55);
    }
    if ((st & STATUS.enraged) !== 0) {
      const f = 0.6 + Math.sin(this.time * 10) * 0.4;
      r += 1.2 * f;
      g += 0.1 * f;
      k = Math.max(k, 0.7);
    }
    if ((st & STATUS.shock) !== 0) {
      const f = 0.6 * view.shockJitter.next(dt);
      r += f;
      g += f * 0.95;
      b += f * 0.3;
      k = Math.max(k, ailK);
    }
    const active = view.flash > 0 || k > 0;
    // Untouched views keep their shared materials; there is nothing to write or undo.
    if (!active && !view.tinted) return;
    view.tinted = active;
    ownTint(view).forEach((m, i) => {
      const base = view.baseEmissive[i];
      if (!base) return;
      if (view.flash > 0) {
        // Brighten the entity's own colours so a unit under constant attack stays recognisable:
        // through the texture on textured models (see flashFromTexture), the material colour on
        // rigs, and a flare of their own glow on textured models that have one.
        const strength = this.vfx?.level.shaders ? 0.25 : 0.35;
        if (m.map && m.emissiveMap === m.map) {
          m.emissive.setRGB(1, 1, 1);
          m.emissiveIntensity = strength;
        } else if (m.map) {
          m.emissive.copy(base);
          m.emissiveIntensity = (view.baseIntensity[i] ?? 1) * 1.6;
        } else {
          m.emissive.copy(m.color);
          m.emissiveIntensity = strength;
        }
      } else if (k > 0) {
        tmpColor.setRGB(Math.min(1, r), Math.min(1, g), Math.min(1, b));
        m.emissive.copy(tmpColor);
        m.emissiveIntensity = k;
      } else {
        m.emissive.copy(base);
        m.emissiveIntensity = view.baseIntensity[i] ?? 1;
      }
    });
  }

  private syncAuras(view: View, s: Extract<EntitySnap, { k: 'player' }>, item: RenderItem, dt: number): void {
    while (view.auraRings.length > s.auras.length) {
      const ring = view.auraRings.pop();
      if (ring) this.dropAura(view, ring);
    }
    const vfx = this.vfx;
    const shaded = vfx !== null && vfx.level.shaders;
    s.auras.forEach((a, i) => {
      let ring = view.auraRings[i];
      if (!ring) {
        if (shaded) {
          // A faint runic circle the size of the aura; the quad is 2 wide, so its scale is the radius.
          const m = auraMaterial(styleOf(a.el, a.fx), vfx.shared);
          ring = flatOnGround(new Mesh(GEO.quad, m.material), 1.1 + i * 0.1);
          ring.userData.owned = true;
        } else {
          ring = flatOnGround(new Mesh(GEO.thinRing, sharedBasic(fxColor(a.fx, a.el), 0.5, true)), 1.2 + i * 0.1);
          const fill = flatOnGround(new Mesh(GEO.disk, sharedBasic(fxColor(a.fx, a.el), 0.06, true)), -0.2);
          ring.add(fill);
          fill.rotation.x = 0;
        }
        ring.renderOrder = RENDER_ORDER.groundEffect;
        view.root.add(ring);
        view.auraRings.push(ring);
      }
      if (shaded) {
        ring.scale.setScalar(a.r);
        vfx.aura(styleOf(a.el, a.fx), item.x, item.y, a.r, dt);
      } else {
        const pulse = 1 + Math.sin(this.time * 2 + i) * 0.015;
        ring.scale.setScalar(a.r * pulse);
        ring.rotation.z += 0.004;
      }
    });
  }

  private dropAura(view: View, ring: Mesh): void {
    view.root.remove(ring);
    const m = ring.material;
    if (ring.userData.owned === true && !Array.isArray(m)) m.dispose();
  }

  /** Dust and a pale streak behind a dashing hero. */
  private syncDash(view: View, dashing: boolean, item: RenderItem, dt: number): void {
    const vfx = this.vfx;
    if (!vfx || !vfx.level.shaders) {
      view.dashRibbon = -1;
      return;
    }
    if (dashing) {
      if (view.dashRibbon < 0) {
        const c = PALETTE.plain.core;
        view.dashRibbon = vfx.ribbons.acquire(c.r * 0.5, c.g * 0.5, c.b * 0.5, 9, 0.3, 0);
      }
      vfx.ribbons.push(view.dashRibbon, item.x, 14, item.y, vfx.time);
      vfx.dash(item.x, item.y, dt);
    } else if (view.dashRibbon >= 0) {
      vfx.ribbons.release(view.dashRibbon);
      view.dashRibbon = -1;
    }
  }

  private dropLink(key: string, link: { mesh: Mesh; u: TetherUniforms | null }): void {
    this.scene.remove(link.mesh);
    const m = link.mesh.material;
    if (link.u && !Array.isArray(m)) m.dispose();
    this.links.delete(key);
  }

  /** Links draw as glowing tethers between the caster and the target. */
  private renderLinks(items: readonly RenderItem[], positions: Map<number, RenderItem>, dt: number): void {
    const seen = this.linkSeen;
    seen.clear();
    const vfx = this.vfx;
    const shaded = vfx !== null && vfx.level.shaders;
    for (const item of items) {
      if (item.snap.k !== 'player') continue;
      for (const target of item.snap.links) {
        const to = positions.get(target);
        if (!to) continue;
        const key = `${item.snap.id}-${target}`;
        seen.add(key);
        let link = this.links.get(key);
        if (!link) {
          if (shaded) {
            const m = tetherMaterial(vfx.shared);
            link = { mesh: new Mesh(GEO.cylinder, m.material), u: m.u };
          } else link = { mesh: new Mesh(GEO.cylinder, this.linkMat), u: null };
          this.links.set(key, link);
          this.scene.add(link.mesh);
        }
        const m = link.mesh;
        const a = this.linkFrom.set(item.x, 30, item.y);
        const b = this.linkTo.set(to.x, 30, to.y);
        const len = a.distanceTo(b);
        m.position.copy(a).add(b).multiplyScalar(0.5);
        const thick = link.u ? 2.4 : 2 + Math.sin(this.time * 8) * 0.6;
        m.scale.set(thick, len, thick);
        m.lookAt(b);
        m.rotateX(Math.PI / 2);
        if (link.u && vfx) {
          link.u.uLength.value = len;
          vfx.tether(item.x, item.y, to.x, to.y, 30, dt);
          vfx.light(entityLightKey(item.snap.id, 3), (item.x + to.x) / 2, (item.y + to.y) / 2, 30, PALETTE.ward.body, 0.6, Math.min(200, len * 0.6));
        }
      }
    }
    for (const [key, link] of this.links) {
      if (seen.has(key)) continue;
      this.dropLink(key, link);
    }
  }
}
