import { describe, expect, it } from 'vitest';
import { addItem, pickupLoot, spawnBag } from '../src/sim/inventory.js';
import {
  BAG,
  clampRuneRolls,
  createGear,
  createRolledRune,
  createRune,
  createSigil,
  forgeInsertPrice,
  parseClientMessage,
  pendingItems,
  restoreStash,
  Rng,
  RUNE_SORT_KEYS,
  RUNE_STACK,
  SIGIL_SORT_KEYS,
  Simulation,
  splitStash,
  STASH,
  STASH_COLORS,
  STASH_TABS,
  stashItemUids,
  stashTabPrice,
  type ClientMessage,
  type EntityId,
  type Item,
  type ItemUid,
  type PlayerComp,
  type RuneId,
  type RuneItem,
  type RuneRef,
} from '../src/index.js';

/**
 * Random sequences of stash operations mixed with inscribes, pickups and reloads (which is when
 * pending items are placed into the stash). The promises: items only move. The multiset of items
 * (by uid, affixes and binding) plus plain rune counts is unchanged, apart from what a pickup
 * brings in; gold changes only by a tab purchase or the forge's price; no uid is in two places; no
 * bound item is in the stash; no stack passes RUNE_STACK and no list its cap; and a refusal changes
 * nothing at all. Every message goes through the validator first, as on the server.
 */

const RUNES: readonly RuneId[] = ['bolt', 'fire', 'nova', 'orb', 'split', 'onhit', 'beam'];

/**
 * Uid-free identity of an item: what must survive a reload, where uids are reissued. A rune's rolls
 * are read as they would come out of a sigil: starter runes carry rolls past the loot table and are
 * clamped when they leave one (forgeConservation checks that part), which is not a loss here.
 */
function content(i: Item): string {
  const affixes = i.kind === 'rune' ? clampRuneRolls(i).affixes : i.affixes;
  return `${i.kind}|${i.name}|${i.tier}|${i.ilvl}|${i.bound === true}|${JSON.stringify(affixes)}`;
}

interface Tally {
  /** Non-plain items (and rolled runes wherever they are, sigil slots too) by uid. */
  byUid: Map<string, number>;
  /** The same without uids. */
  byContent: Map<string, number>;
  /** Plain runes by rune and binding: stacks anywhere and sigil slots. */
  plain: Map<string, number>;
}

function add(m: Map<string, number>, k: string, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

function tally(p: PlayerComp): Tally {
  const t: Tally = { byUid: new Map(), byContent: new Map(), plain: new Map() };
  const rune = (r: RuneItem, n: number): void => {
    if (r.bench === true) return;
    if (r.affixes.length === 0) add(t.plain, `${r.rune}|${r.bound === true}`, n);
    else {
      add(t.byUid, `${r.uid}|${content(r)}`);
      add(t.byContent, content(r));
    }
  };
  for (const it of p.items.values()) {
    if (it.kind === 'rune') rune(it, it.count);
    else {
      add(t.byUid, `${it.uid}|${content(it)}`);
      add(t.byContent, content(it));
    }
    if (it.kind === 'sigil') for (const r of it.slots) rune(r, 1);
  }
  return t;
}

function sorted(m: Map<string, number>): [string, number][] {
  return [...m].filter(([, n]) => n !== 0).sort(([a], [b]) => a.localeCompare(b));
}

function snapshot(p: PlayerComp): string {
  const items = [...p.items.values()].sort((a, b) => a.uid - b.uid);
  return JSON.stringify({ items, bag: p.inventory, stash: p.stash, gold: p.gold, sigils: p.sigils.map((s) => s?.uid ?? null) });
}

/** Plain throws rather than expect calls: this runs over every item on every step. */
function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

function checkInvariants(p: PlayerComp): void {
  const seen = new Set<ItemUid>();
  const see = (u: ItemUid, where: string): void => {
    must(!seen.has(u), `uid ${u} twice (${where})`);
    seen.add(u);
  };
  // Every placement: an item is in at most one grid, list or slot.
  for (const u of new Set(p.inventory)) if (u !== null) see(u, 'bag');
  for (const tab of p.stash.general) {
    must(tab.cells.length === STASH.w * STASH.h, `tab ${tab.id} has ${tab.cells.length} cells`);
    for (const u of new Set(tab.cells)) if (u !== null) see(u, `tab ${tab.id}`);
  }
  for (const u of p.stash.runes.list) see(u, 'rune list');
  for (const u of p.stash.sigils.list) see(u, 'sigil list');
  for (const s of p.sigils) if (s) see(s.uid, 'skill slot');
  for (const u of Object.values(p.gear)) if (u !== null) see(u, 'gear');
  for (const u of p.warband) if (u !== null) see(u, 'warband');
  for (const u of seen) must(p.items.has(u), `a place points at missing ${u}`);
  // Runes inside sigils have uids of their own, never shared with an item.
  for (const it of p.items.values()) {
    if (it.kind === 'rune') must(it.count > 0, `rune ${it.uid} has count ${it.count}`);
    if (it.kind === 'sigil') for (const r of it.slots) must(!p.items.has(r.uid) && !seen.has(r.uid), `sigil rune ${r.uid} is also an item`);
  }
  for (const u of stashItemUids(p.stash)) {
    const it = p.items.get(u);
    must(!(it?.bound === true || (it?.kind === 'sigil' && it.slots.some((r) => r.bound === true))), `bound item ${u} in the stash`);
  }
  for (const u of p.stash.runes.list) {
    const it = p.items.get(u);
    must(it?.kind === 'rune' && it.count >= 1 && it.count <= RUNE_STACK && (it.affixes.length === 0 || it.count === 1), `rune list holds ${u}, not a rune item`);
  }
  for (const u of p.stash.sigils.list) must(p.items.get(u)?.kind === 'sigil', `sigil list holds ${u}, not a sigil`);
  // No stack anywhere grows past what the bag allows.
  for (const it of p.items.values()) if (it.kind === 'rune') must(it.count <= RUNE_STACK, `stack ${it.uid} holds ${it.count}`);
  must(p.stash.runes.list.length <= STASH_TABS.runeCap, `${p.stash.runes.list.length} runes listed`);
  must(p.stash.sigils.list.length <= STASH_TABS.sigilCap, `${p.stash.sigils.list.length} sigils listed`);
  must(p.stash.general.length <= STASH_TABS.maxGeneral, `${p.stash.general.length} general tabs`);
  must(new Set(p.stash.general.map((t) => t.id)).size === p.stash.general.length, 'two general tabs share an id');
}

interface World {
  sim: Simulation;
  pid: EntityId;
  p: PlayerComp;
}

function town(seed: number): World {
  const sim = new Simulation(seed, { kind: 'world', seed: 3 });
  const pid = sim.addPlayer('c', 'mage');
  const p = sim.world.player.get(pid);
  if (!p) throw new Error('setup');
  return { sim, pid, p };
}

function randomItem(sim: Simulation, rng: Rng): Item {
  const roll = rng.next();
  const loot = sim.rand.loot;
  if (roll < 0.35) return createRune(sim.newItemUid(), RUNES[rng.int(0, RUNES.length - 1)] ?? 'bolt', rng.int(1, 20));
  if (roll < 0.55) return createRolledRune(sim.newItemUid(), loot, rng.next() < 0.5 ? 'magic' : 'rare', rng.int(1, 8), RUNES[rng.int(0, 4)] ?? 'bolt');
  if (roll < 0.7) return createSigil(sim.newItemUid(), loot, rng.next() < 0.5 ? 'common' : 'rare', { ilvl: rng.int(1, 9) });
  const item = createGear(sim.newItemUid(), loot, rng.next() < 0.5 ? 'common' : 'magic', rng.int(1, 6), { category: rng.next() < 0.5 ? 'ring' : 'body' });
  if (rng.next() < 0.15) item.bound = true;
  return item;
}

function setup(seed: number, nearCaps: boolean): World {
  const w = town(seed);
  const { sim, p } = w;
  const rng = new Rng(seed);
  for (let i = 0; i < 40; i++) addItem(p, randomItem(sim, rng));
  const bound = createRune(sim.newItemUid(), 'fire', 5);
  bound.bound = true;
  addItem(p, bound);
  const sigil = createSigil(sim.newItemUid(), sim.rand.loot, 'relic');
  addItem(p, sigil);
  if (nearCaps) {
    // A couple short of every cap, so the random runs reach them. Some listed stacks have room,
    // so a plain stack can still top them up once the list is full.
    for (let i = 0; i < STASH_TABS.runeCap - 2; i++) {
      const r = i % 3 === 0 ? createRune(sim.newItemUid(), RUNES[i % 5] ?? 'bolt', rng.int(1, 20)) : createRolledRune(sim.newItemUid(), sim.rand.loot, 'magic', 2, 'nova');
      p.items.set(r.uid, r);
      p.stash.runes.list.push(r.uid);
    }
    for (let i = 0; i < STASH_TABS.sigilCap - 2; i++) {
      const s = createSigil(sim.newItemUid(), sim.rand.loot, 'common');
      p.items.set(s.uid, s);
      p.stash.sigils.list.push(s.uid);
    }
  }
  p.gold = rng.int(0, 3000);
  return w;
}

/** Uids the character can name, plus now and then one it cannot. */
function someUid(rng: Rng, p: PlayerComp): ItemUid {
  const roll = rng.next();
  if (roll < 0.04) return rng.int(0, 10_000);
  // Mostly bag items: near the caps the lists hold hundreds of items and would crowd out the bag.
  const bag = [...new Set(p.inventory)].filter((u): u is ItemUid => u !== null);
  const all = roll < 0.6 && bag.length > 0 ? bag : [...p.items.keys()];
  return all[rng.int(0, Math.max(0, all.length - 1))] ?? 0;
}

function someTab(rng: Rng, p: PlayerComp): number {
  if (rng.next() < 0.05) return rng.int(1, 10);
  return p.stash.general[rng.int(0, p.stash.general.length - 1)]?.id ?? 1;
}

function randomStashMessage(rng: Rng, p: PlayerComp): unknown {
  const roll = rng.next();
  const cell = (w: number, h: number) => ({ x: rng.int(0, w - 1), y: rng.int(0, h - 1) });
  if (roll < 0.3) {
    const d = rng.next();
    const to = d < 0.3 ? { at: 'bag', ...cell(BAG.w, BAG.h) } : d < 0.65 ? { at: 'tab', tab: someTab(rng, p), ...cell(STASH.w, STASH.h) } : d < 0.85 ? { at: 'runes' } : { at: 'sigils' };
    return { t: 'moveItem', uid: someUid(rng, p), to };
  }
  if (roll < 0.55) return { t: 'quickMove', uid: someUid(rng, p), tab: rng.next() < 0.3 ? null : someTab(rng, p) };
  if (roll < 0.72) {
    // Mostly a stash stack (listed or in a tab), sometimes anything.
    const stacks = [...p.stash.runes.list, ...p.stash.general.flatMap((t) => t.cells)].filter((u): u is ItemUid => {
      const it = u === null ? undefined : p.items.get(u);
      return it?.kind === 'rune' && it.affixes.length === 0;
    });
    const uid = rng.next() < 0.8 && stacks.length > 0 ? (stacks[rng.int(0, stacks.length - 1)] ?? 0) : someUid(rng, p);
    const to = rng.next() < 0.5 ? null : rng.next() < 0.5 ? { at: 'bag', ...cell(BAG.w, BAG.h) } : { at: 'tab', tab: someTab(rng, p), ...cell(STASH.w, STASH.h) };
    return { t: 'takeRunes', uid, count: rng.int(1, 20), to };
  }
  if (roll < 0.82) {
    const which = rng.next();
    if (which < 0.4) return { t: 'sortStash', tab: someTab(rng, p), key: null, affix: null };
    if (which < 0.7) {
      const key = RUNE_SORT_KEYS[rng.int(0, RUNE_SORT_KEYS.length - 1)];
      return { t: 'sortStash', tab: 'runes', key, affix: key === 'affix' ? 'rune_damage' : null };
    }
    return { t: 'sortStash', tab: 'sigils', key: SIGIL_SORT_KEYS[rng.int(0, SIGIL_SORT_KEYS.length - 1)], affix: null };
  }
  if (roll < 0.9) return { t: 'buyStashTab' };
  return { t: 'editStashTab', tab: someTab(rng, p), name: rng.next() < 0.8 ? `Tab ${rng.int(1, 99)}` : '<bad>', color: STASH_COLORS[rng.int(0, STASH_COLORS.length - 1)]?.id ?? 'ash' };
}

function apply(sim: Simulation, pid: EntityId, msg: ClientMessage): string | null | 'skip' {
  switch (msg.t) {
    case 'moveItem':
      return sim.moveItem(pid, msg.uid, msg.to);
    case 'quickMove':
      return sim.quickMove(pid, msg.uid, msg.tab);
    case 'takeRunes':
      return sim.takeRunes(pid, msg.uid, msg.count, msg.to);
    case 'sortStash':
      return sim.sortStash(pid, msg.tab, msg.key, msg.affix);
    case 'buyStashTab':
      return sim.buyStashTab(pid);
    case 'editStashTab':
      return sim.editStashTab(pid, msg.tab, msg.name, msg.color);
    default:
      return 'skip';
  }
}

function randomRefs(rng: Rng, p: PlayerComp, sigil: Item | undefined): RuneRef[] {
  const slots = sigil?.kind === 'sigil' ? sigil.slots : [];
  const n = rng.int(0, 6);
  const refs: RuneRef[] = [];
  const rolled = [...p.items.values()].filter((i) => i.kind === 'rune' && i.affixes.length > 0).map((i) => i.uid);
  const keptIdx = new Set<number>();
  const usedRolled = new Set<ItemUid>();
  for (let i = 0; i < n; i++) {
    const roll = rng.next();
    if (roll < 0.3 && slots.length > 0) {
      const index = rng.int(0, slots.length - 1);
      if (!keptIdx.has(index)) {
        keptIdx.add(index);
        refs.push({ from: 'keep', index });
      }
    } else if (roll < 0.75) refs.push({ from: 'plain', rune: RUNES[rng.int(0, 5)] ?? 'fire' });
    else {
      const uid = rolled[rng.int(0, Math.max(0, rolled.length - 1))];
      if (uid !== undefined && !usedRolled.has(uid)) {
        usedRolled.add(uid);
        refs.push({ from: 'rolled', uid });
      }
    }
  }
  return refs;
}

/** Leave and come back: the stash is split off, stored and loaded into a new room, and pending items are placed. */
function reload(w: World, seed: number): World {
  const save = w.sim.exportPlayer(w.pid);
  if (!save) throw new Error('no save');
  const { character, stash } = splitStash(JSON.parse(JSON.stringify(save)));
  const sim = new Simulation(seed, { kind: 'world', seed: 3 });
  const pid = sim.addPlayer('c', 'mage', 'Back', JSON.parse(JSON.stringify(character)));
  restoreStash(sim, pid, JSON.parse(JSON.stringify(stash)));
  const p = sim.world.player.get(pid);
  if (!p) throw new Error('no player');
  return { sim, pid, p };
}

function run(seed: number, nearCaps: boolean, steps: number): { ok: number; refused: number; reloads: number; pickups: number; inscribes: number; bought: number; capped: number } {
  let w = setup(seed, nearCaps);
  const rng = new Rng(seed * 104_729 + 7);
  const stats = { ok: 0, refused: 0, reloads: 0, pickups: 0, inscribes: 0, bought: 0, capped: 0 };
  checkInvariants(w.p);
  for (let step = 0; step < steps; step++) {
    const { sim, pid, p } = w;
    const pos = sim.world.position.get(pid);
    const stashAt = sim.mapDef.stash;
    const forgeAt = sim.mapDef.forge;
    if (!pos || !stashAt || !forgeAt) throw new Error('town lost its stations');
    const before = tally(p);
    const snap = snapshot(p);
    const gold = p.gold;
    const kind = rng.next();

    if (kind < 0.03) {
      w = reload(w, seed * 31 + step);
      stats.reloads++;
      const after = tally(w.p);
      expect(sorted(after.byContent)).toEqual(sorted(before.byContent));
      expect(sorted(after.plain)).toEqual(sorted(before.plain));
      expect(w.p.gold).toBe(gold);
      checkInvariants(w.p);
      continue;
    }

    if (kind < 0.1) {
      // A pickup brings items in: the tally grows by exactly what left the ground.
      pos.x = stashAt.x + 60;
      pos.y = stashAt.y;
      const items = Array.from({ length: rng.int(1, 3) }, () => randomItem(sim, rng)).filter((i) => i.bound !== true);
      const ground = tally({ ...p, items: new Map(items.map((i) => [i.uid, i])), stash: p.stash });
      // An empty drop lays no pile.
      if (items.length === 0) continue;
      spawnBag(sim, pos.x, pos.y, items, 14, null);
      const loot = [...sim.world.loot.keys()].at(-1);
      if (loot === undefined) throw new Error('no bag');
      pickupLoot(sim, pid, loot);
      const left = sim.world.loot.get(loot);
      const leftTally = tally({ ...p, items: new Map((left?.items ?? []).map((i) => [i.uid, i])), stash: p.stash });
      if (left) sim.world.destroy(loot);
      sim.world.flushDestroyed();
      const after = tally(p);
      const expected = new Map(before.plain);
      for (const [k, n] of ground.plain) add(expected, k, n);
      for (const [k, n] of leftTally.plain) add(expected, k, -n);
      expect(sorted(after.plain)).toEqual(sorted(expected));
      const expUid = new Map(before.byUid);
      for (const [k, n] of ground.byUid) add(expUid, k, n);
      for (const [k, n] of leftTally.byUid) add(expUid, k, -n);
      expect(sorted(after.byUid)).toEqual(sorted(expUid));
      expect(p.gold).toBe(gold);
      stats.pickups++;
      checkInvariants(p);
      continue;
    }

    if (kind < 0.3) {
      pos.x = forgeAt.x + 50;
      pos.y = forgeAt.y;
      const sigils = [...p.items.values()].filter((i) => i.kind === 'sigil').map((i) => i.uid);
      const uid = sigils[rng.int(0, Math.max(0, sigils.length - 1))] ?? 0;
      const sigil = p.items.get(uid);
      const refs = randomRefs(rng, p, sigil);
      const base = sigil?.kind === 'sigil' ? sigil.slots.map((r) => r.uid) : [];
      const msg = parseClientMessage({ t: 'inscribe', uid, base, slots: refs, attempt: step });
      if (msg?.t !== 'inscribe') throw new Error('refs the validator refuses');
      const oldSlots = new Set(base);
      const error = sim.inscribe(pid, msg.uid, msg.slots, false, msg.base);
      if (error !== null) {
        stats.refused++;
        expect(snapshot(p), error).toBe(snap);
      } else {
        stats.inscribes++;
        const after = tally(p);
        expect(sorted(after.plain)).toEqual(sorted(before.plain));
        expect(sorted(after.byUid)).toEqual(sorted(before.byUid));
        const fresh = sigil?.kind === 'sigil' ? sigil.slots.filter((r) => !oldSlots.has(r.uid)) : [];
        const unchanged = refs.length === base.length && refs.every((r, i) => r.from === 'keep' && r.index === i);
        expect(p.gold).toBe(unchanged ? gold : gold - fresh.reduce((n, r) => n + forgeInsertPrice(r), 0));
      }
      checkInvariants(p);
      continue;
    }

    // A stash operation, now and then from too far away.
    const far = rng.next() < 0.04;
    pos.x = stashAt.x + (far ? 3000 : 60);
    pos.y = stashAt.y;
    const raw = randomStashMessage(rng, p);
    const msg = parseClientMessage(raw);
    if (!msg) {
      stats.refused++;
      continue;
    }
    // Moving within the bag needs no chest; everything else here touches the stash.
    const bagOnly = msg.t === 'moveItem' && msg.to.at === 'bag' && p.inventory.includes(msg.uid);
    const price = stashTabPrice(p.stash.general.length);
    const tabs = p.stash.general.length;
    const error = apply(sim, pid, msg);
    if (error === 'skip') throw new Error(`unexpected message ${msg.t}`);
    if (error !== null) {
      stats.refused++;
      if (/ holds \d+/.test(error)) stats.capped++;
      expect(snapshot(p), `${msg.t}: ${error}`).toBe(snap);
    } else {
      stats.ok++;
      if (far && !bagOnly) throw new Error(`${msg.t} went through away from the chest`);
      const after = tally(p);
      expect(sorted(after.plain), msg.t).toEqual(sorted(before.plain));
      expect(sorted(after.byUid), msg.t).toEqual(sorted(before.byUid));
      if (msg.t === 'buyStashTab') {
        stats.bought++;
        expect(price).not.toBeNull();
        expect(p.gold).toBe(gold - (price ?? 0));
        expect(p.stash.general.length).toBe(tabs + 1);
      } else expect(p.gold).toBe(gold);
    }
    checkInvariants(p);
  }
  // What waits as pending is still owned, and counted above; it must be only what found no room.
  expect(pendingItems(w.p).every((u) => w.p.items.has(u))).toBe(true);
  return stats;
}

describe('stash conservation', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}: items only move, gold pays for tabs and the forge, refusals change nothing`, () => {
      const s = run(seed, false, 600);
      expect(s.ok).toBeGreaterThan(100);
      expect(s.refused).toBeGreaterThan(30);
      expect(s.inscribes).toBeGreaterThan(5);
      expect(s.pickups).toBeGreaterThan(10);
      expect(s.reloads).toBeGreaterThan(5);
    }, 30_000);
  }

  for (const seed of [11, 12, 13]) {
    it(`seed ${seed}: near every cap, no slot or list goes past it`, () => {
      const s = run(seed, true, 300);
      expect(s.ok).toBeGreaterThan(50);
      expect(s.capped).toBeGreaterThan(0);
    }, 30_000);
  }

  it('buys tabs in the random runs', () => {
    let bought = 0;
    for (const seed of [21, 22]) bought += run(seed, false, 400).bought;
    expect(bought).toBeGreaterThan(0);
  }, 30_000);
});
