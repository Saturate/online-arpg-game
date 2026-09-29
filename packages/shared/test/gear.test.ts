import { describe, expect, it } from 'vitest';
import { CLASSES, createGear, formatNumber, STAT_LABELS, GEAR_BASES, gearStats, Simulation, SIM, type GearItem } from '../src/index.js';

function give(sim: Simulation, pid: number, item: GearItem): void {
  const p = sim.world.player.get(pid)!;
  p.items.set(item.uid, item);
  p.inventory[p.inventory.indexOf(null)] = item.uid;
}

describe('gear', () => {
  it('new characters start with their class weapon equipped', () => {
    const sim = new Simulation(1);
    const id = sim.addPlayer('c', 'mage');
    const p = sim.world.player.get(id)!;
    const weapon = p.items.get(p.gear.weapon ?? -1);
    expect(weapon?.kind === 'gear' && weapon.base).toBe('gnarled_staff');
  });

  it('bases respect item level and affixes respect their slots', () => {
    const sim = new Simulation(2);
    for (let i = 0; i < 200; i++) {
      const g = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 1);
      const base = GEAR_BASES.find((b) => b.id === g.base)!;
      expect(base.level).toBeLessThanOrEqual(1);
      if (g.category !== 'boots') expect(g.affixes.some((a) => a.id === 'gear_move')).toBe(false);
    }
  });

  it('spreads drops evenly over slots rather than over bases', () => {
    const sim = new Simulation(9);
    const counts = new Map<string, number>();
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const g = createGear(sim.newItemUid(), sim.rand.loot, 'magic', 5);
      counts.set(g.category, (counts.get(g.category) ?? 0) + 1);
    }
    // Eight slots at ilvl 5: each should land near 12.5%.
    for (const c of counts.values()) expect(c / n).toBeGreaterThan(0.09);
    expect((counts.get('weapon') ?? 0) / n).toBeLessThan(0.16);
  });

  it('equipping boots with movement speed makes the player faster, and prediction uses the same speed', () => {
    const sim = new Simulation(3);
    const id = sim.addPlayer('c', 'ranger');
    const boots: GearItem = { uid: sim.newItemUid(), kind: 'gear', tier: 'magic', name: 'Swift Sandals', ilvl: 1, base: 'sandals', category: 'boots', affixes: [{ id: 'gear_move', tier: 0, value: 10 }] };
    give(sim, id, boots);
    expect(sim.equipGear(id, boots.uid)).toBeNull();
    const p = sim.world.player.get(id)!;
    expect(p.stats.moveSpeed).toBeCloseTo(CLASSES.ranger.moveSpeed * 1.14);
    const start = { ...sim.world.position.get(id)! };
    sim.applyInput(id, { seq: 0, moveDir: { x: 1, y: 0 }, aimAngle: 0, buttons: 0 });
    expect(sim.world.position.get(id)!.x - start.x).toBeCloseTo(p.stats.moveSpeed * SIM.dt);
  });

  it('life gear raises max life and removing it keeps the life ratio', () => {
    const sim = new Simulation(4);
    const id = sim.addPlayer('c', 'warrior');
    const belt: GearItem = { uid: sim.newItemUid(), kind: 'gear', tier: 'common', name: 'Heavy Belt', ilvl: 3, base: 'heavy_belt', category: 'belt', affixes: [] };
    give(sim, id, belt);
    sim.equipGear(id, belt.uid);
    const h = sim.world.health.get(id)!;
    expect(h.maxLife).toBe(CLASSES.warrior.life + 20);
    h.life = h.maxLife / 2;
    expect(sim.unequipGear(id, 'belt')).toBeNull();
    expect(h.maxLife).toBe(CLASSES.warrior.life);
    expect(h.life).toBeCloseTo(CLASSES.warrior.life / 2);
  });

  it('rings fill the empty ring slot first', () => {
    const sim = new Simulation(5);
    const id = sim.addPlayer('c', 'mage');
    const r1 = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { base: 'iron_ring' });
    const r2 = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { base: 'iron_ring' });
    give(sim, id, r1);
    give(sim, id, r2);
    sim.equipGear(id, r1.uid);
    sim.equipGear(id, r2.uid);
    const p = sim.world.player.get(id)!;
    expect([p.gear.ring1, p.gear.ring2].sort()).toEqual([r1.uid, r2.uid].sort());
    expect(gearStats([r1, r2]).damage).toBe(10);
  });

  it('gear survives moving between rooms', () => {
    const a = new Simulation(6, { kind: 'town' });
    const id = a.addPlayer('c', 'priest', 'P');
    const save = a.exportPlayer(id)!;
    const b = new Simulation(7, { kind: 'arena' });
    const id2 = b.addPlayer('c', save.classId, save.name, save);
    const p = b.world.player.get(id2)!;
    expect(p.items.get(p.gear.weapon ?? -1)?.kind).toBe('gear');
  });
});

describe('number display', () => {
  it('hides float noise and negative zero', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(0.8 - 0.7)).toBe('0.1');
    expect(formatNumber(-0.0001)).toBe('0');
    expect(formatNumber(12)).toBe('12');
    expect(STAT_LABELS.lifeRegen(0.1 + 0.2)).toBe('Regenerate 0.3 life per second');
  });
});
