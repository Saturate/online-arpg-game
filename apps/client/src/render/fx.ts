import type { ElementId, EntityId, GameEvent } from '@rune/shared';
import { CircleGeometry, PlaneGeometry, Color, DoubleSide, Mesh, MeshBasicMaterial, RingGeometry, type Scene } from 'three';
import { useSettings } from '../ui/settings.js';
import { cssColor, FX, RENDER_ORDER } from './config.js';
import type { WorldScene } from './scene.js';
import { styleOf, type VfxStyle } from './vfx/palette.js';
import { Vfx } from './vfx/vfx.js';

/** A monster wind-up: the outline shows where, the fill growing to the edge shows when. */
interface Telegraph {
  ownerId: number;
  outline: Mesh;
  fill: Mesh;
  outlineMat: MeshBasicMaterial;
  fillMat: MeshBasicMaterial;
  age: number;
  duration: number;
  shape: 'circle' | 'line';
  /** Full size of the fill: radius for circles, length for lines. */
  size: number;
}

interface Pool {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  age: number;
  duration: number;
}

type TeleEvent = Extract<GameEvent, { e: 'tele' }>;
type HazardEvent = Extract<GameEvent, { e: 'hazard' }>;

const TELE_COLORS: Record<ElementId | 'none', number> = { fire: 0xff7a30, cold: 0x7ab8ff, lightning: 0xf0e060, none: 0xff3a30 };
const HAZARD_COLORS: Record<HazardEvent['kind'], number> = { poison: 0x6ad030, fire: 0xff5a20, frost: 0x9ad8ff };

interface FloatingText {
  el: HTMLSpanElement;
  x: number;
  y: number;
  age: number;
  duration: number;
}

const tmpColor = new Color();

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
  private readonly edgeGeo = new RingGeometry(0.92, 1, 48);
  private readonly diskGeo = new CircleGeometry(1, 40);
  private readonly planeGeo = new PlaneGeometry(1, 1);
  private readonly teles: Telegraph[] = [];
  private readonly pools: Pool[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly world: WorldScene,
    private readonly layer: HTMLElement,
  ) {
    this.vfx = new Vfx(scene, world.camera, useSettings.getState().options.vfxQuality);
    this.unsubscribe = useSettings.subscribe((st) => this.vfx.setQuality(st.options.vfxQuality));
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
    const hex = TELE_COLORS[ev.el ?? 'none'];
    const outlineMat = new MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.85, depthWrite: false, side: DoubleSide });
    const fillMat = new MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.28, depthWrite: false, side: DoubleSide });
    let outline: Mesh;
    let fill: Mesh;
    let size: number;
    if (ev.shape === 'circle') {
      outline = new Mesh(this.edgeGeo, outlineMat);
      fill = new Mesh(this.diskGeo, fillMat);
      outline.position.set(ev.x, 2.5, ev.y);
      fill.position.set(ev.x, 2.4, ev.y);
      outline.scale.setScalar(ev.r);
      fill.scale.setScalar(0.01);
      outline.rotation.x = -Math.PI / 2;
      fill.rotation.x = -Math.PI / 2;
      size = ev.r;
    } else {
      const dx = ev.x2 - ev.x;
      const dy = ev.y2 - ev.y;
      size = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      outline = new Mesh(this.planeGeo, outlineMat);
      fill = new Mesh(this.planeGeo, fillMat);
      outlineMat.opacity = 0.22;
      fillMat.opacity = 0.45;
      for (const m of [outline, fill]) {
        m.rotation.set(-Math.PI / 2, 0, -angle);
      }
      outline.position.set(ev.x + dx / 2, 2.4, ev.y + dy / 2);
      outline.scale.set(size, ev.w, 1);
      // The fill grows from the monster outward along the line.
      fill.position.set(ev.x, 2.5, ev.y);
      fill.scale.set(0.01, ev.w, 1);
      fill.userData = { x: ev.x, y: ev.y, cos: Math.cos(angle), sin: Math.sin(angle) };
    }
    // Above roads and plazas, like every ground effect; see RENDER_ORDER.
    outline.renderOrder = RENDER_ORDER.groundEffect;
    fill.renderOrder = RENDER_ORDER.groundEffect;
    this.scene.add(outline, fill);
    this.teles.push({ ownerId: ev.id, outline, fill, outlineMat, fillMat, age: 0, duration: Math.max(0.05, ev.t), shape: ev.shape, size });
  }

  /** Drops a monster's pending telegraphs when it dies mid wind-up. */
  clearTelegraphs(ownerId: number): void {
    for (let i = this.teles.length - 1; i >= 0; i--) {
      const t = this.teles[i];
      if (t && t.ownerId === ownerId) this.removeTele(i);
    }
  }

  hazard(ev: HazardEvent): void {
    const mat = new MeshBasicMaterial({ color: HAZARD_COLORS[ev.kind], transparent: true, opacity: 0.4, depthWrite: false, side: DoubleSide });
    const mesh = new Mesh(this.diskGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(ev.x, 2, ev.y);
    mesh.scale.setScalar(ev.r);
    mesh.renderOrder = RENDER_ORDER.groundEffect;
    this.scene.add(mesh);
    this.pools.push({ mesh, mat, age: 0, duration: ev.t });
  }

  private removeTele(i: number): void {
    const t = this.teles[i];
    if (!t) return;
    this.scene.remove(t.outline, t.fill);
    t.outlineMat.dispose();
    t.fillMat.dispose();
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
  syncLabels(entries: readonly { key: string; x: number; y: number; text: string; color: string; height: number; className: string; onClick?: () => void }[]): void {
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
      if (t.shape === 'circle') t.fill.scale.setScalar(Math.max(0.01, t.size * k));
      else {
        const u = t.fill.userData;
        const len = Math.max(0.01, t.size * k);
        t.fill.scale.x = len;
        if (typeof u.x === 'number' && typeof u.y === 'number' && typeof u.cos === 'number' && typeof u.sin === 'number') t.fill.position.set(u.x + (u.cos * len) / 2, 2.5, u.y + (u.sin * len) / 2);
      }
      // The last moment flashes so the hit is readable even without watching the fill.
      t.outlineMat.opacity = k > 0.8 ? 1 : t.shape === 'circle' ? 0.85 : 0.22;
    }

    for (let i = this.pools.length - 1; i >= 0; i--) {
      const p = this.pools[i];
      if (!p) continue;
      p.age += dt;
      if (p.age >= p.duration) {
        this.scene.remove(p.mesh);
        p.mat.dispose();
        this.pools.splice(i, 1);
        continue;
      }
      const fadeIn = Math.min(1, p.age * 4);
      const fadeOut = Math.min(1, (p.duration - p.age) * 2);
      p.mat.opacity = (0.32 + Math.sin(p.age * 5) * 0.06) * fadeIn * fadeOut;
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
      p.mat.dispose();
    }
    this.pools.length = 0;
    for (const t of this.texts) t.el.remove();
    for (const label of this.labels.values()) label.el.remove();
  }
}
