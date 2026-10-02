import { describe, expect, it } from 'vitest';
import { addItem, discard, spawnBag, spawnGold, takeLoot, updateLoot } from '../src/sim/inventory.js';
import { previewNames, serializeEntities, snapshotFor } from '../src/sim/snapshot.js';
import { createGear, createRune, LOOT, NET, Simulation, type EntityId, type Item, type ItemUid, type PlayerComp } from '../src/index.js';

function setup() {
  const sim = new Simulation(4, { kind: 'flat' });
  const pid = sim.addPlayer('a', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  if (!p || !pos) throw new Error('setup');
  return { sim, pid, p, pos };
}

function addPlayer(sim: Simulation, client: string, at: { x: number; y: number }) {
  const pid = sim.addPlayer(client, 'warrior');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  if (!p || !pos) throw new Error('setup');
  pos.x = at.x;
  pos.y = at.y;
  return { pid, p, pos };
}

function ring(sim: Simulation, tier: Item['tier'] = 'magic'): Item {
  return createGear(sim.newItemUid(), sim.rand.loot, tier, 1, { category: 'ring' });
}

function piles(sim: Simulation): EntityId[] {
  return [...sim.world.loot.keys()].filter((id) => sim.world.isAlive(id) && (sim.world.loot.get(id)?.items.length ?? 0) > 0);
}

function onlyPile(sim: Simulation): EntityId {
  const all = piles(sim);
  expect(all).toHaveLength(1);
  const id = all[0];
  if (id === undefined) throw new Error('no pile');
  return id;
}

/** Every item uid a player holds, anywhere: bag, stash, equipment, sigils, pending. */
function held(p: PlayerComp): Set<ItemUid> {
  return new Set(p.items.keys());
}

/** Fills every free bag cell with junk rings. */
function fillBag(sim: Simulation, p: PlayerComp): void {
  while (addItem(p, ring(sim, 'common')));
}

describe('loot piles', () => {
  it('merges drops inside the radius into one pile and keeps drops apart outside it', () => {
    const { sim, pos } = setup();
    const x = pos.x + 200;
    const y = pos.y;
    spawnBag(sim, x, y, [ring(sim)], LOOT.bagRadius, null);
    spawnBag(sim, x + LOOT.mergeRadius - 2, y, [ring(sim, 'rare'), ring(sim)], LOOT.bagRadius, null);
    const id = onlyPile(sim);
    expect(sim.world.loot.get(id)?.items).toHaveLength(3);
    expect(sim.world.position.get(id)).toEqual({ x, y });
    // Two monsters dying apart stay two piles.
    spawnBag(sim, x + 300, y, [ring(sim)], LOOT.bagRadius, null);
    expect(piles(sim)).toHaveLength(2);
  });

  it('keeps every drop apart with the radius at 0', () => {
    const { sim, pos } = setup();
    sim.rates.lootMerge = 0;
    for (let i = 0; i < 3; i++) spawnBag(sim, pos.x + 200, pos.y, [ring(sim)], LOOT.bagRadius, null);
    expect(piles(sim)).toHaveLength(3);
  });

  it('follows the live radius: a wider one merges what the default keeps apart', () => {
    const { sim, pos } = setup();
    spawnBag(sim, pos.x + 200, pos.y, [ring(sim)], LOOT.bagRadius, null);
    spawnBag(sim, pos.x + 280, pos.y, [ring(sim)], LOOT.bagRadius, null);
    expect(piles(sim)).toHaveLength(2);
    sim.rates.lootMerge = 100;
    spawnBag(sim, pos.x + 240, pos.y, [ring(sim)], LOOT.bagRadius, null);
    expect(piles(sim)).toHaveLength(2);
    expect(piles(sim).map((id) => sim.world.loot.get(id)?.items.length).sort()).toEqual([1, 2]);
  });

  it('starts a new pile once a pile is full', () => {
    const { sim, pos } = setup();
    spawnBag(sim, pos.x + 200, pos.y, Array.from({ length: LOOT.pileMaxItems }, () => ring(sim)), LOOT.bagRadius, null);
    spawnBag(sim, pos.x + 200, pos.y, [ring(sim)], LOOT.bagRadius, null);
    expect(piles(sim)).toHaveLength(2);
  });

  it('a join refreshes the pile clock; an untouched pile despawns with its items', () => {
    const { sim, pid, pos } = setup();
    spawnBag(sim, pos.x + 30, pos.y, [ring(sim)], LOOT.bagRadius, null);
    const id = onlyPile(sim);
    updateLoot(sim, LOOT.bagLifetimeSeconds - 1);
    spawnBag(sim, pos.x + 30, pos.y, [ring(sim)], LOOT.bagRadius, null);
    updateLoot(sim, 2);
    expect(sim.world.isAlive(id)).toBe(true);
    expect(sim.lootView(pid, id)?.items).toHaveLength(2);
    updateLoot(sim, LOOT.bagLifetimeSeconds);
    sim.world.flushDestroyed();
    expect(sim.world.loot.has(id)).toBe(false);
  });

  it('gold does not join an item pile and still goes on walk-over beside one', () => {
    const { sim, p, pos } = setup();
    spawnBag(sim, pos.x, pos.y, [ring(sim)], LOOT.bagRadius, null);
    const gold = p.gold;
    spawnGold(sim, pos.x, pos.y, 30);
    // It lands beside the pile, not in it; the hero walks onto it.
    const coins = [...sim.world.loot].find(([, l]) => l.gold > 0)?.[0];
    const at = coins === undefined ? undefined : sim.world.position.get(coins);
    if (!at) throw new Error('no gold pile');
    pos.x = at.x;
    pos.y = at.y;
    updateLoot(sim, 0);
    expect(p.gold).toBe(gold + 30);
    expect(sim.world.loot.get(onlyPile(sim))?.gold).toBe(0);
  });

  it('takes one item with a click, then the rest with Take all', () => {
    const { sim, pid, p, pos } = setup();
    const items = [ring(sim), ring(sim, 'rare'), ring(sim)];
    spawnBag(sim, pos.x + 30, pos.y, items, LOOT.bagRadius, null);
    const id = onlyPile(sim);
    const [a, b, c] = items;
    if (!a || !b || !c) throw new Error('setup');
    expect(takeLoot(sim, pid, id, b.uid)).toBeNull();
    expect(p.items.get(b.uid)).toBe(b);
    expect(sim.world.loot.get(id)?.items.map((i) => i.uid)).toEqual([a.uid, c.uid]);
    expect(takeLoot(sim, pid, id, null)).toBeNull();
    for (const it of items) expect(p.items.get(it.uid)).toBe(it);
    expect(sim.world.isAlive(id)).toBe(false);
  });

  it('refuses a pile out of reach', () => {
    const { sim, pid, pos } = setup();
    spawnBag(sim, pos.x + 400, pos.y, [ring(sim)], LOOT.bagRadius, null);
    const id = onlyPile(sim);
    expect(takeLoot(sim, pid, id, null)).toBe('Too far away');
    expect(sim.lootView(pid, id)).toBeNull();
  });

  it('two players taking the same item in the same tick: one gets it, the other is told', () => {
    const { sim, pid, p, pos } = setup();
    const other = addPlayer(sim, 'b', pos);
    const items = [ring(sim, 'relic'), ring(sim)];
    spawnBag(sim, pos.x + 30, pos.y, items, LOOT.bagRadius, null);
    const id = onlyPile(sim);
    const [relic, plain] = items;
    if (!relic || !plain) throw new Error('setup');
    // The room handles messages one at a time, so the same tick means one after the other.
    expect(takeLoot(sim, pid, id, relic.uid)).toBeNull();
    expect(takeLoot(sim, other.pid, id, relic.uid)).toBe('Someone else took it');
    expect(p.items.has(relic.uid)).toBe(true);
    expect(other.p.items.has(relic.uid)).toBe(false);
    // Both press Take all: the second finds nothing left.
    expect(takeLoot(sim, other.pid, id, null)).toBeNull();
    expect(takeLoot(sim, pid, id, null)).toBeNull();
    expect(other.p.items.has(plain.uid)).toBe(true);
    expect(p.items.has(plain.uid)).toBe(false);
    sim.world.flushDestroyed();
    expect(sim.world.loot.has(id)).toBe(false);
  });

  it('a pile emptied by someone else, or despawned, closes the window and refuses takes', () => {
    const { sim, pid, p, pos } = setup();
    const other = addPlayer(sim, 'b', pos);
    const items = [ring(sim), ring(sim)];
    spawnBag(sim, pos.x + 30, pos.y, items, LOOT.bagRadius, null);
    const id = onlyPile(sim);
    expect(sim.lootView(pid, id)?.items).toHaveLength(2);
    const before = held(p);
    expect(takeLoot(sim, other.pid, id, null)).toBeNull();
    expect(sim.lootView(pid, id)).toBeNull();
    const first = items[0];
    if (!first) throw new Error('setup');
    expect(takeLoot(sim, pid, id, first.uid)).toBe('Someone else took it');
    expect(held(p)).toEqual(before);

    spawnBag(sim, pos.x + 30, pos.y, [ring(sim)], LOOT.bagRadius, null);
    sim.world.flushDestroyed();
    const next = onlyPile(sim);
    expect(sim.lootView(pid, next)?.items).toHaveLength(1);
    updateLoot(sim, LOOT.bagLifetimeSeconds + 1);
    expect(sim.lootView(pid, next)).toBeNull();
    expect(takeLoot(sim, pid, next, null)).toBeNull();
    expect(held(p)).toEqual(before);
  });

  it('holds the dropper rule per item inside a shared pile', () => {
    const { sim, pid, p, pos } = setup();
    const monster = ring(sim, 'rare');
    spawnBag(sim, pos.x + 20, pos.y, [monster], LOOT.bagRadius, null);
    const mine = ring(sim);
    addItem(p, mine);
    expect(discard(sim, pid, mine.uid)).toBeNull();
    const id = onlyPile(sim);
    expect(sim.lootView(pid, id)?.own).toEqual([mine.uid]);
    expect(takeLoot(sim, pid, id, mine.uid)).toBe('Step away before taking back your own drop');
    // Take all takes the monster's drop and leaves the player's own.
    expect(takeLoot(sim, pid, id, null)).toBeNull();
    expect(p.items.has(monster.uid)).toBe(true);
    expect(sim.world.loot.get(id)?.items.map((i) => i.uid)).toEqual([mine.uid]);
    expect(takeLoot(sim, pid, id, null)).toBe('Step away before taking back your own drop');
    // Anyone else may take it at once.
    const other = addPlayer(sim, 'b', pos);
    expect(sim.lootView(other.pid, id)?.own).toEqual([]);
    // The dropper steps away and back: it is theirs to take again.
    const home = { x: pos.x, y: pos.y };
    pos.x += LOOT.dropStepAway + 10;
    updateLoot(sim, 0);
    pos.x = home.x;
    expect(sim.lootView(pid, id)?.own).toEqual([]);
    expect(takeLoot(sim, pid, id, mine.uid)).toBeNull();
    expect(p.items.get(mine.uid)).toBe(mine);
    expect(other.p.items.has(mine.uid)).toBe(false);
  });

  it('a full bag takes nothing and leaves the item on the ground untouched', () => {
    const { sim, pid, p, pos } = setup();
    fillBag(sim, p);
    const big = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 1, { category: 'body' });
    spawnBag(sim, pos.x + 30, pos.y, [big], LOOT.bagRadius, null);
    const id = onlyPile(sim);
    const rev = sim.world.loot.get(id)?.rev;
    const before = held(p);
    expect(takeLoot(sim, pid, id, big.uid)).toBe('No room in your bag');
    expect(takeLoot(sim, pid, id, null)).toBe('No room in your bag');
    expect(held(p)).toEqual(before);
    expect(sim.world.loot.get(id)?.items).toEqual([big]);
    expect(sim.world.loot.get(id)?.rev).toBe(rev);
  });

  it('takes part of a plain rune stack and leaves exactly the rest on the ground', () => {
    const { sim, pid, p, pos } = setup();
    const stack = createRune(sim.newItemUid(), 'fire', 15);
    addItem(p, stack);
    fillBag(sim, p);
    const ground = createRune(sim.newItemUid(), 'fire', 10);
    spawnBag(sim, pos.x + 30, pos.y, [ground], LOOT.bagRadius, null);
    const id = onlyPile(sim);
    const rev = sim.world.loot.get(id)?.rev ?? 0;
    expect(takeLoot(sim, pid, id, ground.uid)).toBe('No room in your bag');
    expect(stack.count).toBe(20);
    expect(ground.count).toBe(5);
    expect(p.items.has(ground.uid)).toBe(false);
    expect(sim.world.loot.get(id)?.items).toEqual([ground]);
    // The window shows the smaller stack.
    expect(sim.world.loot.get(id)?.rev).toBe(rev + 1);
  });

  it('sends a short preview of a big pile, best first, and full items only through the window', () => {
    const { sim, pid, pos } = setup();
    const items: Item[] = Array.from({ length: 30 }, () => ring(sim, 'common'));
    const relic = ring(sim, 'relic');
    items.push(relic, createRune(sim.newItemUid(), 'bolt', 7));
    spawnBag(sim, pos.x + 30, pos.y, items, LOOT.bagRadius, null);
    const id = onlyPile(sim);
    const snap = serializeEntities(sim).find((e) => e.id === id);
    if (snap?.k !== 'loot') throw new Error('no snap');
    expect(snap.count).toBe(32);
    expect(snap.names).toHaveLength(LOOT.pilePreviewNames);
    expect(snap.names[0]).toEqual({ n: relic.name, tier: 'relic' });
    const bolts = createRune(sim.newItemUid(), 'bolt', 7);
    expect(previewNames([bolts])).toEqual([{ n: bolts.name, tier: 'common', c: 7 }]);
    // The whole pile in a snapshot stays small: no item bodies, a few names.
    expect(JSON.stringify(snap).length).toBeLessThan(600);
    expect(sim.lootView(pid, id)?.items).toHaveLength(32);
  });

  it('a pile out of interest range is not in the snapshot', () => {
    const { sim, pid, pos } = setup();
    spawnBag(sim, pos.x + NET.interestRadius + 200, pos.y, [ring(sim)], LOOT.bagRadius, null);
    const id = onlyPile(sim);
    const snap = snapshotFor(sim, pid, serializeEntities(sim), [], NET.interestRadius);
    expect(snap.entities.some((e) => e.id === id)).toBe(false);
  });

  it('a save never holds a pile or its items', () => {
    const { sim, pid, p, pos } = setup();
    const mine = ring(sim);
    addItem(p, mine);
    expect(discard(sim, pid, mine.uid)).toBeNull();
    const ground = ring(sim, 'rare');
    spawnBag(sim, pos.x + 20, pos.y, [ground], LOOT.bagRadius, null);
    const id = onlyPile(sim);
    expect(sim.world.loot.get(id)?.items).toHaveLength(2);
    const save = sim.exportPlayer(pid);
    expect(save?.items.some((i) => i.uid === mine.uid || i.uid === ground.uid)).toBe(false);
    expect(Object.keys(save ?? {})).not.toContain('loot');
  });
});
