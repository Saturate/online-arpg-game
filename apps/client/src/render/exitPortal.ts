import type { Portal } from '@rune/shared';
import { AdditiveBlending, CanvasTexture, CircleGeometry, Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry, TorusGeometry, type Scene } from 'three';
import { emitLight, lightKey } from './lights.js';
import { mat } from './models.js';
import type { Vfx } from './vfx/vfx.js';

/** The same violet as the other ways out to the Wilds, so the exit reads as one of them. */
const COLOR = 0xb49cff;
const OPEN_SECONDS = 1.2;

function swirlCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  if (!g) return c;
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(150,120,230,0.8)');
  grad.addColorStop(1, 'rgba(40,20,90,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 6;
  for (let arm = 0; arm < 4; arm++) {
    g.beginPath();
    for (let k = 0; k < 60; k++) {
      const a = arm * (Math.PI / 2) + k * 0.12;
      const x = 128 + Math.cos(a) * k * 2;
      const y = 128 + Math.sin(a) * k * 2;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  return c;
}

/**
 * A dungeon's exit, which the static world leaves out while it is sealed. Built when the boss dies
 * (growing out of the floor with a burst of light) or already open for someone arriving later.
 */
export class ExitPortal {
  private readonly group = new Group();
  private readonly swirl: Mesh;
  private readonly floor: Mesh;
  private readonly key = lightKey();
  private age: number;

  constructor(
    private readonly scene: Scene,
    vfx: Vfx,
    private readonly portal: Portal,
    opening: boolean,
  ) {
    const { x, y, r } = portal;
    const base = new Mesh(new CylinderGeometry(r * 1.3, r * 1.45, 8, 20), mat(0x6a6460));
    base.position.y = 4;
    base.receiveShadow = true;
    const ring = new Mesh(new TorusGeometry(r, 5, 8, 32), mat(COLOR, { emissive: COLOR, intensity: 1.2 }));
    ring.position.y = r + 14;
    this.swirl = new Mesh(new CircleGeometry(r * 0.95, 32), new MeshBasicMaterial({ map: new CanvasTexture(swirlCanvas()), color: COLOR, transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }));
    this.swirl.position.y = r + 14;
    this.floor = new Mesh(new RingGeometry(r * 0.5, r * 1.2, 32), new MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = 8.5;
    this.group.add(base, ring, this.swirl, this.floor);
    this.group.position.set(x, 0, y);
    // Faces the default camera like the other portals, so the swirl reads as a disc.
    this.group.rotation.y = Math.PI / 4;
    this.scene.add(this.group);
    this.age = opening ? 0 : OPEN_SECONDS;
    if (opening) {
      vfx.shockwave(x, y, r * 4, 'mixed', 0.9);
      vfx.flash(x, y, r + 14, new Color(COLOR), 3, 420, 0.7, 'mixed');
      vfx.cast('mixed', x, y);
      for (let i = 0; i < 4; i++) vfx.heal(x + Math.cos(i * 1.6) * r * 0.6, y + Math.sin(i * 1.6) * r * 0.6);
    }
    this.update(0, 0);
  }

  update(dt: number, t: number): void {
    this.age = Math.min(OPEN_SECONDS, this.age + dt);
    const k = this.age / OPEN_SECONDS;
    // Eased so the portal rises quickly out of the floor and settles, not a linear pop.
    const grow = 1 - (1 - k) ** 3;
    this.group.scale.set(grow, grow, grow);
    this.swirl.rotation.z = -t * 1.6;
    this.floor.rotation.z = t * 0.5;
    const { x, y, r } = this.portal;
    // The same light the static portals get, asked for each frame since this one arrives late.
    emitLight(this.key, x, y, r + 14, COLOR, 1.4 * grow, 300);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
  }
}
