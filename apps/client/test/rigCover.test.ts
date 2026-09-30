import { ENEMIES, type EnemyTypeId } from '@rune/shared';
import { Box3, Vector3, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { buildEnemy, driveRig, type Rig, type RigDrive } from '../src/render/models.js';

const DT = 1 / 240;

function feet(rig: Rig): Object3D[] {
  const out: Object3D[] = [];
  const gait = rig.profile.gait;
  for (const o of [rig.legL, rig.legR, ...(gait === 'quad' || gait === 'crawl' ? [rig.armL, rig.armR] : [])]) if (o) out.push(o);
  for (const e of rig.extras) if (e.userData.kind === 'leg') out.push(e);
  return out;
}

function tip(o: Object3D, out: Vector3): Vector3 {
  const foot: unknown = o.userData.foot;
  if (Array.isArray(foot)) {
    const [x, y, z] = foot.filter((v): v is number => typeof v === 'number');
    return o.localToWorld(out.set(x ?? 0, y ?? 0, z ?? 0));
  }
  const length: unknown = o.userData.length;
  return o.localToWorld(out.set(0, -(typeof length === 'number' ? length : 1), 0));
}

/**
 * Feet distance over ground distance: while a foot is on the ground it should move back at the
 * ground speed (1.0); a foot that moves slower slides. The animator marks planted feet. `contact`
 * is the share of the cycle with any foot down; `lift` how far the planted feet rise and fall, as a
 * share of leg length, which is the other way a foot slides; `height` how high planted feet sit
 * above the ground on average, as a share of leg length (floating or dug in).
 */
function cover(type: EnemyTypeId, speed: number): { cover: number; contact: number; lift: number; height: number } {
  const rig = buildEnemy(type, ENEMIES[type].color);
  rig.root.scale.setScalar(ENEMIES[type].radius);
  const d: RigDrive = { speed, dead: false, dormant: false, hidden: false, dt: DT, seed: 1.3 };
  for (let t = 0; t < 2; t += DT) driveRig(rig, d);
  const fs = feet(rig);
  const samples: { y: number[]; x: number[]; down: boolean[] }[] = [];
  const v = new Vector3();
  for (let t = 0; t < 3; t += DT) {
    driveRig(rig, d);
    rig.root.updateMatrixWorld(true);
    samples.push({ y: fs.map((f) => tip(f, v).y), x: fs.map((f) => tip(f, v).x), down: fs.map((f) => f.userData.planted === true) });
  }
  let sum = 0;
  let n = 0;
  let touching = 0;
  let high = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!a || !b) continue;
    let any = false;
    for (let k = 0; k < fs.length; k++) {
      if (!b.down[k]) continue;
      sum += -((b.x[k] ?? 0) - (a.x[k] ?? 0)) / DT;
      high += b.y[k] ?? 0;
      n++;
      any = true;
    }
    if (any) touching++;
  }
  let lift = 0;
  for (let k = 0; k < fs.length; k++) {
    const ys = samples.filter((q) => q.down[k]).map((q) => q.y[k] ?? 0);
    if (ys.length > 0) lift = Math.max(lift, Math.max(...ys) - Math.min(...ys));
  }
  const leg = (rig.legLength || 1) * rig.root.scale.y * rig.body.scale.y;
  return { cover: n > 0 ? sum / n / speed : 0, contact: touching / (samples.length - 1), lift: lift / leg, height: n > 0 ? high / n / leg : 1 };
}

const WALKERS: readonly EnemyTypeId[] = ['scarab', 'plague_rat', 'spiderling', 'dire_wolf', 'cave_spider', 'hellhound', 'tusked_boar', 'thorn_beast', 'venom_spider', 'lizardman', 'gargoyle', 'giant_scorpion'];
const HOPPERS: readonly EnemyTypeId[] = ['volatile', 'mimic', 'imp', 'spore_man', 'fallen_shaman', 'bog_spitter'];

describe('procedural monster feet', () => {
  it('keep a planted foot at ground speed and height, at the walk and at a run', () => {
    for (const type of [...WALKERS, ...HOPPERS]) {
      for (const speed of [ENEMIES[type].moveSpeed, 240]) {
        const c = cover(type, speed);
        const at = `${type} at ${speed}`;
        expect(c.cover, at).toBeGreaterThan(0.8);
        expect(c.cover, at).toBeLessThan(1.2);
        expect(c.lift, at).toBeLessThan(0.12);
        // A thin leg's rim reaches past its tip, so a few hundredths above is still on the ground.
        expect(Math.abs(c.height), at).toBeLessThan(0.04);
        // Hoppers spend most of the cycle in the air, so a short stance can match the ground.
        if (HOPPERS.includes(type)) expect(c.contact, at).toBeLessThan(0.27);
      }
    }
  });

  it('slides the bog lurker on its belly, feet off the ground', () => {
    const rig = buildEnemy('bog_lurker', ENEMIES.bog_lurker.color);
    rig.root.scale.setScalar(ENEMIES.bog_lurker.radius);
    const d: RigDrive = { speed: ENEMIES.bog_lurker.moveSpeed, dead: false, dormant: false, hidden: false, dt: DT, seed: 1.3 };
    for (let t = 0; t < 2; t += DT) driveRig(rig, d);
    rig.root.updateMatrixWorld(true);
    const low = new Box3().setFromObject(rig.body, true).min.y;
    expect(low).toBeLessThan(0.5);
    const v = new Vector3();
    for (const f of feet(rig)) expect(tip(f, v).y).toBeGreaterThan(low);
  });
});
