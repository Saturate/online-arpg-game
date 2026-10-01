import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  compileSigilItem,
  convertRuneRolls,
  createGear,
  createRolledRune,
  createRune,
  createSigil,
  createStarterSigil,
  createVessel,
  isAffixId,
  isItemShape,
  matchingStarter,
  OLD_STARTER_RUNES,
  oldStarterRunes,
  Rng,
  starterSigilById,
  STARTER_SIGILS,
  toRuneInstance,
  type Item,
  type ItemUid,
  type SigilItem,
  type StarterSigilDef,
} from '../src/index.js';

function def(id: string): StarterSigilDef {
  const d = starterSigilById(id);
  if (!d) throw new Error(`no starter ${id}`);
  return d;
}

/** A sigil of a buffed starter as it was made before 2026-10-01. */
function oldStarter(id: string, newUid: () => ItemUid, bound: boolean): SigilItem {
  const runes = oldStarterRunes(id);
  if (!runes) throw new Error(`no old recipe for ${id}`);
  return createStarterSigil(newUid, { ...def(id), runes }, { bound });
}

/** An item as JSON.parse gives it, so a save can carry an affix id the game no longer knows. */
function fromJson(v: unknown): Item {
  const parsed: unknown = JSON.parse(JSON.stringify(v));
  if (!isItemShape(parsed)) throw new Error('not an item');
  return parsed;
}

function withRetiredAffix(sigil: SigilItem): Item {
  return fromJson({ ...sigil, affixes: [...sigil.affixes, { id: 'first_rune_free', tier: 3, value: 1 }] });
}

/** Every uid, runes inside sigils included, with how often it appears. */
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
const recipeOf = (runes: StarterSigilDef['runes']): string => recipe(createStarterSigil(() => 0, { ...def('smite'), runes }, { bound: false }));

/** A bag, equipment, pending items, a stash and a shelf's worth of items, with a uid for each. */
function mixedItems(): { items: Item[]; next: () => ItemUid } {
  let uid = 100;
  const next = (): ItemUid => uid++;
  const rng = new Rng(7);
  const rare = createSigil(next(), rng, 'rare', { ilvl: 10 });
  const items: Item[] = [
    oldStarter('multishot', next, true),
    oldStarter('flame_cleave', next, true),
    oldStarter('multishot', next, false),
    { ...oldStarter('flame_cleave', next, false), tier: 'rare', name: 'Grim Brand', affixes: [{ id: 'damage_increased', tier: 3, value: 40 }] },
    withRetiredAffix(rare),
    withRetiredAffix({ ...oldStarter('multishot', next, false), tier: 'rare' }),
    createStarterSigil(next, def('fireball'), { bound: true }),
    createStarterSigil(next, def('multishot'), { bound: true }),
    createRune(next(), 'split', 7),
    createRolledRune(next(), rng, 'rare', 8),
    createGear(next(), rng, 'magic', 5),
    createVessel(next(), rng, 'rare'),
  ];
  return { items, next };
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
    const rng = new Rng(3);
    const rare = createSigil(5, rng, 'rare', { ilvl: 10 });
    const { items, report } = convertRuneRolls([withRetiredAffix(rare)]);
    expect(items).toEqual([rare]);
    expect(report.affixesRemoved).toEqual([5]);
    expect(report.startersRebuilt).toEqual([]);
  });
});

describe('the buffed starters on load', () => {
  it('rebuild a sigil holding the old recipe: first runes keep uid and binding, the rest go', () => {
    for (const id of Object.keys(OLD_STARTER_RUNES)) {
      for (const bound of [true, false]) {
        let uid = 1;
        const old = oldStarter(id, () => uid++, bound);
        const { items, report } = convertRuneRolls([old]);
        const [after] = items;
        if (after?.kind !== 'sigil') throw new Error('not a sigil');
        const d = def(id);
        expect(recipe(after), id).toBe(recipe(createStarterSigil(() => 0, d, { bound })));
        expect(after.uid).toBe(old.uid);
        expect(after.slots.map((r) => r.uid)).toEqual(old.slots.slice(0, d.runes.length).map((r) => r.uid));
        expect(after.slots.every((r) => (r.bound === true) === bound)).toBe(true);
        expect(after.bound === true).toBe(bound);
        expect(matchingStarter(after)?.id).toBe(id);
        expect(compileSigilItem(after, d.classId).ok).toBe(true);
        expect(report.startersRebuilt).toEqual([{ sigil: old.uid, starter: id, runesRemoved: old.slots.slice(d.runes.length).map((r) => r.uid) }]);
      }
    }
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
    const retiered = base();
    variants.push({ ...retiered, slots: retiered.slots.map((r, i) => (i === 0 ? { ...r, affixes: r.affixes.map((a) => ({ ...a, tier: 3 })) } : r)) });
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
      const { items, report } = convertRuneRolls([v]);
      expect(items[0]).toBe(v);
      expect(report.startersRebuilt).toEqual([]);
    }
  });

  it('leave the other starters and the new recipes alone', () => {
    let uid = 1;
    const sigils = STARTER_SIGILS.map((d) => createStarterSigil(() => uid++, d, { bound: true }));
    const { items, report } = convertRuneRolls(sigils);
    expect(items.every((it, i) => it === sigils[i])).toBe(true);
    expect(report).toEqual({ affixesRemoved: [], startersRebuilt: [] });
  });
});

describe('conservation', () => {
  it('keeps every uid once, except runes the shorter recipes have no room for', () => {
    const { items: before } = mixedItems();
    const { items: after, report } = convertRuneRolls(before);
    const removed = new Set(report.startersRebuilt.flatMap((r) => r.runesRemoved));
    // 3 old Multishots and 2 old Flame Cleaves each lose one rune; 2 sigils lose the retired affix.
    expect(report.startersRebuilt).toHaveLength(5);
    expect(removed.size).toBe(5);
    expect(report.affixesRemoved).toHaveLength(2);
    const want = uidCounts(before);
    for (const u of removed) want.delete(u);
    expect(uidCounts(after)).toEqual(want);
    expect([...uidCounts(after).values()].every((n) => n === 1)).toBe(true);
    // Same items in the same order; only sigils change, and only in their affixes and slots.
    expect(after.map((i) => i.uid)).toEqual(before.map((i) => i.uid));
    before.forEach((b, i) => {
      const a = after[i];
      if (!a) throw new Error('item lost');
      if (b.kind !== 'sigil' || a.kind !== 'sigil') {
        expect(a).toBe(b);
        return;
      }
      const { affixes: _a1, slots: _s1, ...restA } = a;
      const { affixes: _a2, slots: _s2, ...restB } = b;
      expect(restA).toEqual(restB);
      const kept = b.affixes.map((x): string => x.id).filter((x) => x !== 'first_rune_free');
      expect(a.affixes.map((x) => x.id)).toEqual(kept);
      // A rebuilt sigil holds its starter's new runes; any other sigil holds exactly what it held.
      const rebuilt = report.startersRebuilt.find((r) => r.sigil === b.uid);
      if (rebuilt) expect(recipe(a)).toBe(recipeOf(def(rebuilt.starter).runes));
      else expect(a.slots).toEqual(b.slots);
    });
  });

  it('changes nothing the second time', () => {
    const once = convertRuneRolls(mixedItems().items);
    const twice = convertRuneRolls(once.items);
    expect(twice.report).toEqual({ affixesRemoved: [], startersRebuilt: [] });
    expect(twice.items.every((it, i) => it === once.items[i])).toBe(true);
    expect(JSON.parse(JSON.stringify(twice.items))).toEqual(JSON.parse(JSON.stringify(once.items)));
  });
});
