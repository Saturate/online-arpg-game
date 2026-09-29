import { describe, expect, it } from 'vitest';
import { applyDev } from '../src/sim/dev.js';
import { dealDamage } from '../src/sim/combat.js';
import { spawnEnemy } from '../src/sim/enemies.js';
import { addItem, discard, moveItem, pickupLoot, spawnBag } from '../src/sim/inventory.js';
import {
  BAG,
  buyItem,
  buyPrice,
  createGear,
  createRolledRune,
  createRune,
  createSigil,
  emptyGrid,
  forgeInsertPrice,
  holdsBoundRunes,
  itemSize,
  parseClientMessage,
  pendingItems,
  placements,
  restoreStash,
  sellItem,
  sellPrice,
  Simulation,
  STASH,
  findSpot,
  place,
  type Item,
  type PlayerComp,
  type RuneId,
  type RuneItem,
  type RuneRef,
} from '../src/index.js';

function town() {
  const sim = new Simulation(4, { kind: 'zone', zone: 'barrens', seed: 3 });
  const pid = sim.addPlayer('c', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  if (!p || !pos) throw new Error('setup');
  return { sim, pid, p, pos };
}

function standAt(pos: { x: number; y: number }, at: { x: number; y: number } | undefined): void {
  if (!at) throw new Error('no such spot');
  pos.x = at.x + 50;
  pos.y = at.y;
}

function blankSigil(sim: Simulation) {
  return createSigil(sim.newItemUid(), sim.rand.loot, 'rare');
}

/** Fills every free bag cell with junk rings. */
function fillBag(sim: Simulation, p: NonNullable<ReturnType<typeof town>['p']>): void {
  while (addItem(p, createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'ring' })));
}

function rolledRune(sim: Simulation, rune: RuneId): RuneItem {
  return createRolledRune(sim.newItemUid(), sim.rand.loot, 'rare', 6, rune);
}

/** Puts an item straight into the account stash grid, as a loaded stash would hold it. */
function putInStash<T extends Item>(p: PlayerComp, item: T): T {
  const size = itemSize(item);
  const spot = findSpot(p.stash, STASH, size);
  if (!spot) throw new Error('stash full');
  p.items.set(item.uid, item);
  place(p.stash, STASH, item.uid, size, spot.x, spot.y);
  return item;
}

/** Everything an inscribe could touch, to compare before and after a refusal. */
function state(p: PlayerComp): string {
  const items = [...p.items.values()].sort((a, b) => a.uid - b.uid);
  return JSON.stringify({ items, bag: p.inventory, stash: p.stash, gold: p.gold, sigils: p.sigils.map((s) => s?.uid ?? null) });
}

function runeStacks(p: { items: Map<number, Item>; inventory: (number | null)[] }, rune: string): RuneItem[] {
  return [...p.items.values()].filter((i): i is RuneItem => i.kind === 'rune' && i.rune === rune && p.inventory.includes(i.uid));
}

describe('item safety', () => {
  it('a refused trader purchase does not top up rune stacks', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.trader);
    addItem(p, createRune(sim.newItemUid(), 'bolt', 1));
    fillBag(sim, p);
    p.gold = 1000;
    const shelf = createRune(sim.newItemUid(), 'bolt', 20);
    expect(buyItem(sim, pid, shelf, 10)).toBe('No room in your bag');
    expect(runeStacks(p, 'bolt').map((s) => s.count)).toEqual([1]);
    expect(p.gold).toBe(1000);
  });

  it('prices a rune stack by its count', () => {
    const { sim } = town();
    const one = createRune(sim.newItemUid(), 'fire', 1);
    const twenty = createRune(sim.newItemUid(), 'fire', 20);
    expect(sellPrice(twenty)).toBe(sellPrice(one) * 20);
  });

  it('bound items and sigils holding bound runes cannot leave the character', () => {
    const { sim, pid, p, pos } = town();
    const bound = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'ring' });
    bound.bound = true;
    addItem(p, bound);
    const carrier = blankSigil(sim);
    const rune = createRune(sim.newItemUid(), 'fire', 1);
    rune.bound = true;
    carrier.slots = [rune];
    addItem(p, carrier);
    expect(discard(sim, pid, bound.uid)).toBe('Bound items stay with this character');
    expect(discard(sim, pid, carrier.uid)).toBe('Take the bound runes out first');
    standAt(pos, sim.mapDef.stash);
    expect(moveItem(sim, pid, bound.uid, 'stash', 0, 0)).toBe('Bound items stay with this character');
    standAt(pos, sim.mapDef.trader);
    expect(sellItem(sim, pid, carrier.uid)).toBe('Take the bound runes out first');
  });

  it('bound items found on load go to the bag, never the shared stash', () => {
    const { sim, pid } = town();
    const save = sim.exportPlayer(pid);
    if (!save) throw new Error('no save');
    const bound = createGear(9998, sim.rand.loot, 'common', 1, { category: 'ring' });
    bound.bound = true;
    save.items.push(bound);
    const other = new Simulation(5, { kind: 'zone', zone: 'barrens', seed: 3 });
    const id = other.addPlayer('c', 'mage', 'P', save);
    const p = other.world.player.get(id);
    if (!p) throw new Error('setup');
    const ring = [...p.items.values()].find((i) => i.kind === 'gear' && i.bound === true && i.category === 'ring');
    if (!ring) throw new Error('ring lost');
    expect(p.stash.includes(ring.uid)).toBe(false);
    expect(p.inventory.includes(ring.uid)).toBe(true);
  });

  it('children of a dev-spawned splitter pay nothing either', () => {
    const sim = new Simulation(2);
    const pid = sim.addPlayer('b', 'mage');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('setup');
    applyDev(sim, pid, { c: 'spawn', enemy: 'ooze', count: 1, level: 20, rare: false, x: 900, y: 900 });
    const xp = p.xp;
    for (let round = 0; round < 4; round++) {
      for (const id of [...sim.world.enemy.keys()]) dealDamage(sim, id, 1e9, pid, []);
      sim.step();
      sim.step();
    }
    expect(sim.world.enemy.size).toBe(0);
    expect(sim.world.loot.size).toBe(0);
    expect(p.xp).toBe(xp);
  });

  it('dev items are bound and dev monsters drop nothing', () => {
    const sim = new Simulation(2);
    const pid = sim.addPlayer('b', 'mage');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('setup');
    applyDev(sim, pid, { c: 'give', item: 'gear', tier: 'rare', level: 5, category: null });
    const given = [...p.items.values()].find((i) => i.kind === 'gear' && i.tier === 'rare');
    expect(given?.bound).toBe(true);
    applyDev(sim, pid, { c: 'spawn', enemy: 'chaser', count: 1, level: 30, rare: true, x: 900, y: 900 });
    const [id] = [...sim.world.enemy.keys()];
    if (id === undefined) throw new Error('no enemy');
    const xp = p.xp;
    dealDamage(sim, id, 1e9, pid, []);
    sim.step();
    expect(sim.world.loot.size).toBe(0);
    expect(p.xp).toBe(xp);
  });

  it('a monster raised by a shaman pays out nothing the second time', () => {
    const sim = new Simulation(2);
    const pid = sim.addPlayer('b', 'mage');
    const id = spawnEnemy(sim, 'chaser', 900, 900, { rare: true, level: 10, aggro: true });
    const e = sim.world.enemy.get(id);
    if (!e) throw new Error('no enemy');
    e.raised = true;
    e.rewards = false;
    dealDamage(sim, id, 1e9, pid, []);
    sim.step();
    expect(sim.world.loot.size).toBe(0);
  });

  it('cannot pick up loot through a wall', () => {
    const sim = new Simulation(2, { kind: 'zone', zone: 'barrens', seed: 3 });
    const pid = sim.addPlayer('b', 'mage');
    const pos = sim.world.position.get(pid);
    if (!pos) throw new Error('setup');
    // A rock thin enough that both sides are within pickup reach: 2r + 26 under the 92 reach.
    const rock = sim.mapDef.obstacles.find((o) => o.blocksShots && o.shape.type === 'circle' && o.shape.r >= 20 && o.shape.r <= 30);
    if (!rock || rock.shape.type !== 'circle') throw new Error('no rock to hide behind');
    const { x, y, r } = rock.shape;
    const ring = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'ring' });
    spawnBag(sim, x + r + 10, y, [ring], 8, null);
    const bagId = [...sim.world.loot.keys()].at(-1);
    const bagPos = bagId === undefined ? undefined : sim.world.position.get(bagId);
    if (bagId === undefined || !bagPos) throw new Error('no bag');
    expect(bagPos).toEqual({ x: x + r + 10, y });
    pos.x = x - r - 16;
    pos.y = y;
    expect(pickupLoot(sim, pid, bagId)).toBe('Out of reach');
  });

  it('inscribe takes plain runes from the bag first, bound stacks first, then the account stash', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.forge);
    p.gold = 1000;
    const sigil = blankSigil(sim);
    addItem(p, sigil);
    const free = createRune(sim.newItemUid(), 'fire', 1);
    const bound = createRune(sim.newItemUid(), 'fire', 1);
    bound.bound = true;
    addItem(p, free);
    addItem(p, bound);
    const stashed = putInStash(p, createRune(sim.newItemUid(), 'fire', 5));
    const fire: RuneRef = { from: 'plain', rune: 'fire' };
    expect(sim.inscribe(pid, sigil.uid, [fire])).toBeNull();
    expect(sigil.slots.map((r) => r.bound === true)).toEqual([true]);
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'keep', index: 0 }, fire])).toBeNull();
    expect(sigil.slots.map((r) => r.bound === true)).toEqual([true, false]);
    expect(stashed.count).toBe(5);
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'keep', index: 0 }, { from: 'keep', index: 1 }, fire])).toBeNull();
    expect(stashed.count).toBe(4);
    expect(runeStacks(p, 'fire')).toEqual([]);
    // The bound one was free.
    expect(p.gold).toBe(1000 - 2 * forgeInsertPrice(free));
  });

  it('inscribe takes a rolled rune from the bag or the stash, each uid at most once', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.forge);
    p.gold = 1000;
    const sigil = blankSigil(sim);
    addItem(p, sigil);
    const inBag = rolledRune(sim, 'orb');
    addItem(p, inBag);
    const inStash = putInStash(p, rolledRune(sim, 'bolt'));
    const twice: RuneRef[] = [{ from: 'rolled', uid: inBag.uid }, { from: 'rolled', uid: inBag.uid }];
    expect(parseClientMessage({ t: 'inscribe', uid: sigil.uid, slots: twice })).toBeNull();
    expect(parseClientMessage({ t: 'inscribe', uid: sigil.uid, slots: [{ from: 'keep', index: 0 }, { from: 'keep', index: 0 }] })).toBeNull();
    const before = state(p);
    expect(sim.inscribe(pid, sigil.uid, twice)).toBe('A rune can only fill one slot');
    expect(state(p)).toBe(before);
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'rolled', uid: inStash.uid }, { from: 'rolled', uid: inBag.uid }])).toBeNull();
    expect(sigil.slots.map((r) => r.uid)).toEqual([inStash.uid, inBag.uid]);
    expect(p.stash.includes(inStash.uid)).toBe(false);
    expect(p.items.has(inStash.uid)).toBe(false);
    expect(p.items.has(inBag.uid)).toBe(false);
    // A kept slot named twice would copy the rune.
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'keep', index: 0 }, { from: 'keep', index: 0 }])).toBe('A rune can only fill one slot');
    // A plain rune named as rolled, or a rune inside a sigil named by uid, is not a rolled rune you hold.
    const plain = createRune(sim.newItemUid(), 'fire', 2);
    addItem(p, plain);
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'rolled', uid: plain.uid }])).toBe('That rune is not a rolled one');
    const other = blankSigil(sim);
    addItem(p, other);
    expect(sim.inscribe(pid, other.uid, [{ from: 'rolled', uid: inBag.uid }])).toBe('That rune is not in your bag or stash');
  });

  it("inscribe refuses a rolled rune that lives in another character's stash", () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.forge);
    p.gold = 1000;
    const otherId = sim.addPlayer('d', 'mage');
    const other = sim.world.player.get(otherId);
    if (!other) throw new Error('setup');
    const theirs = putInStash(other, rolledRune(sim, 'orb'));
    const sigil = blankSigil(sim);
    addItem(p, sigil);
    const before = state(p);
    const theirsBefore = state(other);
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'rolled', uid: theirs.uid }])).toBe('That rune is not in your bag or stash');
    expect(state(p)).toBe(before);
    expect(state(other)).toBe(theirsBefore);
  });

  it('inscribe with keep refs moves slots for free, and refunds every slot not kept to the bag, else pending, never the stash', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.forge);
    const sigil = blankSigil(sim);
    const a = rolledRune(sim, 'orb');
    const b = createRune(sim.newItemUid(), 'fire', 1);
    const c = rolledRune(sim, 'bolt');
    sigil.slots = [a, b, c];
    addItem(p, sigil);
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'keep', index: 2 }, { from: 'keep', index: 0 }])).toBeNull();
    expect(sigil.slots.map((r) => r.uid)).toEqual([c.uid, a.uid]);
    expect(p.gold).toBe(0);
    expect(runeStacks(p, 'fire').map((r) => r.count)).toEqual([1]);
    // Bag full: the refunds wait as pending with the character, never in the stash.
    fillBag(sim, p);
    expect(sim.inscribe(pid, sigil.uid, [])).toBeNull();
    expect(sigil.slots).toEqual([]);
    const pending = pendingItems(p);
    expect(pending).toContain(a.uid);
    expect(pending).toContain(c.uid);
    expect(p.stash.includes(a.uid) || p.stash.includes(c.uid)).toBe(false);
  });

  it('inscribe is all or nothing: not enough gold, a missing rune or too many runes leaves everything unchanged', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.forge);
    const sigil = createSigil(sim.newItemUid(), sim.rand.loot, 'common');
    const old = rolledRune(sim, 'orb');
    sigil.slots = [old];
    addItem(p, sigil);
    const r = rolledRune(sim, 'bolt');
    addItem(p, r);
    addItem(p, createRune(sim.newItemUid(), 'fire', 1));
    p.gold = forgeInsertPrice(r);
    const before = state(p);
    const refs: RuneRef[] = [{ from: 'rolled', uid: r.uid }, { from: 'plain', rune: 'fire' }];
    expect(sim.inscribe(pid, sigil.uid, refs)).toBe(`That costs ${forgeInsertPrice(r) + forgeInsertPrice(createRune(0, 'fire'))} gold`);
    expect(state(p)).toBe(before);
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'rolled', uid: r.uid }, { from: 'plain', rune: 'cold' }])).toBe('You need a Cold Rune');
    expect(state(p)).toBe(before);
    p.gold = 10_000;
    const tooMany: RuneRef[] = [{ from: 'plain', rune: 'fire' }, { from: 'plain', rune: 'fire' }, { from: 'plain', rune: 'fire' }, { from: 'plain', rune: 'fire' }];
    expect(sim.inscribe(pid, sigil.uid, tooMany)).toBe('Too many runes for this sigil');
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'keep', index: 3 }])).toBe('That slot is empty');
    p.gold = forgeInsertPrice(r);
    expect(state(p)).toBe(before);
  });

  it('inscribe charges each plain or rolled insert its forge price in gold', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.forge);
    const sigil = blankSigil(sim);
    addItem(p, sigil);
    const r = rolledRune(sim, 'orb');
    addItem(p, r);
    addItem(p, createRune(sim.newItemUid(), 'fire', 3));
    const price = forgeInsertPrice(r) + 2 * forgeInsertPrice(createRune(0, 'fire'));
    expect(forgeInsertPrice(r)).toBe(sellPrice(r));
    p.gold = price;
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'rolled', uid: r.uid }, { from: 'plain', rune: 'fire' }, { from: 'plain', rune: 'fire' }])).toBeNull();
    expect(p.gold).toBe(0);
    // Reordering and taking out are free.
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'keep', index: 2 }, { from: 'keep', index: 0 }])).toBeNull();
    expect(p.gold).toBe(0);
  });

  it('inscribe refuses a sigil in the stash and anywhere but the forge', () => {
    const { sim, pid, p, pos } = town();
    p.gold = 1000;
    addItem(p, createRune(sim.newItemUid(), 'fire', 2));
    const stashed = putInStash(p, blankSigil(sim));
    const carried = blankSigil(sim);
    addItem(p, carried);
    standAt(pos, sim.mapDef.forge);
    expect(sim.inscribe(pid, stashed.uid, [{ from: 'plain', rune: 'fire' }])).toBe('Take the sigil out of the stash first');
    pos.x += 1500;
    const before = state(p);
    expect(sim.inscribe(pid, carried.uid, [{ from: 'plain', rune: 'fire' }])).toBe('Sigils are inscribed at the forge in town');
    expect(state(p)).toBe(before);
  });

  it('the free bench inserts plain runes bound, costs nothing and refunds only unbound and rolled runes', () => {
    const sim = new Simulation(5);
    const pid = sim.addPlayer('b', 'mage');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('setup');
    const sigil = blankSigil(sim);
    const found = createRune(sim.newItemUid(), 'cold', 1);
    const rolledIn = rolledRune(sim, 'orb');
    rolledIn.bound = true;
    sigil.slots = [found, rolledIn];
    addItem(p, sigil);
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'plain', rune: 'fire' }, { from: 'plain', rune: 'bolt' }], true)).toBeNull();
    expect(sigil.slots.map((r) => [r.rune, r.bound])).toEqual([['fire', true], ['bolt', true]]);
    expect(p.gold).toBe(0);
    // The unbound Cold and the bound rolled Orb come back; bench-made runes do not.
    expect(runeStacks(p, 'cold').map((r) => r.count)).toEqual([1]);
    expect(p.items.get(rolledIn.uid)?.bound).toBe(true);
    expect(sim.inscribe(pid, sigil.uid, [], true)).toBeNull();
    expect(runeStacks(p, 'fire')).toEqual([]);
    expect(runeStacks(p, 'bolt')).toEqual([]);
  });

  it('a found rune put into a bound starter sigil comes back unbound', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.forge);
    p.gold = 1000;
    const eq = p.sigils[0];
    const starter = eq ? p.items.get(eq.uid) : undefined;
    if (starter?.kind !== 'sigil' || !starter.bound) throw new Error('no bound starter');
    addItem(p, createRune(sim.newItemUid(), 'cold', 1));
    // Starter sigils are full, so the cold rune takes the last slot's place.
    const keep: RuneRef[] = starter.slots.slice(0, -1).map((_, i) => ({ from: 'keep', index: i }));
    expect(sim.inscribe(pid, starter.uid, [...keep, { from: 'plain', rune: 'cold' }])).toBeNull();
    expect(starter.slots.at(-1)?.rune).toBe('cold');
    expect(sim.inscribe(pid, starter.uid, keep)).toBeNull();
    const cold = runeStacks(p, 'cold');
    expect(cold.map((r) => r.bound === true)).toEqual([false]);
  });

  it('a rune comes out of a sigil with the uid, rolls and binding it went in with', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.forge);
    p.gold = 1000;
    const sigil = blankSigil(sim);
    addItem(p, sigil);
    const r = rolledRune(sim, 'bolt');
    r.bound = true;
    addItem(p, r);
    const copy = JSON.stringify(r);
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'rolled', uid: r.uid }])).toBeNull();
    expect(holdsBoundRunes(sigil)).toBe(true);
    expect(sim.inscribe(pid, sigil.uid, [])).toBeNull();
    expect(JSON.stringify(p.items.get(r.uid))).toBe(copy);
  });

  it('inscribing past spirit for a persistent skill is refused and changes nothing', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.forge);
    p.gold = 1000;
    const sigil = blankSigil(sim);
    addItem(p, sigil);
    expect(sim.equipSigil(pid, sigil.uid, 3)).toBeNull();
    addItem(p, createRune(sim.newItemUid(), 'aura', 1));
    addItem(p, createRune(sim.newItemUid(), 'ward', 1));
    p.stats.spiritMax = 0;
    const before = state(p);
    const compiled = p.sigils[3];
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'plain', rune: 'aura' }, { from: 'plain', rune: 'ward' }])).toBe('Not enough spirit for that persistent skill');
    expect(state(p)).toBe(before);
    expect(p.sigils[3]).toBe(compiled);
    p.stats.spiritMax = 1000;
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'plain', rune: 'aura' }, { from: 'plain', rune: 'ward' }])).toBeNull();
    expect(p.sigils[3]?.compiled.ok && p.sigils[3].compiled.persistent).toBe(true);
  });


  it('a character with no gold can take a bound starter rune out and put it back', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.forge);
    p.gold = 0;
    const eq = p.sigils[0];
    const starter = eq ? p.items.get(eq.uid) : undefined;
    if (starter?.kind !== 'sigil') throw new Error('no starter sigil');
    const last = starter.slots.at(-1);
    if (!last?.bound) throw new Error('starter runes should be bound');
    const before = JSON.stringify(starter.slots.map((r) => [r.rune, r.affixes, r.bound]));
    const keep: RuneRef[] = starter.slots.slice(0, -1).map((_, i) => ({ from: 'keep', index: i }));
    expect(sim.inscribe(pid, starter.uid, keep)).toBeNull();
    const back: RuneRef = last.affixes.length > 0 ? { from: 'rolled', uid: last.uid } : { from: 'plain', rune: last.rune };
    expect(forgeInsertPrice(last)).toBe(0);
    expect(sim.inscribe(pid, starter.uid, [...keep, back])).toBeNull();
    expect(JSON.stringify(starter.slots.map((r) => [r.rune, r.affixes, r.bound]))).toBe(before);
    expect(p.gold).toBe(0);
  });

  it('prices rolled runes above plain ones and sigils by their runes', () => {
    const { sim } = town();
    const plain = createRune(sim.newItemUid(), 'orb', 1);
    const r = rolledRune(sim, 'orb');
    expect(sellPrice(r)).toBeGreaterThan(sellPrice(plain));
    const sigil = blankSigil(sim);
    const empty = sellPrice(sigil);
    sigil.slots = [r, plain];
    expect(sellPrice(sigil)).toBe(empty + sellPrice(r) + sellPrice(plain));
    expect(buyPrice(sigil)).toBe(sellPrice(sigil) * 3);
    r.bound = true;
    expect(sellPrice(r)).toBe(0);
  });

  it('rolled runes move between bag and stash, drop and pick up whole; bound ones stay off the stash', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.stash);
    const r = rolledRune(sim, 'nova');
    addItem(p, r);
    expect(moveItem(sim, pid, r.uid, 'stash', 3, 3)).toBeNull();
    expect(p.stash.includes(r.uid)).toBe(true);
    expect(moveItem(sim, pid, r.uid, 'bag', 5, 5)).toBeNull();
    const b = rolledRune(sim, 'nova');
    b.bound = true;
    addItem(p, b);
    expect(moveItem(sim, pid, b.uid, 'stash', 0, 0)).toBe('Bound items stay with this character');
    expect(discard(sim, pid, b.uid)).toBe('Bound items stay with this character');
    expect(discard(sim, pid, r.uid)).toBeNull();
    expect(p.items.has(r.uid)).toBe(false);
    const bagId = [...sim.world.loot.keys()].at(-1);
    if (bagId === undefined) throw new Error('no bag');
    fillBag(sim, p);
    expect(pickupLoot(sim, pid, bagId)).toBe('No room in your bag');
    expect(sim.world.loot.get(bagId)?.items.length).toBe(1);
  });

  it('sort keeps runes grouped by rune, rolled ahead of plain', () => {
    const { sim, pid, p } = town();
    addItem(p, createRune(sim.newItemUid(), 'orb', 3));
    addItem(p, rolledRune(sim, 'orb'));
    addItem(p, createRune(sim.newItemUid(), 'bolt', 3));
    expect(sim.sortInventory(pid)).toBeNull();
    const runes = placements(p.inventory, BAG).flatMap(({ uid }) => {
      const it = p.items.get(uid);
      return it?.kind === 'rune' ? [`${it.rune}:${it.affixes.length > 0 ? 'rolled' : 'plain'}`] : [];
    });
    expect(runes).toEqual(['orb:rolled', 'orb:plain', 'bolt:plain']);
  });

  it('a stashed sigil and its runes get fresh uids when the stash is loaded', () => {
    const { sim, pid } = town();
    const sigil = blankSigil(sim);
    sigil.slots = [rolledRune(sim, 'orb'), createRune(sim.newItemUid(), 'fire', 1)];
    const cells = emptyGrid(STASH);
    cells[0] = sigil.uid;
    restoreStash(sim, pid, { items: [sigil], cells, runeFormat: 2 });
    const p = sim.world.player.get(pid);
    const loaded = p ? [...p.items.values()].find((i) => i.kind === 'sigil' && p.stash.includes(i.uid)) : undefined;
    if (loaded?.kind !== 'sigil') throw new Error('not loaded');
    const old = [sigil.uid, ...sigil.slots.map((r) => r.uid)];
    for (const u of [loaded.uid, ...loaded.slots.map((r) => r.uid)]) expect(old).not.toContain(u);
  });

  it('rolled runes never stack, plain ones do', () => {
    const { sim, p } = town();
    const rolled = (): RuneItem => ({ ...createRune(sim.newItemUid(), 'orb', 1), affixes: [{ id: 'rune_damage', tier: 0, value: 20 }] });
    addItem(p, createRune(sim.newItemUid(), 'orb', 1));
    addItem(p, createRune(sim.newItemUid(), 'orb', 1));
    addItem(p, rolled());
    addItem(p, rolled());
    const cells = runeStacks(p, 'orb').map((r) => [r.count, r.affixes.length]).sort();
    expect(cells).toEqual([[1, 1], [1, 1], [2, 0]]);
  });

  it('a sigil bought from the shelf and its runes get fresh uids', () => {
    const { sim, pid, p, pos } = town();
    standAt(pos, sim.mapDef.trader);
    p.gold = 1000;
    const shelf = blankSigil(sim);
    shelf.slots = [createRune(sim.newItemUid(), 'bolt', 1), createRune(sim.newItemUid(), 'fire', 1)];
    const owned = new Set(p.items.keys());
    expect(buyItem(sim, pid, shelf, 10)).toBeNull();
    const bought = [...p.items.values()].find((i) => !owned.has(i.uid));
    if (bought?.kind !== 'sigil') throw new Error('not bought');
    const shelfUids = [shelf.uid, ...shelf.slots.map((r) => r.uid)];
    for (const uid of [bought.uid, ...bought.slots.map((r) => r.uid)]) expect(shelfUids).not.toContain(uid);
    expect(bought.slots.map((r) => r.rune)).toEqual(['bolt', 'fire']);
  });

  it('rooms can keep their item ids apart', () => {
    const sim = new Simulation(1);
    sim.startItemUidsAt(2 ** 32);
    expect(sim.newItemUid()).toBe(2 ** 32);
  });
});
