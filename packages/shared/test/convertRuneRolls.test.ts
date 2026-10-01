import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  BAG,
  clampRuneRolls,
  compileSigilItem,
  convertRuneRolls,
  createGear,
  createRolledRune,
  createRune,
  createSigil,
  createStarterSigil,
  createVessel,
  emptyGrid,
  holdsStarterRecipe,
  isAffixId,
  isItemShape,
  matchingStarter,
  OLD_STARTER_RUNES,
  oldStarterRunes,
  placeReturned,
  Rng,
  sellPrice,
  starterSigilById,
  STARTER_SIGILS,
  toRuneInstance,
  type Item,
  type ItemUid,
  type RuneItem,
  type SigilItem,
  type StarterSigilDef,
} from '../src/index.js';

function def(id: string): StarterSigilDef {
  const d = starterSigilById(id);
  if (!d) throw new Error(`no starter ${id}`);
  return d;
}

/** Starter rolls as saves hold them from before 2026-10-01: tier 0 whatever the value. */
function tierZero(s: SigilItem): SigilItem {
  return { ...s, slots: s.slots.map((r) => ({ ...r, affixes: r.affixes.map((a) => ({ ...a, tier: 0 })) })) };
}

/** A sigil of a buffed starter as it was made before 2026-10-01. */
function oldStarter(id: string, newUid: () => ItemUid, bound: boolean): SigilItem {
  const runes = oldStarterRunes(id);
  if (!runes) throw new Error(`no old recipe for ${id}`);
  return tierZero(createStarterSigil(newUid, { ...def(id), runes }, { bound }));
}

/** An item as JSON.parse gives it, so a save can carry an affix id the game no longer knows. */
function fromJson(v: unknown): Item {
  const parsed: unknown = JSON.parse(JSON.stringify(v));
  if (!isItemShape(parsed)) throw new Error('not an item');
  return parsed;
}

function withRetiredAffix(sigil: SigilItem, name?: string): Item {
  return fromJson({ ...sigil, ...(name ? { name } : {}), affixes: [...sigil.affixes, { id: 'first_rune_free', tier: 2, value: 1 }] });
}

/** Every uid with how often it appears, runes inside sigils included. */
function uidCounts(items: readonly Item[]): Map<ItemUid, number> {
  const m = new Map<ItemUid, number>();
  const add = (u: ItemUid): void => {
    m.set(u, (m.get(u) ?? 0) + 1);
  };
  for (const it of items) {
    add(it.uid);
    if (it.kind === 'sigil') for (const r of it.slots) add(r.uid);
  }
  return m;
}

const recipe = (s: SigilItem): string => JSON.stringify(s.slots.map(toRuneInstance));
const newRecipe = (id: string): string => recipe(createStarterSigil(() => 0, def(id), { bound: false }));

/** A bag, equipment, pending items, a stash and a shelf's worth of items, with a uid for each. */
function mixedItems(): Item[] {
  let uid = 100;
  const next = (): ItemUid => uid++;
  const rng = new Rng(7);
  // An unbound old Multishot whose last Split is the player's own find (a T2 split(3)).
  const found = oldStarter('multishot', next, false);
  const own: RuneItem = { ...createRune(next(), 'split'), tier: 'rare', name: 'Split Rune', ilvl: 6, affixes: [{ id: 'split_count', tier: 1, value: 3 }] };
  return [
    oldStarter('multishot', next, true),
    oldStarter('flame_cleave', next, true),
    oldStarter('multishot', next, false),
    { ...oldStarter('flame_cleave', next, false), tier: 'rare', name: 'Grim Brand', affixes: [{ id: 'damage_increased', tier: 2, value: 40 }] },
    { ...found, slots: [...found.slots.slice(0, 2), own] },
    withRetiredAffix(createSigil(next(), rng, 'rare', { ilvl: 10 })),
    withRetiredAffix({ ...oldStarter('multishot', next, false), tier: 'rare' }),
    tierZero(createStarterSigil(next, def('fireball'), { bound: true })),
    createStarterSigil(next, def('multishot'), { bound: true }),
    createRune(next(), 'split', 7),
    createRolledRune(next(), rng, 'rare', 8),
    createGear(next(), rng, 'magic', 5),
    createVessel(next(), rng, 'rare'),
  ];
}

describe('"first rune is free" is gone', () => {
  it('is no affix the game knows, so no drop can roll it', () => {
    expect(isAffixId('first_rune_free')).toBe(false);
    expect(Object.keys(AFFIXES)).not.toContain('first_rune_free');
    const rng = new Rng(11);
    for (let i = 0; i < 2000; i++) {
      const s = createSigil(i, rng, i % 2 === 0 ? 'rare' : 'relic', { ilvl: 20 });
      const ids: string[] = s.affixes.map((a) => a.id);
      expect(ids).not.toContain('first_rune_free');
    }
  });

  it('is removed from a sigil, which keeps its uid, slots and every other affix', () => {
    const rare = createSigil(5, new Rng(3), 'rare', { ilvl: 10 });
    const { items, report } = convertRuneRolls([withRetiredAffix(rare)]);
    expect(items).toEqual([rare]);
    expect(report.affixesRemoved).toEqual([5]);
    expect(report.renamed).toEqual([]);
  });

  it('takes its word out of a name built from affixes', () => {
    const magic: SigilItem = { uid: 9, kind: 'sigil', tier: 'magic', name: 'x', ilvl: 6, affixes: [{ id: 'cast_delay', tier: 1, value: 12 }], slots: [], corrupted: false };
    const { items, report } = convertRuneRolls([withRetiredAffix(magic, 'Primed Magic Sigil'), withRetiredAffix({ ...magic, uid: 10, corrupted: true }, 'Corrupted Primed Magic Sigil'), withRetiredAffix({ ...magic, uid: 11, tier: 'rare' }, 'Primed Grim Mark')]);
    expect(items.map((i) => i.name)).toEqual(['Quick Magic Sigil', 'Corrupted Quick Magic Sigil', 'Grim Mark']);
    expect(report.renamed).toHaveLength(3);
  });
});

describe('the buffed starters on load', () => {
  it('rebuild a sigil holding the old recipe: first runes keep uid and binding, an unbound extra comes back', () => {
    for (const id of Object.keys(OLD_STARTER_RUNES)) {
      for (const bound of [true, false]) {
        let uid = 1;
        const old = oldStarter(id, () => uid++, bound);
        const { items, returned, report } = convertRuneRolls([old]);
        const [after] = items;
        if (after?.kind !== 'sigil') throw new Error('not a sigil');
        const d = def(id);
        expect(recipe(after), id).toBe(newRecipe(id));
        expect(holdsStarterRecipe(after)).toBe(true);
        expect(after.uid).toBe(old.uid);
        expect(after.slots.map((r) => r.uid)).toEqual(old.slots.slice(0, d.runes.length).map((r) => r.uid));
        expect(after.slots.every((r) => (r.bound === true) === bound)).toBe(true);
        expect(matchingStarter(after)?.id).toBe(id);
        expect(compileSigilItem(after, d.classId).ok).toBe(true);
        const out = old.slots.slice(d.runes.length);
        expect(returned.map((r) => r.uid)).toEqual(bound ? [] : out.map((r) => r.uid));
        expect(report.startersRebuilt).toEqual([{ sigil: old.uid, starter: id, runesRemoved: bound ? out.map((r) => r.uid) : [], runesReturned: bound ? [] : out.map((r) => r.uid) }]);
      }
    }
  });

  it('gives the new rolls their honest tier, so split(5) prices as the tier 3 roll it is', () => {
    let uid = 1;
    const [after] = convertRuneRolls([oldStarter('multishot', () => uid++, false)]).items;
    if (after?.kind !== 'sigil') throw new Error('not a sigil');
    expect(after.slots[1]?.affixes).toEqual([{ id: 'split_count', tier: 2, value: 5 }]);
    const fresh = createStarterSigil(() => uid++, def('multishot'), { bound: false });
    expect(fresh.slots[1]?.affixes).toEqual([{ id: 'split_count', tier: 2, value: 5 }]);
    expect(sellPrice(after)).toBe(sellPrice(fresh));
  });

  it('keep a rune the new recipe holds unchanged as the same item (Flame Cleave keeps its Fire)', () => {
    let uid = 1;
    const old = oldStarter('flame_cleave', () => uid++, true);
    const [after] = convertRuneRolls([old]).items;
    if (after?.kind !== 'sigil') throw new Error('not a sigil');
    expect(after.slots[1]).toBe(old.slots[1]);
  });

  it('leave a sigil alone once the player changed it at the forge', () => {
    let uid = 1;
    const next = (): ItemUid => uid++;
    const base = (): SigilItem => oldStarter('multishot', next, false);
    const variants: SigilItem[] = [];
    // A roll changed, the runes reordered, a rune added or taken out, a bench rune, another starter's id.
    const rolled = base();
    variants.push({ ...rolled, slots: rolled.slots.map((r, i) => (i === 0 ? { ...r, affixes: r.affixes.map((a) => (a.id === 'rune_damage' ? { ...a, value: 55 } : a)) } : r)) });
    const reordered = base();
    variants.push({ ...reordered, slots: [reordered.slots[1], reordered.slots[0], reordered.slots[2]].filter((r) => r !== undefined) });
    const added = base();
    variants.push({ ...added, slots: [...added.slots, createRune(next(), 'fire')] });
    const shorter = base();
    variants.push({ ...shorter, slots: shorter.slots.slice(0, 2) });
    const bench = base();
    variants.push({ ...bench, slots: bench.slots.map((r, i) => (i === 2 ? { ...r, bench: true } : r)) });
    variants.push({ ...base(), starter: 'smite' });
    const { starter: _gone, ...noStarter } = base();
    variants.push(noStarter);
    for (const v of variants) {
      const { items, returned, report } = convertRuneRolls([v]);
      expect(report.startersRebuilt).toEqual([]);
      expect(returned).toEqual([]);
      const [after] = items;
      if (after?.kind !== 'sigil') throw new Error('not a sigil');
      // Only tiers may move; the runes and their values stay.
      expect(recipe(after)).toBe(recipe(v));
      expect(after.slots.map((r) => r.uid)).toEqual(v.slots.map((r) => r.uid));
    }
  });

  it('leave new starters alone, and only re-tier old starter rolls', () => {
    let uid = 1;
    const fresh = STARTER_SIGILS.map((d) => createStarterSigil(() => uid++, d, { bound: true }));
    const once = convertRuneRolls(fresh);
    expect(once.items.every((it, i) => it === fresh[i])).toBe(true);
    expect(once.report).toEqual({ affixesRemoved: [], renamed: [], startersRebuilt: [], runesRetiered: [] });
    const saved = fresh.map(tierZero);
    const { items } = convertRuneRolls(saved);
    expect(JSON.parse(JSON.stringify(items))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });

  it('put returned runes in the bag when they fit and leave them pending when not', () => {
    const runes = [createRune(1, 'split'), createRune(2, 'split')];
    const bag = emptyGrid(BAG);
    bag.fill(99, 0, bag.length - 1);
    const placed = placeReturned(bag, runes);
    expect(placed.filter((u) => u === 1)).toHaveLength(1);
    expect(placed.includes(2)).toBe(false);
  });
});

describe('affix ids the game no longer has', () => {
  it('are left as they are on runes, loose or in a sigil, and nothing throws', () => {
    const rune = fromJson({ ...createRune(1, 'bolt'), tier: 'magic', affixes: [{ id: 'retired_someday', tier: 2, value: 400 }, { id: 'rune_damage', tier: 0, value: 300 }] });
    if (rune.kind !== 'rune') throw new Error('setup');
    const sigil = fromJson({ ...createSigil(2, new Rng(1), 'magic'), slots: [{ ...rune, uid: 3 }] });
    const { items, report } = convertRuneRolls([rune, sigil]);
    const [loose, held] = items;
    if (loose?.kind !== 'rune' || held?.kind !== 'sigil') throw new Error('kind changed');
    expect(loose.affixes[0]).toEqual({ id: 'retired_someday', tier: 2, value: 400 });
    // The known roll beside it still moves to its honest tier.
    expect(loose.affixes[1]).toEqual({ id: 'rune_damage', tier: 2, value: 300 });
    expect(held.slots[0]?.affixes[0]).toEqual({ id: 'retired_someday', tier: 2, value: 400 });
    expect(report.runesRetiered).toEqual([1, 3]);
    expect(clampRuneRolls(loose).affixes[0]).toEqual({ id: 'retired_someday', tier: 2, value: 400 });
    expect(() => compileSigilItem(held, 'mage')).not.toThrow();
  });
});

describe('conservation', () => {
  it('keeps every uid once, except bound runes the shorter recipes have no room for', () => {
    const before = mixedItems();
    const { items: after, returned, report } = convertRuneRolls(before);
    const removed = new Set(report.startersRebuilt.flatMap((r) => r.runesRemoved));
    const back = report.startersRebuilt.flatMap((r) => r.runesReturned);
    // 4 old Multishots and 2 old Flame Cleaves; the 2 bound ones lose a rune, the 4 unbound hand one back.
    expect(report.startersRebuilt).toHaveLength(6);
    expect(removed.size).toBe(2);
    expect(back).toHaveLength(4);
    expect(returned.map((r) => r.uid)).toEqual(back);
    expect(returned.every((r) => r.bound !== true && r.count === 1)).toBe(true);
    expect(report.affixesRemoved).toHaveLength(2);
    const want = uidCounts(before);
    for (const u of removed) want.delete(u);
    const got = uidCounts([...after, ...returned]);
    expect(got).toEqual(want);
    expect([...got.values()].every((n) => n === 1)).toBe(true);
    // The player's own T2 split(3) comes back exactly as it was.
    const own = before[4];
    if (own?.kind !== 'sigil') throw new Error('setup');
    expect(returned).toContainEqual(own.slots[2]);
    // Same items in the same order; only sigils' names, affixes and slots and runes' tiers change.
    expect(after.map((i) => i.uid)).toEqual(before.map((i) => i.uid));
    before.forEach((b, i) => {
      const a = after[i];
      if (!a) throw new Error('item lost');
      if (b.kind === 'rune' && a.kind === 'rune') {
        expect(toRuneInstance(a)).toEqual(toRuneInstance(b));
        expect({ ...a, affixes: [] }).toEqual({ ...b, affixes: [] });
        return;
      }
      if (b.kind !== 'sigil' || a.kind !== 'sigil') {
        expect(a).toBe(b);
        return;
      }
      const { affixes: _a1, slots: _s1, name: _n1, ...restA } = a;
      const { affixes: _a2, slots: _s2, name: _n2, ...restB } = b;
      expect(restA).toEqual(restB);
      const kept = b.affixes.map((x): string => x.id).filter((x) => x !== 'first_rune_free');
      expect(a.affixes.map((x) => x.id)).toEqual(kept);
      const rebuilt = report.startersRebuilt.find((r) => r.sigil === b.uid);
      if (rebuilt) expect(recipe(a)).toBe(newRecipe(rebuilt.starter));
      else expect(recipe(a)).toBe(recipe(b));
    });
  });

  it('changes nothing the second time', () => {
    const once = convertRuneRolls(mixedItems());
    const twice = convertRuneRolls([...once.items, ...once.returned]);
    expect(twice.report).toEqual({ affixesRemoved: [], renamed: [], startersRebuilt: [], runesRetiered: [] });
    expect(twice.returned).toEqual([]);
    expect(twice.items.every((it, i) => it === [...once.items, ...once.returned][i])).toBe(true);
  });
});
