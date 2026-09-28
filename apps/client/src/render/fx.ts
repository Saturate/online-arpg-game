import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  Vector3,
  type Scene,
} from 'three';
import { cssColor, FX } from './config.js';
import type { WorldScene } from './scene.js';

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  gravity: number;
}

interface Shockwave {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  age: number;
  duration: number;
  radius: number;
}

interface FloatingText {
  el: HTMLSpanElement;
  x: number;
  y: number;
  age: number;
  duration: number;
}

const GRAVITY = 520;
const matrix = new Matrix4();
const quat = new Quaternion();
const scale = new Vector3();
const pos = new Vector3();
const color = new Color();

/**
 * Visual-only effects. Particles are one InstancedMesh so hundreds of them cost one draw call.
 * Text (damage numbers, names) is DOM, positioned by projecting world points each frame.
 */
export class Effects {
  private readonly particles: (Particle | null)[] = new Array<Particle | null>(FX.maxParticles).fill(null);
  private readonly mesh: InstancedMesh;
  private readonly waves: Shockwave[] = [];
  private readonly texts: FloatingText[] = [];
  private readonly labels = new Map<string, HTMLSpanElement>();
  private readonly ringGeo = new RingGeometry(0.8, 1, 48);
  private cursor = 0;

  constructor(
    private readonly scene: Scene,
    private readonly world: WorldScene,
    private readonly layer: HTMLElement,
  ) {
    this.mesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      // Normal blending keeps element colours readable on bright ground; additive turned everything white.
      new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }),
      FX.maxParticles,
    );
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < FX.maxParticles; i++) {
      matrix.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, matrix);
      this.mesh.setColorAt(i, color.setHex(0xffffff));
    }
    scene.add(this.mesh);
  }

  burst(x: number, y: number, hex: number, count: number, speed: number, opts: { up?: number; size?: number; life?: number; gravity?: number } = {}): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.spawn(
        {
          x,
          y: 14 + Math.random() * 10,
          z: y,
          vx: Math.cos(a) * s,
          vy: (opts.up ?? 180) * (0.5 + Math.random()),
          vz: Math.sin(a) * s,
          life: 0,
          maxLife: (opts.life ?? 0.6) * (0.6 + Math.random() * 0.6),
          size: (opts.size ?? 5) * (0.6 + Math.random() * 0.8),
          gravity: opts.gravity ?? GRAVITY,
        },
        hex,
      );
    }
  }

  trail(x: number, y: number, hex: number, size: number): void {
    this.spawn(
      {
        x: x + (Math.random() - 0.5) * 4,
        y: 18,
        z: y + (Math.random() - 0.5) * 4,
        vx: 0,
        vy: 10,
        vz: 0,
        life: 0,
        maxLife: 0.22,
        size,
        gravity: 0,
      },
      hex,
    );
  }

  shockwave(x: number, y: number, radius: number, hex: number, duration = 0.35): void {
    const mat = new MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    const mesh = new Mesh(this.ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 3, y);
    mesh.scale.setScalar(1);
    this.scene.add(mesh);
    this.waves.push({ mesh, mat, age: 0, duration, radius });
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
  syncLabels(entries: readonly { key: string; x: number; y: number; text: string; color: string; height: number; className: string }[]): void {
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.key);
      let el = this.labels.get(e.key);
      if (!el) {
        el = document.createElement('span');
        this.layer.appendChild(el);
        this.labels.set(e.key, el);
      }
      if (el.className !== e.className) el.className = e.className;
      if (el.textContent !== e.text) el.textContent = e.text;
      if (el.style.color !== e.color) el.style.color = e.color;
      const p = this.world.project(e.x, e.y, e.height);
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    }
    for (const [key, el] of this.labels) {
      if (seen.has(key)) continue;
      el.remove();
      this.labels.delete(key);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p) continue;
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.particles[i] = null;
        matrix.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, matrix);
        continue;
      }
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y = Math.max(1, p.y + p.vy * dt);
      p.z += p.vz * dt;
      const k = 1 - p.life / p.maxLife;
      pos.set(p.x, p.y, p.z);
      scale.setScalar(p.size * k);
      matrix.compose(pos, quat, scale);
      this.mesh.setMatrixAt(i, matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      if (!w) continue;
      w.age += dt;
      const k = w.age / w.duration;
      if (k >= 1) {
        this.scene.remove(w.mesh);
        w.mat.dispose();
        this.waves.splice(i, 1);
        continue;
      }
      w.mesh.scale.setScalar(Math.max(1, w.radius * (0.2 + 0.8 * Math.sqrt(k))));
      w.mat.opacity = 0.8 * (1 - k);
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
    for (const t of this.texts) t.el.remove();
    for (const el of this.labels.values()) el.remove();
  }

  private spawn(p: Particle, hex: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % FX.maxParticles;
    this.particles[i] = p;
    this.mesh.setColorAt(i, color.setHex(hex));
  }
}
