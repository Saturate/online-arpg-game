import { CLASSES, ENEMIES, MINION_DEFS, STATUS, type ClassId, type EntitySnap } from '@rune/shared';
import {
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
}

// Shared geometry: every entity of a kind reuses the same buffers.
const GEO = {
  sphere: new SphereGeometry(1, 16, 12),
  sphereLow: new SphereGeometry(1, 10, 8),
  box: new BoxGeometry(1, 1, 1),
  ring: new RingGeometry(0.86, 1, 48),
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
        // Rares glow and wear a gold ring, so a champion is readable across the screen.
        const crown = flatOnGround(new Mesh(GEO.ring, basic(COLORS.rareOutline, 0.9)));
        crown.scale.setScalar(s.r * 1.6);
        const glow = flatOnGround(new Mesh(GEO.disk, basic(COLORS.rareOutline, 0.14, true)), 0.6);
        glow.scale.setScalar(s.r * 2.2);
        root.add(crown, glow);
        rig.root.traverse((o) => {
          if (o instanceof Mesh && o.material instanceof MeshStandardMaterial && o.material.emissiveIntensity < 1.5) {
            o.material.emissive.setHex(COLORS.rareOutline);
            o.material.emissiveIntensity = 0.18;
          }
        });
      }
      healthBar = makeHealthBar(s.rare ? 54 : 30, s.rare ? COLORS.rareOutline : 0xe0a040);
      healthBar.group.position.y = s.r * (s.et === 'spinner' ? 3.4 : 2.8);
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
      if (s.tier !== 'common') {
        // Loot beams make good drops visible from across the screen.
        const beam = new Mesh(GEO.cylinder, basic(color, s.tier === 'magic' ? 0.18 : 0.35, true));
        beam.scale.set(4, 260, 4);
        beam.position.y = 130;
        root.add(beam);
      }
      const glow = flatOnGround(new Mesh(GEO.disk, basic(color, 0.25, true)), 0.8);
      glow.scale.setScalar(s.r * 1.8);
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
  };
}

const tmpColor = new Color();

export class EntityRenderer {
  private readonly views = new Map<string, View>();
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

    for (const [key, view] of this.views) if (!seen.has(key)) this.remove(key, view);
    this.renderLinks(items, positions);
  }

  private remove(key: string, view: View): void {
    view.disposed = true;
    this.scene.remove(view.root);
    view.root.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const mats: Material[] = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.dispose();
      // Shared geometries are reused; only per-view geometry is disposed.
      if (!Object.values(GEO).some((g) => g === o.geometry)) o.geometry.dispose();
    });
    this.views.delete(key);
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
    } else if (s.k === 'loot' && view.body) {
      view.body.position.y = 2 + Math.sin(t * 2.5 + view.bob) * 3;
      view.body.rotation.y += dt;
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
