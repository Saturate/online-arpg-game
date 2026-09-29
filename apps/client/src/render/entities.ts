import { CLASSES, ENEMIES, familyOf, MINION_DEFS, STATUS, type ClassId, type EnemyTypeId, type EntityId, type EntitySnap } from '@rune/shared';
import {
  Box3,
  AdditiveBlending,
  BackSide,
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
  type Material,
  type Object3D,
  type Scene,
} from 'three';
import { COLORS, ELEMENT_COLORS, fxColor, TIER_COLORS } from './config.js';
import { assetById, instantiate } from './assets.js';
import { characterAsset, driveCharacter, loadCharacter, type CharacterModel } from './characters.js';
import { animate, enemyModel, minionModel, playerModel, uniqueMaterials, type Rig } from './models.js';

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

interface View {
  root: Group;
  /** Materials that get the hit flash and status tint. */
  tintable: MeshStandardMaterial[];
  baseEmissive: Color[];
  baseIntensity: number[];
  body: Object3D | null;
  facing: Object3D | null;
  healthBar: { group: Group; fill: Mesh; width: number } | null;
  shield: Mesh | null;
  auraRings: Mesh[];
  flash: number;
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
}

interface Corpse {
  view: View;
  age: number;
  x: number;
  y: number;
}

/** Matches the server's corpse lifetime, so a shaman can only raise bodies you can still see. */
const CORPSE_SECONDS = 20;
const CORPSE_SINK_SECONDS = 1.5;
const MAX_CORPSES = 60;
const FALL_SECONDS = 0.35;

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
};

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
  return mesh;
}

function makeHealthBar(width: number, color: number): { group: Group; fill: Mesh; width: number } {
  const group = new Group();
  const bg = new Mesh(GEO.plane, basic(0x220808, 0.85));
  bg.scale.set(width + 2, 6, 1);
  // Opacity 0.99 keeps the fill in the transparent pass, so renderOrder puts it above the background.
  const fill = new Mesh(GEO.plane, basic(color, 0.99));
  fill.scale.set(width, 4, 1);
  fill.position.z = 0.1;
  bg.renderOrder = 10;
  fill.renderOrder = 11;
  for (const m of [bg, fill]) {
    const mat = m.material;
    if (mat instanceof MeshBasicMaterial) mat.depthTest = false;
  }
  group.add(bg, fill);
  return { group, fill, width };
}

function tintables(root: Object3D): MeshStandardMaterial[] {
  const out: MeshStandardMaterial[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh && o.material instanceof MeshStandardMaterial && !o.userData.noTint) out.push(o.material);
  });
  return out;
}

function makeView(item: RenderItem): View {
  const root = new Group();
  const s = item.snap;
  let body: Object3D | null = null;
  let facing: Object3D | null = null;
  let rig: Rig | null = null;
  let healthBar: View['healthBar'] = null;
  let shield: Mesh | null = null;

  switch (s.k) {
    case 'player': {
      rig = playerModel(s.cls, CLASSES[s.cls].color);
      rig.root.scale.setScalar(s.r);
      uniqueMaterials(rig.root);
      root.add(rig.root);
      const ring = flatOnGround(new Mesh(GEO.ring, basic(item.isSelf ? COLORS.selfRing : COLORS.allyRing, 0.8)));
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
      rig = enemyModel(s.et, def.color);
      rig.root.scale.multiplyScalar(s.r);
      uniqueMaterials(rig.root);
      root.add(rig.root);
      if (s.rare) {
        // Rares glow and wear a gold ring, so a champion is readable across the screen. Bosses get a red one.
        const ringColor = s.boss ? 0xff4030 : COLORS.rareOutline;
        const crown = flatOnGround(new Mesh(GEO.ring, basic(ringColor, 0.9)));
        crown.name = 'rare-ring';
        crown.scale.setScalar(s.r * (s.boss ? 1.9 : 1.6));
        const glow = flatOnGround(new Mesh(GEO.disk, basic(ringColor, s.boss ? 0.2 : 0.14, true)), 0.6);
        glow.name = 'rare-glow';
        glow.scale.setScalar(s.r * (s.boss ? 2.8 : 2.2));
        root.add(crown, glow);
        rig.root.traverse((o) => {
          if (o instanceof Mesh && o.material instanceof MeshStandardMaterial && o.material.emissiveIntensity < 1.5) {
            o.material.emissive.setHex(COLORS.rareOutline);
            o.material.emissiveIntensity = 0.18;
          }
        });
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
      rig = minionModel(s.mt, def.color);
      rig.root.scale.multiplyScalar(s.r);
      uniqueMaterials(rig.root);
      root.add(rig.root);
      const ring = flatOnGround(new Mesh(GEO.thinRing, basic(0xb49cff, 0.7)));
      ring.scale.setScalar(s.r * 1.4);
      root.add(ring);
      healthBar = makeHealthBar(24, 0xb49cff);
      healthBar.group.position.y = s.r * 3.4;
      root.add(healthBar.group);
      break;
    }
    case 'projectile': {
      const enemy = s.team === 'enemies';
      if (enemy) {
        const core = new Mesh(GEO.sphere, new MeshBasicMaterial({ color: COLORS.enemyBullet }));
        core.scale.setScalar(s.r);
        const outline = new Mesh(GEO.sphere, new MeshBasicMaterial({ color: COLORS.enemyBulletOutline, side: BackSide }));
        outline.scale.setScalar(s.r * 1.4);
        const g = new Group();
        g.add(core, outline);
        g.position.y = 18;
        root.add(g);
      } else {
        // Solid core in the element colour plus a faint additive halo: additive alone washes out to white on bright ground.
        const color = s.el ? ELEMENT_COLORS[s.el] : s.fx === 'damage' ? COLORS.playerProjectile : fxColor(s.fx, null);
        const core = new Mesh(GEO.sphere, basic(color, 0.9));
        core.scale.setScalar(s.r * 0.8);
        const halo = new Mesh(GEO.sphere, basic(color, 0.25, true));
        halo.scale.setScalar(s.r * 1.4);
        const g = new Group();
        g.add(core, halo);
        g.position.y = 18;
        root.add(g);
      }
      break;
    }
    case 'swing': {
      const half = s.arc / 2;
      const m = new Mesh(new RingGeometry(s.r * 0.35, s.r, 24, 1, -s.a - half, s.arc), basic(0xffffff, 0.35, true));
      flatOnGround(m, 2);
      root.add(m);
      break;
    }
    case 'nova': {
      const color = fxColor(s.fx, s.el);
      const m = flatOnGround(new Mesh(GEO.ring, basic(color, 0.8, true)), 3);
      m.name = 'ring';
      const fill = flatOnGround(new Mesh(GEO.disk, basic(color, 0.15, true)), 2);
      fill.name = 'fill';
      root.add(m, fill);
      break;
    }
    case 'zone': {
      const color = fxColor(s.fx, s.el);
      const fill = flatOnGround(new Mesh(GEO.disk, basic(color, 0.22, true)), 1.5);
      fill.scale.setScalar(s.r);
      fill.name = 'fill';
      const edge = flatOnGround(new Mesh(GEO.thinRing, basic(color, 0.9, true)), 2);
      edge.scale.setScalar(s.r);
      edge.name = 'edge';
      root.add(fill, edge);
      break;
    }
    case 'loot': {
      const color = TIER_COLORS[s.tier];
      const bag = new Mesh(GEO.sphere, standard(0x8a6a3a, { roughness: 0.9 }));
      bag.scale.set(s.r * 0.8, s.r * 0.65, s.r * 0.8);
      bag.position.y = s.r * 0.6;
      bag.castShadow = true;
      const tie = new Mesh(GEO.cone, standard(color, { emissive: color, emissiveIntensity: 0.6 }));
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
        const beam = new Mesh(GEO.beam, basic(color, 0.28 * strong, true));
        beam.scale.set(s.r * (0.9 + strong * 0.6), 60 + strong * 80, s.r * (0.9 + strong * 0.6));
        beam.position.y = beam.scale.y / 2;
        beam.name = 'beam';
        beam.userData.base = 0.28 * strong;
        root.add(beam);
      }
      // Soft and small: a bright disk washed the sack out and read as a spell effect.
      const glow = flatOnGround(new Mesh(GEO.disk, basic(color, s.tier === 'common' ? 0.06 : 0.12, true)), 0.8);
      glow.scale.setScalar(s.r * 1.4);
      root.add(glow);
      break;
    }
  }

  if (s.k === 'player' || s.k === 'enemy' || s.k === 'minion') {
    shield = new Mesh(GEO.sphere, basic(COLORS.shield, 0.18, true));
    shield.scale.set(s.r * 1.6, s.r * 2.2, s.r * 1.6);
    shield.position.y = s.r * 1.4;
    shield.visible = false;
    root.add(shield);
  }

  const tint = tintables(root);
  return {
    root,
    tintable: tint,
    baseEmissive: tint.map((m) => m.emissive.clone()),
    baseIntensity: tint.map((m) => m.emissiveIntensity),
    body,
    facing,
    healthBar,
    shield,
    auraRings: [],
    flash: 0,
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
  };
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

export class EntityRenderer {
  private readonly views = new Map<string, View>();
  private readonly dying = new Set<EntityId>();
  private corpses: Corpse[] = [];
  private readonly links = new Map<string, Mesh>();
  private readonly linkMat = basic(0x7fe0c0, 0.65, true);
  private time = 0;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {}

  flash(key: string): void {
    const v = this.views.get(key);
    if (v) v.flash = FLASH_SECONDS;
  }

  /** Plays the attack swing on an entity's model. */
  attack(key: string): void {
    const v = this.views.get(key);
    if (!v) return;
    v.attack = 1;
    v.attackPending = true;
  }

  /** Loads the glTF model for a view and swaps it in for the procedural placeholder. */
  private upgrade(view: View, item: RenderItem): void {
    if (item.snap.k === 'loot') {
      this.upgradeLoot(view, item.snap);
      return;
    }
    const def = characterAsset(item.snap);
    if (!def || !view.rig) return;
    const s = item.snap;
    const baseRadius = s.k === 'enemy' ? ENEMIES[s.et].radius : s.k === 'minion' ? MINION_DEFS[s.mt].radius : s.r;
    loadCharacter(def, s.id)
      .then((cm) => {
        if (view.disposed || !view.rig) return;
        // Rares are bigger in the simulation; the model follows the collision radius.
        cm.root.scale.multiplyScalar(s.r / baseRadius);
        view.rig.root.visible = false;
        view.root.add(cm.root);
        view.character = cm;
        view.tintable = cm.materials;
        view.baseEmissive = cm.baseEmissive;
        view.baseIntensity = cm.baseIntensity;
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
    const seen = new Set<string>();
    const positions = new Map<number, { x: number; y: number }>();

    for (const item of items) {
      seen.add(item.key);
      let view = this.views.get(item.key);
      if (!view || view.kind !== item.snap.k) {
        if (view) this.remove(item.key, view);
        view = makeView(item);
        this.views.set(item.key, view);
        this.scene.add(view.root);
        this.upgrade(view, item);
      }
      view.root.position.set(item.x, 0, item.y);
      if (item.key.startsWith('s')) positions.set(item.snap.id, { x: item.x, y: item.y });
      this.update(view, item, dt);
    }

    for (const [key, view] of this.views) {
      if (seen.has(key)) continue;
      const id = Number(key.slice(1));
      if (view.kind === 'enemy' && key.startsWith('s') && this.dying.delete(id) && leavesBody(view.typeId)) this.toCorpse(key, view);
      else this.remove(key, view);
    }
    this.updateCorpses(dt);
    this.renderLinks(items, positions);
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
    if (!c) return;
    this.corpses.splice(best, 1);
    this.disposeView(c.view);
  }

  private toCorpse(key: string, view: View): void {
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
    view.tintable.forEach((m) => {
      m.color.multiplyScalar(0.55);
      m.emissiveIntensity = 0;
    });
    this.corpses.push({ view, age: 0, x: view.root.position.x, y: view.root.position.z });
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
        // Procedural models have no death clip, so they topple sideways and settle.
        const k = Math.min(1, c.age / FALL_SECONDS);
        v.rig.root.rotation.z = (Math.PI / 2) * k * k;
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

  private disposeView(view: View): void {
    view.disposed = true;
    this.scene.remove(view.root);
    view.root.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const mats: Material[] = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.dispose();
      // Shared geometries are reused; only per-view geometry is disposed.
      if (!Object.values(GEO).some((g) => g === o.geometry)) o.geometry.dispose();
    });
  }

  private update(view: View, item: RenderItem, dt: number): void {
    const s = item.snap;
    const t = this.time;
    if (view.facing && 'a' in s) view.facing.rotation.y = -s.a;

    if (view.rig && (s.k === 'player' || s.k === 'enemy' || s.k === 'minion')) {
      // Walk cycles follow actual on-screen speed, so interpolated and predicted motion both animate right.
      const moved = Math.hypot(item.x - view.lastX, item.y - view.lastY);
      view.lastX = item.x;
      view.lastY = item.y;
      const inst = dt > 0 ? moved / dt : 0;
      view.speed += (inst - view.speed) * Math.min(1, dt * 12);
      view.attack = Math.max(0, view.attack - dt * 4);
      if (view.character) {
        view.character.root.rotation.y = -s.a;
        driveCharacter(view.character, {
          speed: view.speed,
          attack: view.attackPending,
          dead: s.k === 'player' && s.dead,
          dormant: s.k === 'enemy' && s.dormant,
          dt,
        });
        view.attackPending = false;
      } else {
        view.rig.root.rotation.y = -s.a;
        animate(view.rig, t, dt, view.speed, view.attack, view.bob);
      }
      if (s.k === 'player') {
        if (!view.character) {
          view.rig.root.rotation.z = s.dead ? Math.PI / 2 : 0;
          view.rig.root.position.y = s.dead ? s.r * 0.4 : s.dashing ? 6 : 0;
        }
        this.syncAuras(view, s);
      }
    } else if (s.k === 'nova') {
      const ring = view.root.getObjectByName('ring');
      const fill = view.root.getObjectByName('fill');
      const k = s.maxR > 0 ? s.r / s.maxR : 1;
      if (ring) ring.scale.setScalar(Math.max(1, s.r));
      if (fill) fill.scale.setScalar(Math.max(1, s.r));
      for (const o of [ring, fill]) if (o instanceof Mesh && o.material instanceof MeshBasicMaterial) o.material.opacity = (o === ring ? 0.9 : 0.2) * (1 - k * 0.6);
    } else if (s.k === 'zone') {
      const fill = view.root.getObjectByName('fill');
      const edge = view.root.getObjectByName('edge');
      const pulse = 0.18 + Math.sin(t * 5) * 0.05;
      const fade = Math.min(1, s.left * 4);
      if (fill instanceof Mesh && fill.material instanceof MeshBasicMaterial) fill.material.opacity = pulse * fade;
      if (edge instanceof Mesh && edge.material instanceof MeshBasicMaterial) edge.material.opacity = 0.85 * fade;
      if (edge) edge.rotation.z += dt * 0.4;
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
    } else if (view.flash > 0) {
      view.flash -= dt;
    }
  }

  /** Burrowed monsters vanish into a moving dirt mound and lose their health bar. */
  private syncBurrow(view: View, st: number, r: number, t: number): void {
    const hidden = (st & STATUS.hidden) !== 0;
    if (hidden && !view.mound) {
      const mound = new Mesh(GEO.sphereLow, new MeshStandardMaterial({ color: 0x6a5238, roughness: 1, flatShading: true }));
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
    if ((st & STATUS.burn) !== 0) {
      const f = 0.5 + Math.sin(this.time * 18) * 0.3;
      r += 1 * f;
      g += 0.35 * f;
      k = 0.6;
    }
    if ((st & STATUS.chill) !== 0) {
      r += 0.1;
      g += 0.45;
      b += 1;
      k = Math.max(k, 0.5);
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
      const f = Math.random() < 0.3 ? 1 : 0.3;
      r += f;
      g += f * 0.95;
      b += f * 0.3;
      k = Math.max(k, 0.5);
    }
    view.tintable.forEach((m, i) => {
      const base = view.baseEmissive[i];
      if (!base) return;
      if (view.flash > 0) {
        // Brighten the entity's own colour so a unit under constant attack stays recognisable.
        m.emissive.copy(m.color);
        m.emissiveIntensity = 0.7;
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

  private syncAuras(view: View, s: Extract<EntitySnap, { k: 'player' }>): void {
    while (view.auraRings.length > s.auras.length) {
      const ring = view.auraRings.pop();
      if (ring) view.root.remove(ring);
    }
    s.auras.forEach((a, i) => {
      let ring = view.auraRings[i];
      if (!ring) {
        ring = flatOnGround(new Mesh(GEO.thinRing, basic(fxColor(a.fx, a.el), 0.5, true)), 1.2 + i * 0.1);
        const fill = flatOnGround(new Mesh(GEO.disk, basic(fxColor(a.fx, a.el), 0.06, true)), -0.2);
        ring.add(fill);
        fill.rotation.x = 0;
        view.root.add(ring);
        view.auraRings.push(ring);
      }
      const pulse = 1 + Math.sin(this.time * 2 + i) * 0.015;
      ring.scale.setScalar(a.r * pulse);
      ring.rotation.z += 0.004;
    });
  }

  /** Links draw as glowing tethers between the caster and the target. */
  private renderLinks(items: readonly RenderItem[], positions: Map<number, { x: number; y: number }>): void {
    const seen = new Set<string>();
    for (const item of items) {
      if (item.snap.k !== 'player') continue;
      for (const target of item.snap.links) {
        const to = positions.get(target);
        if (!to) continue;
        const key = `${item.snap.id}-${target}`;
        seen.add(key);
        let m = this.links.get(key);
        if (!m) {
          m = new Mesh(GEO.cylinder, this.linkMat);
          this.links.set(key, m);
          this.scene.add(m);
        }
        const a = new Vector3(item.x, 30, item.y);
        const b = new Vector3(to.x, 30, to.y);
        const len = a.distanceTo(b);
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.scale.set(2 + Math.sin(this.time * 8) * 0.6, len, 2 + Math.sin(this.time * 8) * 0.6);
        m.lookAt(b);
        m.rotateX(Math.PI / 2);
      }
    }
    for (const [key, m] of this.links) {
      if (seen.has(key)) continue;
      this.scene.remove(m);
      this.links.delete(key);
    }
  }
}
