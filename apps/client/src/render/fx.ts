import type { ElementId, EntityId, GameEvent } from '@rune/shared';
import { PlaneGeometry, Color, Mesh, type Scene } from 'three';
import { useSettings } from '../ui/settings.js';
import { cssColor, FX, RENDER_ORDER } from './config.js';
import type { WorldScene } from './scene.js';
import { styleOf, type VfxStyle } from './vfx/palette.js';
import { Vfx } from './vfx/vfx.js';
import type { VfxQuality } from './vfx/quality.js';
import { HOSTILE, hostileMaterial, type HostileUniforms } from './vfx/materials.js';

/** A monster wind-up: the ring shows where, the fill growing to the edge shows when. */
interface Telegraph {
  ownerId: number;
  mesh: Mesh;
  u: HostileUniforms;
  age: number;
  duration: number;
}

/** A monster's lasting ground hazard, in the same hostile look with a fill that stays. */
interface Pool {
  mesh: Mesh;
  u: HostileUniforms;
  age: number;
  duration: number;
}

type TeleEvent = Extract<GameEvent, { e: 'tele' }>;
type HazardEvent = Extract<GameEvent, { e: 'hazard' }>;

/** The inner tick of an enemy marker: the only place its element shows. */
const TICK_COLORS: Record<ElementId | 'none', number> = { fire: 0xd8662a, cold: 0x6a9cc8, lightning: 0xc8b850, none: 0x5a1410 };
const HAZARD_TICKS: Record<HazardEvent['kind'], number> = { poison: 0x6a9a30, fire: 0xd8662a, frost: 0x6a9cc8 };

interface FloatingText {
  el: HTMLSpanElement;
  x: number;
  y: number;
  age: number;
  duration: number;
}

const tmpColor = new Color();

function disposeMaterial(mesh: Mesh): void {
  const m = mesh.material;
  if (Array.isArray(m)) for (const one of m) one.dispose();
  else m.dispose();
}

/**
 * Visual-only effects. Particles, trails and shockwaves live in the Vfx system (render/vfx/); this
 * class keeps monster telegraphs and hazards, which stay crisp on purpose, and the DOM text
 * (damage numbers, names), positioned by projecting world points each frame.
 */
export class Effects {
  readonly vfx: Vfx;
  private readonly texts: FloatingText[] = [];
  /** The element of the last hit on each entity, so a death shows how it died. */
  private readonly lastHit = new Map<EntityId, ElementId | null>();
  private readonly unsubscribe: () => void;
  /** Last values written per label: reading style.color back returns the browser's rgb() form, so it never matched. */
  private readonly labels = new Map<string, { el: HTMLSpanElement; text: string; color: string; className: string }>();
  /** 2 x 2, so a scale of r covers a circle of radius r. */
  private readonly quadGeo = new PlaneGeometry(2, 2);
  private readonly planeGeo = new PlaneGeometry(1, 1);
  private readonly teles: Telegraph[] = [];
  private readonly pools: Pool[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly world: WorldScene,
    private readonly layer: HTMLElement,
  ) {
    this.vfx = new Vfx(scene, world.camera, useSettings.getState().options.vfxQuality);
    // One rule for day and night everywhere a world is drawn: the game, the Spell Studio and the bench.
    this.vfx.setNightMode(world.nightMode);
    this.vfx.warm(world.renderer);
    this.unsubscribe = useSettings.subscribe((st) => this.setQuality(st.options.vfxQuality));
  }

  /** Switches the effect quality and compiles the new level's shaders ahead of the fight. */
  setQuality(q: VfxQuality): void {
    if (this.vfx.setQuality(q)) this.vfx.warm(this.world.renderer);
  }

  /** A coloured burst, for callers that only know a colour. */
  burst(x: number, y: number, hex: number, count: number, speed: number, opts: { up?: number; size?: number; life?: number; gravity?: number } = {}): void {
    this.vfx.burst(x, y, tmpColor.setHex(hex), count, speed, opts.up ?? 180, opts.size ?? 5, opts.life ?? 0.6, opts.gravity ?? 520);
  }

  shockwave(x: number, y: number, radius: number, style: VfxStyle, duration = 0.35): void {
    this.vfx.shockwave(x, y, radius, style, duration);
  }

  /** A hit on an entity, in the style of what dealt it. */
  hit(id: EntityId, x: number, y: number, el: ElementId | null, amount: number): void {
    if (this.lastHit.size > 4000) this.lastHit.clear();
    this.lastHit.set(id, el);
    this.vfx.impact(el ? styleOf(el, 'damage') : null, x, y, amount >= 30);
  }

  /** A death, shown in the element of the hit that caused it. */
  death(id: EntityId, x: number, y: number, hex: number, big: boolean): void {
    const el = this.lastHit.get(id) ?? null;
    this.lastHit.delete(id);
    this.vfx.death(el ? styleOf(el, 'damage') : null, x, y, tmpColor.setHex(hex), big);
  }

  telegraph(ev: TeleEvent): void {
    const shaded = hostileMaterial(ev.shape, TICK_COLORS[ev.el ?? 'none']);
    let mesh: Mesh;
    if (ev.shape === 'circle') {
      mesh = new Mesh(this.quadGeo, shaded.material);
      mesh.position.set(ev.x, 2.5, ev.y);
      mesh.scale.setScalar(ev.r);
      mesh.rotation.x = -Math.PI / 2;
      shaded.u.uSize.value.set(ev.r, ev.r);
    } else {
      const dx = ev.x2 - ev.x;
      const dy = ev.y2 - ev.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      mesh = new Mesh(this.planeGeo, shaded.material);
      mesh.rotation.set(-Math.PI / 2, 0, -Math.atan2(dy, dx));
      mesh.position.set(ev.x + dx / 2, 2.5, ev.y + dy / 2);
      mesh.scale.set(len, ev.w, 1);
      shaded.u.uSize.value.set(len, ev.w);
    }
    // Above roads and plazas, like every ground effect; see RENDER_ORDER.
    mesh.renderOrder = RENDER_ORDER.groundEffect;
    this.scene.add(mesh);
    this.teles.push({ ownerId: ev.id, mesh, u: shaded.u, age: 0, duration: Math.max(0.05, ev.t) });
  }

  /** Drops a monster's pending telegraphs when it dies mid wind-up. */
  clearTelegraphs(ownerId: number): void {
    for (let i = this.teles.length - 1; i >= 0; i--) {
      const t = this.teles[i];
      if (t && t.ownerId === ownerId) this.removeTele(i);
    }
  }

  hazard(ev: HazardEvent): void {
    const shaded = hostileMaterial('circle', HAZARD_TICKS[ev.kind]);
    const mesh = new Mesh(this.quadGeo, shaded.material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(ev.x, 2, ev.y);
    mesh.scale.setScalar(ev.r);
    mesh.renderOrder = RENDER_ORDER.groundEffect;
    shaded.u.uSize.value.set(ev.r, ev.r);
    shaded.u.uFill.value = 1;
    shaded.u.uAlpha.value = 0;
    this.scene.add(mesh);
    this.pools.push({ mesh, u: shaded.u, age: 0, duration: ev.t });
  }

  private removeTele(i: number): void {
    const t = this.teles[i];
    if (!t) return;
    this.scene.remove(t.mesh);
    disposeMaterial(t.mesh);
    this.teles.splice(i, 1);
  }

  text(x: number, y: number, value: string, hex: number, big = false): void {
    const el = document.createElement('span');
    el.className = big ? 'fx-text big' : 'fx-text';
    el.textContent = value;
    el.style.color = cssColor(hex);
    this.layer.appendChild(el);
    this.texts.push({ el, x: x + (Math.random() - 0.5) * 16, y, age: 0, duration: FX.damageNumberSeconds });
  }

  /** Floating labels (player names, loot names). Called every frame with the current set. */
  syncLabels(entries: readonly { key: string; x: number; y: number; text: string; color: string; height: number; className: string; onClick?: () => void; onHover?: (over: boolean) => void }[]): void {
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.key);
      let label = this.labels.get(e.key);
      if (!label) {
        label = { el: document.createElement('span'), text: '', color: '', className: '' };
        this.layer.appendChild(label.el);
        this.labels.set(e.key, label);
      }
      const el = label.el;
      if (label.className !== e.className) el.className = label.className = e.className;
      if (label.text !== e.text) el.textContent = label.text = e.text;
      if (label.color !== e.color) el.style.color = label.color = e.color;
      el.onclick = e.onClick ?? null;
      const hover = e.onHover;
      el.onmouseenter = hover ? () => hover(true) : null;
      el.onmouseleave = hover ? () => hover(false) : null;
      const p = this.world.project(e.x, e.y, e.height);
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    }
    for (const [key, label] of this.labels) {
      if (seen.has(key)) continue;
      label.el.remove();
      this.labels.delete(key);
    }
  }

  update(dt: number): void {
    // Read each frame: the town editor rebuilds the world under a running scene.
    this.vfx.fires.setSpots(this.world.fires);
    this.vfx.begin(dt);
    this.vfx.commit();

    for (let i = this.teles.length - 1; i >= 0; i--) {
      const t = this.teles[i];
      if (!t) continue;
      t.age += dt;
      const k = t.age / t.duration;
      if (k >= 1) {
        this.removeTele(i);
        continue;
      }
      t.u.uFill.value = k;
      // The last moment flashes so the hit is readable even without watching the fill.
      t.u.uRingA.value = k > 0.8 ? 1 : HOSTILE.ringAlpha;
    }

    for (let i = this.pools.length - 1; i >= 0; i--) {
      const p = this.pools[i];
      if (!p) continue;
      p.age += dt;
      if (p.age >= p.duration) {
        this.scene.remove(p.mesh);
        disposeMaterial(p.mesh);
        this.pools.splice(i, 1);
        continue;
      }
      const fadeIn = Math.min(1, p.age * 4);
      const fadeOut = Math.min(1, (p.duration - p.age) * 2);
      p.u.uAlpha.value = fadeIn * fadeOut;
      p.u.uFillA.value = HOSTILE.fillAlpha * (0.8 + Math.sin(p.age * 5) * 0.2);
    }

    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      if (!t) continue;
      t.age += dt;
      const k = t.age / t.duration;
      if (k >= 1) {
        t.el.remove();
        this.texts.splice(i, 1);
        continue;
      }
      const p = this.world.project(t.x, t.y, 50 + k * 50);
      t.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) scale(${1 + (1 - k) * 0.3})`;
      t.el.style.opacity = String(k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.vfx.dispose();
    for (let i = this.teles.length - 1; i >= 0; i--) this.removeTele(i);
    for (const p of this.pools) {
      this.scene.remove(p.mesh);
      disposeMaterial(p.mesh);
    }
    this.pools.length = 0;
    for (const t of this.texts) t.el.remove();
    for (const label of this.labels.values()) label.el.remove();
  }
}
