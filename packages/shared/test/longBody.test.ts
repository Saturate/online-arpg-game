import { describe, expect, it } from 'vitest';
import { bodyGap, nearestHurt, SKILL_BUTTONS, Simulation, sizeBody } from '../src/index.js';
import { serializeEntities } from '../src/sim/snapshot.js';
import { compileText } from './helpers/spell.js';

describe('long bodies', () => {
  it('grow with a rare and a height override, as the model does, and go with another model', () => {
    const tip = (b: ReturnType<typeof sizeBody>) => bodyGap(b, 0, 0, 0, -126 - 9, 0);
    expect(tip(sizeBody('charger', 26, undefined))).toBeCloseTo(0);
    const rare = sizeBody('charger', 26 * 1.45, undefined);
    expect(bodyGap(rare, 0, 0, 0, (-126 - 9) * 1.45, 0)).toBeCloseTo(0);
    const taller = sizeBody('charger', 26, { height: 120 });
    expect(bodyGap(taller, 0, 0, 0, (-126 - 9) * 1.5, 0)).toBeCloseTo(0);
    expect(taller?.pivot).toBeCloseTo(-75);
    expect(sizeBody('charger', 26, { model: 'mon_charger', height: 80 })).not.toBeNull();
    expect(sizeBody('charger', 26, { model: 'mon_ogre' })).toBeNull();
    expect(sizeBody('grave_hound', 17, undefined)).toBeNull();
  });

  it('finds the nearest hurt circle, the collider for anything without a body', () => {
    const body = sizeBody('charger', 26, undefined);
    expect(nearestHurt(body, 0, 0, 26, 0, -200, 0, { x: 0, y: 0, r: 0 })).toEqual({ x: -126, y: 0, r: 9 });
    expect(nearestHurt(body, 0, 0, 26, 0, 60, 0, { x: 0, y: 0, r: 0 })).toEqual({ x: 0, y: 0, r: 26 });
    expect(nearestHurt(null, 5, 5, 14, 0, -200, 0, { x: 0, y: 0, r: 0 })).toEqual({ x: 5, y: 5, r: 14 });
  });

  it("releases a bolt's on-hit payload where it struck the tail, not at the collider", () => {
    const sim = new Simulation(5, { kind: 'flat' });
    sim.waveTimer = Infinity;
    const pid = sim.addPlayer('p', 'mage');
    const p = sim.world.player.get(pid);
    const pos = sim.world.position.get(pid);
    if (!p || !pos) throw new Error('no player');
    p.sigils = [{ uid: -1, compiled: compileText('bolt[onhit] nova'), misfireMultiplier: 1, castDelayShare: 1 }, null, null, null];
    // Facing +y with its collider 100 below the bolt's line: only the tail crosses the line. Just
    // outside its aggro radius, so it does not wake and turn before the bolt arrives.
    const at = { x: pos.x + 470, y: pos.y + 100 };
    const id = sim.spawnEnemy('charger', at.x, at.y);
    let nova: { x: number; y: number } | null = null;
    for (let t = 0; t < 90 && !nova; t++) {
      const e = sim.world.enemy.get(id);
      const epos = sim.world.position.get(id);
      if (e && epos) {
        e.facing = Math.PI / 2;
        e.aggro = false;
        epos.x = at.x;
        epos.y = at.y;
      }
      sim.applyInput(pid, { seq: t + 1, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: t === 0 ? (SKILL_BUTTONS[0] ?? 0) : 0 });
      sim.waveTimer = Infinity;
      sim.step();
      sim.takeEvents();
      const n = serializeEntities(sim).find((s) => s.k === 'nova');
      if (n) nova = { x: n.x, y: n.y };
    }
    if (!nova) throw new Error('the bolt never hit');
    // On the bolt's line at the tail, about 100 from the collider.
    expect(Math.abs(nova.y - pos.y)).toBeLessThan(20);
    expect(Math.hypot(nova.x - at.x, nova.y - at.y)).toBeGreaterThan(80);
  });
});
