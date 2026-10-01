import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  createRolledRune,
  createRune,
  createSigil,
  createVessel,
  dayPhaseAt,
  DEFAULT_DROP_TUNING,
  forgeInsertPrice,
  hourOfPhase,
  isCastableRune,
  ownedRunes,
  phaseOfHour,
  rollDrops,
  Rng,
  RUNE_STACK,
  runeMayCarry,
  sellItem,
  Simulation,
} from '../src/index.js';
import { tab1 } from './helpers/stash.js';
import { addItem } from '../src/sim/inventory.js';
import { applyDev, parseDevCommand } from '../src/sim/dev.js';

function atForge() {
  const sim = new Simulation(4, { kind: 'world', seed: 3 });
  const pid = sim.addPlayer('c', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  const forge = sim.mapDef.forge;
  if (!p || !pos || !forge) throw new Error('setup');
  pos.x = forge.x + 50;
  pos.y = forge.y;
  const blank = createSigil(sim.newItemUid(), sim.rand.loot, 'magic');
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
  it('spends plain runes from the bag, then the stash, and gives back the ones taken out', () => {
    const { sim, pid, p, blank } = atForge();
    p.gold = 1000;
    addItem(p, createRune(sim.newItemUid(), 'bolt', 1));
    const stashed = createRune(sim.newItemUid(), 'bolt', 3);
    p.items.set(stashed.uid, stashed);
    tab1(p)[0] = stashed.uid;
    expect(sim.inscribe(pid, blank.uid, [{ from: 'plain', rune: 'bolt' }, { from: 'plain', rune: 'bolt' }])).toBeNull();
    expect(blank.slots.map((r) => r.rune)).toEqual(['bolt', 'bolt']);
    expect(ownedRunes(p).get('bolt') ?? 0).toBe(0);
    expect(stashed.count).toBe(2);
    expect(p.gold).toBe(1000 - 2 * forgeInsertPrice(createRune(0, 'bolt')));
    // Taking one out is free and it lands in the bag, not back in the stash.
    const gold = p.gold;
    expect(sim.inscribe(pid, blank.uid, [{ from: 'keep', index: 1 }])).toBeNull();
    expect(p.gold).toBe(gold);
    expect(ownedRunes(p).get('bolt')).toBe(1);
    expect(stashed.count).toBe(2);
  });

  it('refuses runes you do not have, and anywhere but the forge', () => {
    const { sim, pid, p, pos, blank } = atForge();
    p.gold = 1000;
    expect(sim.inscribe(pid, blank.uid, [{ from: 'plain', rune: 'fire' }])).toBe('You need a Fire Rune');
    addItem(p, createRune(sim.newItemUid(), 'fire', 1));
    pos.x += 2000;
    expect(sim.inscribe(pid, blank.uid, [{ from: 'plain', rune: 'fire' }])).toBe('Sigils are inscribed at the forge in town');
    expect(blank.slots).toEqual([]);
  });

  it('lets builders use the free bench only on test maps', () => {
    const { sim, pid, pos, blank } = atForge();
    pos.x += 2000;
    // A zone room has no bench, so dev rights do not help away from the forge.
    expect(sim.inscribe(pid, blank.uid, [{ from: 'plain', rune: 'bolt' }], true)).toBe('Sigils are inscribed at the forge in town');
    const flat = new Simulation(5);
    const fid = flat.addPlayer('b', 'mage');
    const fp = flat.world.player.get(fid);
    if (!fp) throw new Error('setup');
    const s = createSigil(flat.newItemUid(), flat.rand.loot, 'magic');
    addItem(fp, s);
    expect(flat.inscribe(fid, s.uid, [{ from: 'plain', rune: 'bolt' }])).toBe('Sigils are inscribed at the forge in town');
    expect(flat.inscribe(fid, s.uid, [{ from: 'plain', rune: 'bolt' }, { from: 'plain', rune: 'fire' }], true)).toBeNull();
    expect(s.slots.every((r) => r.bound === true)).toBe(true);
    expect(fp.gold).toBe(0);
  });

  it('hands back bound runes from a starter sigil, which cannot be sold', () => {
    const { sim, pid, p, pos } = atForge();
    const eq = p.sigils[0];
    const starter = eq ? p.items.get(eq.uid) : undefined;
    if (starter?.kind !== 'sigil') throw new Error('no starter sigil');
    const first = starter.slots[0];
    if (!first) throw new Error('empty starter');
    expect(sim.inscribe(pid, starter.uid, starter.slots.slice(1).map((_, i) => ({ from: 'keep', index: i + 1 })))).toBeNull();
    const back = p.items.get(first.uid) ?? [...p.items.values()].find((i) => i.kind === 'rune' && i.rune === first.rune && i.bound === true);
    expect(back?.kind).toBe('rune');
    expect(back?.bound).toBe(true);
    const trader = sim.mapDef.trader;
    if (!trader || !back) throw new Error('no trader');
    pos.x = trader.x + 50;
    pos.y = trader.y;
    expect(sellItem(sim, pid, back.uid)).toBe('Bound items cannot be sold');
  });

  it('puts a rolled rune in whole, and takes it out with the same uid and rolls', () => {
    const { sim, pid, p, blank } = atForge();
    p.gold = 1000;
    const rolled = createRolledRune(sim.newItemUid(), sim.rand.loot, 'rare', 6, 'orb');
    addItem(p, rolled);
    const rolls = JSON.stringify(rolled.affixes);
    expect(sim.inscribe(pid, blank.uid, [{ from: 'rolled', uid: rolled.uid }])).toBeNull();
    expect(p.items.has(rolled.uid)).toBe(false);
    expect(p.gold).toBe(1000 - forgeInsertPrice(rolled));
    expect(sim.inscribe(pid, blank.uid, [])).toBeNull();
    const back = p.items.get(rolled.uid);
    expect(back?.kind === 'rune' && JSON.stringify(back.affixes)).toBe(rolls);
    expect(p.inventory.includes(rolled.uid)).toBe(true);
  });

  it('saving an unchanged sigil costs nothing, even away from the forge', () => {
    const { sim, pid, p, pos } = atForge();
    const eq = p.sigils[0];
    const starter = eq ? p.items.get(eq.uid) : undefined;
    if (starter?.kind !== 'sigil') throw new Error('no starter sigil');
    pos.x += 2000;
    const before = JSON.stringify(starter);
    expect(sim.inscribe(pid, starter.uid, starter.slots.map((_, i) => ({ from: 'keep', index: i })))).toBeNull();
    expect(JSON.stringify(starter)).toBe(before);
    expect(p.sigils[0]).toBe(eq);
  });
});

describe('rolled rune drops', () => {
  it('are about a fifth of rune drops, castable, and carry only affixes their rune may', () => {
    let uid = 1;
    const rng = new Rng(11);
    let plain = 0;
    let rolled = 0;
    for (let i = 0; i < 3000; i++) {
      for (const item of rollDrops(rng, () => uid++, { level: 6, rare: true, boss: false })) {
        if (item.kind !== 'rune') continue;
        expect(isCastableRune(item.rune)).toBe(true);
        if (item.affixes.length === 0) {
          plain++;
          continue;
        }
        rolled++;
        expect(item.count).toBe(1);
        for (const a of item.affixes) expect(runeMayCarry(item.rune, a.id), `${item.rune} ${a.id}`).toBe(true);
        expect(new Set(item.affixes.map((a) => AFFIXES[a.id].group)).size).toBe(item.affixes.length);
      }
    }
    expect(rolled / (plain + rolled)).toBeGreaterThan(0.15);
    expect(rolled / (plain + rolled)).toBeLessThan(0.25);
  });

  it('roll higher affix tiers from deeper monsters, like gear', () => {
    const rng = new Rng(4);
    const maxTier = (ilvl: number): number => {
      let best = 0;
      for (let i = 0; i < 400; i++) for (const a of createRolledRune(i, rng, 'relic', ilvl).affixes) best = Math.max(best, a.tier);
      return best;
    };
    expect(maxTier(1)).toBe(0);
    expect(maxTier(8)).toBe(2);
  });

  it('can be given with the dev tools, bound like every dev item', () => {
    const sim = new Simulation(2);
    const pid = sim.addPlayer('b', 'mage');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('setup');
    const cmd = parseDevCommand({ c: 'give', item: 'rune', tier: 'rare', level: 6, category: null, rune: 'bolt' });
    if (!cmd) throw new Error('refused');
    applyDev(sim, pid, cmd);
    const given = [...p.items.values()].find((i) => i.kind === 'rune' && i.affixes.length > 0);
    expect(given?.kind === 'rune' && given.rune).toBe('bolt');
    expect(given?.bound).toBe(true);
    expect(parseDevCommand({ c: 'give', item: 'rune', tier: 'rare', level: 6, category: null, rune: 'beam' })).toBeNull();
  });

  it('never stack, while plain runes stack to 20', () => {
    const { sim, p } = atForge();
    addItem(p, createRolledRune(sim.newItemUid(), sim.rand.loot, 'magic', 3, 'bolt'));
    addItem(p, createRolledRune(sim.newItemUid(), sim.rand.loot, 'magic', 3, 'bolt'));
    const rolled = [...p.items.values()].filter((i) => i.kind === 'rune' && i.affixes.length > 0);
    expect(rolled.length).toBe(2);
    expect(rolled.every((r) => r.kind === 'rune' && r.count === 1)).toBe(true);
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
  const base = { dayMinutes: 20, nightBrightness: 0.6, timeOfDay: 'cycle' as const, clockOffset: 0, heldPhase: 0.25, heroLight: 1, heroLightRadius: 700, lampLight: 1 };
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
