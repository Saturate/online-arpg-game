import { describe, expect, it } from 'vitest';
import { addItem } from '../src/sim/inventory.js';
import {
  createGear,
  createRolledRune,
  createRune,
  createSigil,
  findSpot,
  forgeInsertPrice,
  itemSize,
  parseClientMessage,
  place,
  Rng,
  sigilCapacity,
  Simulation,
  STASH,
  type EntityId,
  type Item,
  type ItemUid,
  type PlayerComp,
  type RuneId,
  type RuneItem,
  type RuneRef,
} from '../src/index.js';

/**
 * Random inscribe sequences against the one promise the forge makes: runes only move. Every rune
 * (by id, rolls and binding) is somewhere afterwards, gold drops by exactly the forge price of what
 * went in, a refusal changes nothing, and no uid is ever in two places.
 */

const PLAIN_POOL: readonly RuneId[] = ['orb', 'bolt', 'fire', 'cold', 'nova', 'aura', 'ward', 'split', 'lightning'];
const ROLL_POOL: readonly RuneId[] = ['orb', 'bolt', 'nova', 'zone', 'split'];

function key(r: RuneItem): string {
  return `${r.rune}|${r.bound === true}|${JSON.stringify(r.affixes)}`;
}

/** Every rune the character has, wherever it is: bag, stash, pending, or a slot of any sigil. */
function runeMultiset(p: PlayerComp, skip: (r: RuneItem) => boolean = () => false): Map<string, number> {
  const out = new Map<string, number>();
  const add = (r: RuneItem, n: number): void => {
    if (!skip(r)) out.set(key(r), (out.get(key(r)) ?? 0) + n);
  };
  for (const it of p.items.values()) {
    if (it.kind === 'rune') add(it, it.count);
    if (it.kind === 'sigil') for (const r of it.slots) add(r, 1);
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

function snapshot(p: PlayerComp): string {
  const items = [...p.items.values()].sort((a, b) => a.uid - b.uid);
  return JSON.stringify({ items, bag: p.inventory, stash: p.stash, gold: p.gold, sigils: p.sigils.map((s) => s?.uid ?? null), links: p.links });
}

/** The uid rule: each uid in exactly one place, grids only point at owned items, slots hold whole single runes. */
function checkUids(p: PlayerComp): void {
  const seen = new Set<ItemUid>();
  const see = (u: ItemUid): void => {
    expect(seen.has(u), `uid ${u} twice`).toBe(false);
    seen.add(u);
  };
  for (const it of p.items.values()) {
    see(it.uid);
    if (it.kind === 'sigil') {
      expect(it.slots.length).toBeLessThanOrEqual(sigilCapacity(it));
      for (const r of it.slots) {
        see(r.uid);
        expect(r.count).toBe(1);
        expect(p.items.has(r.uid)).toBe(false);
      }
    }
    if (it.kind === 'rune') {
      expect(it.count).toBeGreaterThan(0);
      if (it.affixes.length > 0) expect(it.count).toBe(1);
      else expect(it.count).toBeLessThanOrEqual(20);
    }
  }
  for (const u of [...p.inventory, ...p.stash]) if (u !== null) expect(p.items.has(u), `grid points at missing ${u}`).toBe(true);
  // Bound items never reach the account's stash.
  for (const u of new Set(p.stash)) {
    const it = u === null ? undefined : p.items.get(u);
    if (it) expect(it.bound === true || (it.kind === 'sigil' && it.slots.some((r) => r.bound === true)), `bound ${it.name} in stash`).toBe(false);
  }
}

function stash(p: PlayerComp, item: Item): void {
  const size = itemSize(item);
  const spot = findSpot(p.stash, STASH, size);
  if (!spot) return;
  p.items.set(item.uid, item);
  place(p.stash, STASH, item.uid, size, spot.x, spot.y);
}

interface World {
  sim: Simulation;
  pid: EntityId;
  p: PlayerComp;
  foreign: ItemUid[];
  forge: { x: number; y: number };
}

function setup(seed: number, flat: boolean, fullBag: boolean): World {
  const sim = flat ? new Simulation(seed) : new Simulation(seed, { kind: 'zone', zone: 'barrens', seed: 3 });
  const pid = sim.addPlayer('c', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  if (!p || !pos) throw new Error('setup');
  const forge = sim.mapDef.forge ?? { x: pos.x, y: pos.y };
  pos.x = forge.x + 50;
  pos.y = forge.y;
  const rng = new Rng(seed);
  const loot = sim.rand.loot;
  const rolled = (rune: RuneId, bound: boolean): RuneItem => {
    const r = createRolledRune(sim.newItemUid(), loot, rng.next() < 0.5 ? 'magic' : 'rare', rng.int(1, 8), rune);
    if (bound) r.bound = true;
    return r;
  };
  for (const tier of ['common', 'magic', 'rare', 'relic'] as const) addItem(p, createSigil(sim.newItemUid(), loot, tier));
  const equipped = createSigil(sim.newItemUid(), loot, 'rare');
  addItem(p, equipped);
  sim.equipSigil(pid, equipped.uid, 3);
  for (const rune of PLAIN_POOL) {
    addItem(p, createRune(sim.newItemUid(), rune, rng.int(1, 4)));
    if (rng.next() < 0.5) {
      const b = createRune(sim.newItemUid(), rune, rng.int(1, 3));
      b.bound = true;
      addItem(p, b);
    }
    if (rng.next() < 0.6) stash(p, createRune(sim.newItemUid(), rune, rng.int(1, 5)));
  }
  for (const rune of ROLL_POOL) {
    addItem(p, rolled(rune, rng.next() < 0.3));
    stash(p, rolled(rune, false));
  }
  stash(p, createSigil(sim.newItemUid(), loot, 'magic'));
  // Another character in the same room, with runes of its own in its stash.
  const oid = sim.addPlayer('d', 'mage');
  const other = sim.world.player.get(oid);
  const foreign: ItemUid[] = [];
  if (other) {
    for (const rune of ROLL_POOL) {
      const r = rolled(rune, false);
      stash(other, r);
      foreign.push(r.uid);
    }
  }
  if (fullBag) while (addItem(p, createGear(sim.newItemUid(), loot, 'common', 1, { category: 'ring' })));
  p.gold = rng.int(0, 400);
  return { sim, pid, p, foreign, forge };
}

function sigilUids(p: PlayerComp): ItemUid[] {
  return [...p.items.values()].filter((i) => i.kind === 'sigil').map((i) => i.uid);
}

function rolledUids(p: PlayerComp): ItemUid[] {
  return [...p.items.values()].filter((i) => i.kind === 'rune' && i.affixes.length > 0).map((i) => i.uid);
}

function randomRefs(rng: Rng, w: World, sigil: Item | undefined): RuneRef[] {
  const slots = sigil?.kind === 'sigil' ? sigil.slots : [];
  const cap = sigil?.kind === 'sigil' ? sigilCapacity(sigil) : 3;
  const n = rng.int(0, cap + 1);
  const refs: RuneRef[] = [];
  const rolled = rolledUids(w.p);
  for (let i = 0; i < n; i++) {
    const roll = rng.next();
    if (roll < 0.35 && slots.length > 0) refs.push({ from: 'keep', index: rng.int(0, slots.length) });
    else if (roll < 0.7) refs.push({ from: 'plain', rune: PLAIN_POOL[rng.int(0, PLAIN_POOL.length - 1)] ?? 'fire' });
    else {
      const pick = rng.next();
      const uid =
        pick < 0.6
          ? rolled[rng.int(0, Math.max(0, rolled.length - 1))]
          : pick < 0.75
            ? w.foreign[rng.int(0, w.foreign.length - 1)]
            : pick < 0.85
              ? slots[rng.int(0, Math.max(0, slots.length - 1))]?.uid
              : pick < 0.92
                ? sigil?.uid
                : rng.int(0, 5000);
      refs.push({ from: 'rolled', uid: uid ?? 0 });
    }
  }
  // Now and then the same keep index or rolled uid twice, which must never copy a rune.
  if (refs.length > 0 && rng.next() < 0.1) {
    const dup = refs[rng.int(0, refs.length - 1)];
    if (dup && dup.from !== 'plain') refs.push(dup);
  }
  // And now and then a plain reorder of what is there, which is free.
  if (rng.next() < 0.1) return slots.map((_, i): RuneRef => ({ from: 'keep', index: i })).reverse();
  return refs;
}

function expectedCost(p: PlayerComp, refs: readonly RuneRef[], free: boolean): number {
  if (free) return 0;
  let cost = 0;
  for (const r of refs) {
    if (r.from === 'plain') cost += forgeInsertPrice(createRune(0, r.rune));
    if (r.from === 'rolled') {
      const it = p.items.get(r.uid);
      if (it?.kind === 'rune') cost += forgeInsertPrice(it);
    }
  }
  return cost;
}

function run(seed: number, flat: boolean, fullBag: boolean, steps: number): { ok: number; refused: number } {
  const w = setup(seed, flat, fullBag);
  const { sim, pid, p } = w;
  const pos = sim.world.position.get(pid);
  if (!pos) throw new Error('setup');
  const rng = new Rng(seed * 7919 + 1);
  const free = flat;
  // The bench makes bound plain runes out of nothing and lets them go again, so those are left out.
  const skip = free ? (r: RuneItem): boolean => r.bound === true && r.affixes.length === 0 : undefined;
  let ok = 0;
  let refused = 0;
  checkUids(p);
  for (let step = 0; step < steps; step++) {
    const env = rng.next();
    pos.x = env < 0.05 ? w.forge.x + 3000 : w.forge.x + 50;
    p.stats.spiritMax = env > 0.9 ? 0 : 1000;
    if (env > 0.97) p.gold = 0;
    else if (env > 0.94) p.gold += 200;
    const sigils = sigilUids(p);
    const uid = rng.next() < 0.03 ? rng.int(0, 5000) : (sigils[rng.int(0, sigils.length - 1)] ?? 0);
    const sigil = p.items.get(uid);
    const refs = randomRefs(rng, w, sigil);
    const valid = parseClientMessage({ t: 'inscribe', uid, slots: refs });
    const keeps = refs.filter((r) => r.from === 'keep').map((r) => r.index);
    const rolls = refs.filter((r) => r.from === 'rolled').map((r) => r.uid);
    if (new Set(keeps).size < keeps.length || new Set(rolls).size < rolls.length) expect(valid).toBeNull();
    const before = snapshot(p);
    const runes = runeMultiset(p, skip);
    const gold = p.gold;
    const cost = expectedCost(p, refs, free);
    const error = sim.inscribe(pid, uid, refs, free);
    if (error !== null) {
      refused++;
      expect(snapshot(p), error).toBe(before);
    } else {
      ok++;
      expect(runeMultiset(p, skip)).toEqual(runes);
      const unchanged = sigil?.kind === 'sigil' && refs.length === sigil.slots.length && refs.every((r, i) => r.from === 'keep' && r.index === i);
      expect(p.gold).toBe(unchanged ? gold : gold - cost);
      expect(p.gold).toBeGreaterThanOrEqual(0);
    }
    checkUids(p);
  }
  return { ok, refused };
}

describe('forge conservation', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${seed}: runes only move and gold pays for what goes in`, () => {
      const { ok, refused } = run(seed, false, false, 250);
      // Both paths get exercised, or the check proves nothing.
      expect(ok).toBeGreaterThan(20);
      expect(refused).toBeGreaterThan(20);
    });
  }

  it('with a full bag, refunds wait as pending instead of vanishing', () => {
    for (const seed of [7, 8, 9]) {
      const { ok } = run(seed, false, true, 250);
      expect(ok).toBeGreaterThan(10);
    }
  });

  it('on the free bench, found and rolled runes are kept and nothing costs gold', () => {
    for (const seed of [10, 11, 12]) {
      const { ok } = run(seed, true, seed === 12, 250);
      expect(ok).toBeGreaterThan(20);
    }
  });
});
