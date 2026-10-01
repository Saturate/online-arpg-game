import type { GateInfo } from '@rune/shared';
import { AdditiveBlending, CanvasTexture, CircleGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, RepeatWrapping, type Scene } from 'three';
import { emitLight, lightKey } from './lights.js';
import type { Vfx } from './vfx/vfx.js';

/**
 * The seals on the world's gates, as this character sees them: a sigil burnt into the road under
 * the arch and a veil between its legs, glowing a dull ember red while the gate is sealed to you,
 * cold and cracked once you have opened it. Other players see their own state; the seal is per
 * character (`sim/gates.ts`).
 */

/** Ember red, dark enough to sit in the grade at night without reading as a bright light. */
const SEALED = 0xb8401f;
const OPENED = 0x4a463e;
/** Half the gap between the arch's legs in the map (`GATE_LEG` in worldMap.ts), a little inside it. */
const HALF = 88;
const VEIL_HEIGHT = 170;
const BREAK_SECONDS = 1.4;

function sigilCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  if (!g) return c;
  g.translate(128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 5;
  for (const r of [118, 96]) {
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.stroke();
  }
  // Glyph strokes between the rings, uneven like something cut by hand.
  g.lineWidth = 4;
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    g.save();
    g.rotate(a);
    g.beginPath();
    g.moveTo(100, -6);
    g.lineTo(114, k % 2 === 0 ? 4 : -2);
    g.lineTo(104, 8);
    g.stroke();
    g.restore();
  }
  // A seven-pointed star in the middle.
  g.lineWidth = 6;
  g.beginPath();
  for (let k = 0; k <= 7; k++) {
    const a = ((k * 3) / 7) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * 80;
    const y = Math.sin(a) * 80;
    if (k === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  return c;
}

function veilCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  if (!g) return c;
  const fade = g.createLinearGradient(0, 0, 0, 128);
  fade.addColorStop(0, 'rgba(255,255,255,0)');
  fade.addColorStop(0.6, 'rgba(255,255,255,0.35)');
  fade.addColorStop(1, 'rgba(255,255,255,0.8)');
  g.fillStyle = fade;
  g.fillRect(0, 0, 128, 128);
  // Streaks rising from the ground; the texture scrolls, so they drift up.
  g.globalCompositeOperation = 'destination-out';
  for (let x = 0; x < 128; x += 6) {
    g.fillStyle = `rgba(0,0,0,${0.3 + ((x * 37) % 50) / 100})`;
    g.fillRect(x, 0, 3, 128);
  }
  return c;
}

interface Seal {
  gate: GateInfo;
  group: Group;
  sigil: Mesh<CircleGeometry, MeshBasicMaterial>;
  veil: Mesh<PlaneGeometry, MeshBasicMaterial>;
  key: number;
  /** Seconds since the seal broke on this screen, or null while it holds or after it settled. */
  breaking: number | null;
}

export class GateSeals {
  private readonly seals: Seal[] = [];
  private readonly sigilTex = new CanvasTexture(sigilCanvas());
  private readonly veilTex = new CanvasTexture(veilCanvas());

  constructor(
    private readonly scene: Scene,
    private readonly vfx: Vfx,
    gates: readonly GateInfo[],
  ) {
    this.veilTex.wrapT = RepeatWrapping;
    for (const gate of gates) {
      const sigil = new Mesh(new CircleGeometry(HALF * 0.95, 40), new MeshBasicMaterial({ map: this.sigilTex, color: SEALED, transparent: true, blending: AdditiveBlending, depthWrite: false }));
      sigil.rotation.x = -Math.PI / 2;
      sigil.position.y = 1.5;
      const veil = new Mesh(new PlaneGeometry(HALF * 2, VEIL_HEIGHT), new MeshBasicMaterial({ map: this.veilTex, color: SEALED, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }));
      veil.position.y = VEIL_HEIGHT / 2;
      const group = new Group();
      group.add(sigil, veil);
      group.position.set(gate.x, 0, gate.y);
      // The group's X axis runs across the road, along the seal; the scene's z is the map's y.
      group.rotation.y = -(gate.angle + Math.PI / 2);
      this.scene.add(group);
      this.seals.push({ gate, group, sigil, veil, key: lightKey(), breaking: null });
    }
  }

  /** The seal breaking on this screen: the gate just opened for this character. */
  open(gateId: string): void {
    const s = this.seals.find((x) => x.gate.id === gateId);
    if (!s) return;
    s.breaking = 0;
    const { x, y } = s.gate;
    this.vfx.shockwave(x, y, HALF * 3, 'fire', 0.9);
    this.vfx.flash(x, y, VEIL_HEIGHT * 0.6, new Color(SEALED), 2.5, 380, 0.8, 'fire');
    this.vfx.burst(x, y, new Color(0xd86a3a), 40, 140, 160, 5, 1.2, 220);
  }

  update(dt: number, t: number, opened: readonly string[]): void {
    for (const s of this.seals) {
      const open = opened.includes(s.gate.id);
      if (s.breaking !== null) {
        s.breaking += dt;
        if (s.breaking >= BREAK_SECONDS) s.breaking = null;
      }
      const k = s.breaking === null ? (open ? 1 : 0) : Math.min(1, s.breaking / BREAK_SECONDS);
      const sealedNow = !open || s.breaking !== null;
      // A slow uneven pulse while sealed, so it reads as alive and wrong rather than as a lamp.
      const pulse = 0.75 + 0.15 * Math.sin(t * 1.7 + s.gate.x) + 0.1 * Math.sin(t * 4.3);
      s.sigil.material.color.setHex(sealedNow ? SEALED : OPENED);
      s.sigil.material.opacity = sealedNow ? (1 - k) * pulse + k * 0.25 : 0.25;
      s.sigil.rotation.z = sealedNow ? t * 0.08 : 0;
      s.veil.visible = sealedNow;
      s.veil.material.opacity = 0.45 * pulse * (1 - k);
      s.veil.scale.y = 1 - 0.85 * k;
      s.veil.position.y = (VEIL_HEIGHT * s.veil.scale.y) / 2;
      this.veilTex.offset.y = -t * 0.25;
      if (sealedNow) emitLight(s.key, s.gate.x, s.gate.y, 60, SEALED, 1.1 * pulse * (1 - k), 260);
    }
  }

  dispose(): void {
    for (const s of this.seals) {
      this.scene.remove(s.group);
      s.sigil.geometry.dispose();
      s.sigil.material.dispose();
      s.veil.geometry.dispose();
      s.veil.material.dispose();
    }
    this.sigilTex.dispose();
    this.veilTex.dispose();
  }
}
