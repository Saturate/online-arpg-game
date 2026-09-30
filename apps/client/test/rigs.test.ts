import { ENEMIES, ENEMY_TYPE_IDS, type EnemyTypeId } from '@rune/shared';
import { Box3, Object3D, SkinnedMesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ENEMY_ASSETS } from '../src/render/characters.js';
import { buildEnemy, driveRig, enemyModel, rigAttack, rigHit, rigWindup, type Rig, type RigDrive } from '../src/render/models.js';
import { cycleLength } from '../src/render/rigs/motion.js';

const PROCEDURAL = ENEMY_TYPE_IDS.filter((id) => ENEMY_ASSETS[id] === undefined);
const DT = 1 / 60;

function drive(speed = 0, dead = false, dormant = false): RigDrive {
  return { speed, dead, dormant, hidden: false, dt: DT, seed: 1.3 };
}

function run(rig: Rig, seconds: number, d: RigDrive, each?: (t: number) => void): void {
  for (let t = 0; t < seconds; t += DT) {
    each?.(t);
    driveRig(rig, d);
  }
}

function sized(type: EnemyTypeId, raw: boolean): Rig {
  const rig = raw ? buildEnemy(type, ENEMIES[type].color) : enemyModel(type, ENEMIES[type].color);
  rig.root.scale.multiplyScalar(ENEMIES[type].radius);
  rig.root.updateMatrixWorld(true);
  return rig;
}

function animated(rig: Rig): Object3D[] {
  return [rig.body, rig.head, rig.jaw, rig.armL, rig.armR, rig.legL, rig.legR, rig.tail, ...rig.extras].filter((o): o is Object3D => o !== null);
}

describe('compiled procedural monsters', () => {
  it('draw each type in at most three calls, sharing geometry and materials between copies', () => {
    for (const type of PROCEDURAL) {
      const a = enemyModel(type, ENEMIES[type].color);
      const b = enemyModel(type, ENEMIES[type].color);
      const ma = a.root.children.filter((c): c is SkinnedMesh => c instanceof SkinnedMesh);
      const mb = b.root.children.filter((c): c is SkinnedMesh => c instanceof SkinnedMesh);
      expect(ma.length, type).toBeGreaterThan(0);
      expect(ma.length, type).toBeLessThanOrEqual(3);
      ma.forEach((m, i) => {
        expect(mb[i]?.geometry, type).toBe(m.geometry);
        expect(mb[i]?.material, type).toBe(m.material);
      });
      // Each copy has its own bones, or they would all move together.
      expect(a.body).not.toBe(b.body);
      expect(a.owned.length).toBe(1);
    }
  });

  it('keep the size and shape of the model they were built from', () => {
    for (const type of PROCEDURAL) {
      const raw = sized(type, true);
      const compiled = sized(type, false);
      const want = new Box3().setFromObject(raw.root, true);
      const got = new Box3();
      for (const c of compiled.root.children) {
        if (!(c instanceof SkinnedMesh)) continue;
        c.skeleton.update();
        got.union(new Box3().setFromObject(c, true));
      }
      const size = want.getSize(new Vector3()).length();
      expect(got.min.distanceTo(want.min) / size, type).toBeLessThan(0.01);
      expect(got.max.distanceTo(want.max) / size, type).toBeLessThan(0.01);
    }
  });
});

describe('procedural monster motion', () => {
  it('plays every role for every type without breaking the pose', () => {
    for (const type of PROCEDURAL) {
      const rig = sized(type, false);
      const d = drive();
      run(rig, 1, d);
      d.speed = 80;
      run(rig, 1, d);
      d.speed = 240;
      run(rig, 1, d);
      d.speed = 0;
      rigWindup(rig, 0.6);
      run(rig, 0.6, d);
      rigAttack(rig);
      run(rig, 0.3, d);
      rigAttack(rig);
      rigHit(rig);
      run(rig, 0.6, d);
      d.dormant = true;
      run(rig, 1, d);
      d.dormant = false;
      run(rig, 1.2, d);
      d.dead = true;
      run(rig, 3, d);
      for (const n of animated(rig)) {
        for (const v of [n.position.x, n.position.y, n.position.z, n.rotation.x, n.rotation.y, n.rotation.z, n.scale.x, n.scale.y, n.scale.z]) expect(Number.isFinite(v), type).toBe(true);
      }
      expect(rig.motion?.label, type).toBe('death');
    }
  });

  it('moves a planted foot back at the speed the monster walks', () => {
    for (const type of ['earth_golem', 'cultist', 'mummy', 'treant'] as const) {
      const rig = sized(type, true);
      const speed = ENEMIES[type].moveSpeed;
      const d = drive(speed);
      run(rig, 1, d);
      const leg = rig.legL;
      if (!leg) throw new Error(`${type} has no legs`);
      const foot = (): Vector3 => {
        rig.root.updateMatrixWorld(true);
        return leg.localToWorld(new Vector3(0, -rig.legLength, 0));
      };
      // Sample the stance: the foot lowest to the ground is the planted one.
      let best = Infinity;
      for (let i = 0; i < 90; i++) {
        const a = foot();
        driveRig(rig, d);
        const b = foot();
        if (Math.min(a.y, b.y) > rig.legLength * rig.root.scale.y * 0.02 + 0.5) continue;
        const v = Math.hypot(b.x - a.x, b.z - a.z) / DT;
        best = Math.min(best, Math.abs(v - speed) / speed);
      }
      expect(best, type).toBeLessThan(0.2);
      expect(cycleLength(rig, 0.4)).toBeGreaterThan(0);
    }
  });

  it('crossfades between roles instead of snapping', () => {
    for (const type of PROCEDURAL) {
      const rig = sized(type, true);
      const nodes = animated(rig);
      const d = drive();
      let last = nodes.map((n) => n.rotation.clone());
      const step = (): number => {
        driveRig(rig, d);
        let worst = 0;
        nodes.forEach((n, i) => {
          const r = last[i];
          if (r) worst = Math.max(worst, Math.abs(n.rotation.x - r.x), Math.abs(n.rotation.y - r.y), Math.abs(n.rotation.z - r.z));
        });
        last = nodes.map((n) => n.rotation.clone());
        return worst;
      };
      const settle = (): number => {
        let steady = 0;
        for (let i = 0; i < 40; i++) steady = Math.max(steady, step());
        return steady;
      };
      settle();
      const change = (apply: () => void): void => {
        const before = settle();
        apply();
        let jump = 0;
        for (let i = 0; i < 4; i++) jump = Math.max(jump, step());
        // Right after a role change nothing may move much faster than the role did before it.
        expect(jump, type).toBeLessThan(Math.max(0.2, before * 1.6));
      };
      change(() => (d.speed = 90));
      change(() => (d.speed = 0));
      change(() => (d.speed = 240));
      change(() => (d.speed = 0));
      change(() => (d.dormant = true));
      change(() => (d.dormant = false));
      change(() => rigHit(rig));
    }
  });

  it('lays bodies on the ground, not under it or floating', () => {
    for (const type of PROCEDURAL) {
      const rig = sized(type, true);
      if (rig.profile.death === 'dissolve' || rig.profile.death === 'crumble' || rig.profile.death === 'slump') continue;
      run(rig, 3.5, drive(0, true));
      rig.root.updateMatrixWorld(true);
      const box = new Box3().setFromObject(rig.root, true);
      const r = ENEMIES[type].radius;
      expect(box.min.y, type).toBeGreaterThan(-0.35 * r);
      expect(box.min.y, type).toBeLessThan(0.6 * r);
    }
  });
});
