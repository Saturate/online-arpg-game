import { describe, expect, it } from 'vitest';
import { DEFAULT_RATES, HEAT, SIM, SKILL_BUTTONS, Simulation } from '../src/index.js';

function mage() {
  const sim = new Simulation(3);
  const pid = sim.addPlayer('f', 'mage');
  const p = sim.world.player.get(pid);
  if (!p) throw new Error('setup');
  return { sim, pid, p };
}

describe('admin Force rates', () => {
  it('a lower Force bar applies to players already in the room', () => {
    const { sim, p } = mage();
    expect(p.stats.heatMax).toBe(HEAT.max);
    p.heat = 500;
    sim.setRates({ ...DEFAULT_RATES, forceMax: 150 });
    expect(p.stats.heatMax).toBe(150);
    expect(p.heat).toBe(150);
  });

  it('cost and cooling rates scale casting and recovery', () => {
    const cast = (rates: typeof DEFAULT_RATES): number => {
      const { sim, pid, p } = mage();
      sim.setRates(rates);
      sim.applyInput(pid, { seq: 1, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: SKILL_BUTTONS[0] });
      return p.heat;
    };
    const base = cast(DEFAULT_RATES);
    expect(base).toBeGreaterThan(0);
    expect(cast({ ...DEFAULT_RATES, forceCost: 2 })).toBeCloseTo(base * 2);

    const cool = (rate: number): number => {
      const { sim, p } = mage();
      sim.setRates({ ...DEFAULT_RATES, forceCool: rate });
      p.heat = 100;
      for (let i = 0; i < SIM.tickRate; i++) sim.step();
      return 100 - p.heat;
    };
    expect(cool(0.5)).toBeCloseTo(cool(1) / 2, 0);
  });
});
