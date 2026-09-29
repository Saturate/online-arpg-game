import { describe, expect, it } from 'vitest';
import { createRune, createSigil, createVessel, dayPhaseAt, hourOfPhase, phaseOfHour, ownedRunes, rollDrops, Rng, RUNE_STACK, Simulation, DEFAULT_DROP_TUNING } from '../src/index.js';
import { addItem } from '../src/sim/inventory.js';

function atForge() {
  const sim = new Simulation(4, { kind: 'zone', zone: 'barrens', seed: 3 });
  const pid = sim.addPlayer('c', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  const forge = sim.mapDef.forge;
  if (!p || !pos || !forge) throw new Error('setup');
  pos.x = forge.x + 50;
  pos.y = forge.y;
  const blank = createSigil(sim.newItemUid(), sim.rand.loot, 'magic');
  blank.runes = [];
  blank.skill = null;
  addItem(p, blank);
  return { sim, pid, p, pos, forge, blank };
}

describe('runes', () => {
  it('stack in one bag cell up to the cap', () => {
    const { sim, p } = atForge();
    addItem(p, createRune(sim.newItemUid(), 'fire', 12));
    addItem(p, createRune(sim.newItemUid(), 'fire', 12));
    expect(ownedRunes(p).get('fire')).toBe(24);
    const stacks = [...p.items.values()].filter((i) => i.kind === 'rune' && i.rune === 'fire');
    expect(stacks.map((s) => (s.kind === 'rune' ? s.count : 0)).sort((a, b) => b - a)).toEqual([RUNE_STACK, 4]);
  });

  it('drop from monsters as part of the loot', () => {
    let uid = 1;
    const rng = new Rng(3);
    let runes = 0;
    for (let i = 0; i < 400; i++) runes += rollDrops(rng, () => uid++, { level: 3, rare: true, boss: false }, DEFAULT_DROP_TUNING).filter((it) => it.kind === 'rune').length;
    expect(runes).toBeGreaterThan(100);
  });
});

describe('forge', () => {
  it('spends runes from the bag to inscribe and gives back the ones taken out', () => {
    const { sim, pid, p, blank } = atForge();
    addItem(p, createRune(sim.newItemUid(), 'bolt', 1));
    addItem(p, createRune(sim.newItemUid(), 'fire', 2));
    expect(sim.inscribe(pid, blank.uid, ['bolt', 'fire'])).toBeNull();
    expect(ownedRunes(p).get('bolt') ?? 0).toBe(0);
    expect(ownedRunes(p).get('fire')).toBe(1);
    // Swapping fire for a second fire costs one more fire; taking one out hands it back.
    expect(sim.inscribe(pid, blank.uid, ['bolt'])).toBeNull();
    expect(ownedRunes(p).get('fire')).toBe(2);
  });

  it('refuses runes you do not have, and anywhere but the forge', () => {
    const { sim, pid, pos, forge, blank } = atForge();
    expect(sim.inscribe(pid, blank.uid, ['bolt'])).toBe('You need a Bolt Rune');
    pos.x = forge.x + 2000;
    expect(sim.inscribe(pid, blank.uid, ['bolt'])).toBe('Sigils are inscribed at the forge in town');
  });

  it('lets builders use the free bench only on test maps', () => {
    const bench = new Simulation(5, { kind: 'flat' });
    const pid = bench.addPlayer('c', 'mage');
    const p = bench.world.player.get(pid);
    if (!p) throw new Error('no player');
    const sigil = createSigil(bench.newItemUid(), bench.rand.loot, 'magic');
    addItem(p, sigil);
    expect(bench.inscribe(pid, sigil.uid, ['bolt', 'fire'], true)).toBeNull();
    expect(bench.inscribe(pid, sigil.uid, ['bolt', 'cold'], false)).toBe('Sigils are inscribed at the forge in town');
  });

  it('hands back bound runes from a starter sigil, which cannot be sold', () => {
    const { sim, pid, p } = atForge();
    const starter = [...p.items.values()].find((i) => i.kind === 'sigil' && i.bound === true && i.runes.length > 0);
    if (!starter || starter.kind !== 'sigil') throw new Error('no starter sigil with runes');
    const first = starter.runes[0];
    if (!first) throw new Error('no rune');
    // Built-in skills can hold more runes than a common sigil would, so clear it rather than trim it.
    expect(sim.inscribe(pid, starter.uid, [])).toBeNull();
    const back = [...p.items.values()].find((i) => i.kind === 'rune' && i.rune === first);
    expect(back?.bound).toBe(true);
  });
});

describe('warband size', () => {
  it('is limited by spirit, not by a slot count', () => {
    const sim = new Simulation(6, { kind: 'flat' });
    const pid = sim.addPlayer('c', 'binder');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    p.stats.spiritMax = 10_000;
    for (let slot = 1; slot < 9; slot++) {
      const v = createVessel(sim.newItemUid(), sim.rand.loot, 'common', 'zombie_brute');
      addItem(p, v);
      expect(sim.equipVessel(pid, v.uid, slot)).toBeNull();
    }
    for (let i = 0; i < 5; i++) sim.step();
    expect(p.minions.filter((m) => m !== null).length).toBe(9);
    // With normal spirit the next one is refused.
    p.stats.spiritMax = 1;
    const extra = createVessel(sim.newItemUid(), sim.rand.loot, 'common', 'zombie_brute');
    addItem(p, extra);
    expect(sim.equipVessel(pid, extra.uid, 12)).toBe('Not enough spirit to bind that vessel');
  });
});

describe('world clock', () => {
  const base = { dayMinutes: 20, nightBrightness: 0.6, timeOfDay: 'cycle' as const, clockOffset: 0, heldPhase: 0.25 };
  it('maps phases and hours both ways', () => {
    expect(hourOfPhase(0)).toBe(6);
    expect(phaseOfHour(6)).toBe(0);
    expect(hourOfPhase(phaseOfHour(21.5))).toBeCloseTo(21.5);
  });
  it('shifts a running clock by the offset, and holds when told to', () => {
    const now = 1_000_000_000;
    const raw = dayPhaseAt(now, base);
    const target = phaseOfHour(22);
    const offset = (((target - raw) % 1) + 1) % 1;
    expect(hourOfPhase(dayPhaseAt(now, { ...base, clockOffset: offset }))).toBeCloseTo(22);
    expect(dayPhaseAt(now + 60_000, { ...base, timeOfDay: 'hold', heldPhase: target })).toBe(target);
  });
});
