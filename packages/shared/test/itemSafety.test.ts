import { describe, expect, it } from 'vitest';
import { applyDev } from '../src/sim/dev.js';
import { dealDamage } from '../src/sim/combat.js';
import { spawnEnemy } from '../src/sim/enemies.js';
import { addItem, discard, moveItem, pickupLoot, spawnBag } from '../src/sim/inventory.js';
import { buyItem, createGear, createRune, createSigil, sellItem, sellPrice, Simulation, type Item, type RuneItem } from '../src/index.js';

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

  // The forge is rebuilt around rune items (agent D); these cover what the v1 forge tests did.
  it.todo('inscribe takes plain runes from the bag first, bound stacks first, then the account stash');
  it.todo('inscribe takes a rolled rune from the bag or the stash, each uid at most once');
  it.todo('inscribe with keep refs moves slots for free, and refunds every slot not kept to the bag, else pending, never the stash');
  it.todo('inscribe is all or nothing: not enough gold, a missing rune or no room leaves everything unchanged');
  it.todo('inscribe charges each plain or rolled insert its forge price in gold');
  it.todo('inscribe refuses a sigil in the stash and anywhere but the forge');
  it.todo('the free bench inserts plain runes bound, costs nothing and refunds only unbound runes');
  it.todo('a found rune put into a bound starter sigil comes back unbound');
  it.todo('a rune comes out of a sigil with the uid, rolls and binding it went in with');
  it.todo('inscribing past spirit for a persistent skill is refused and changes nothing');
  // v1 saves are converted before they are read (agent E).
  it.todo('an old Test Sigil in a v1 save is taken apart on conversion, its runes kept bound');

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
