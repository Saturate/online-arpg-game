import { describe, expect, it } from 'vitest';
import {
  convertImplicits,
  convertRuneRolls,
  createRolledRune,
  createRune,
  createSigil,
  createStarterSigil,
  createVessel,
  IMPLICIT_NEUTRAL_TIER,
  isRuneImplicits1,
  loadImplicits,
  neutralImplicit,
  oldStarterRunes,
  Rng,
  runeItemFromInstance,
  sellPrice,
  starterSigilById,
  type Item,
  type RuneItem,
  type SigilItem,
} from '../src/index.js';

/** Items as a save from before implicits holds them: no rune carries one. */
function preImplicit(item: Item): Item {
  const strip = (r: RuneItem): RuneItem => {
    const { implicit: _gone, ...old } = r;
    return old;
  };
  if (item.kind === 'rune') return strip(item);
  if (item.kind === 'sigil') return { ...item, slots: item.slots.map(strip) };
  return item;
}

function oldSave(): Item[] {
  let uid = 1;
  const rng = new Rng(4);
  const def = starterSigilById('fireball');
  if (!def) throw new Error('fireball');
  const items: Item[] = [
    createRune(uid++, 'fire', 7),
    { ...createRune(uid++, 'bolt', 3), bound: true },
    createRolledRune(uid++, rng, 'rare', 12, 'orb'),
    createRolledRune(uid++, rng, 'magic', 3, 'split'),
    createStarterSigil(() => uid++, def, { bound: true }),
    { ...createSigil(uid++, rng, 'rare', { ilvl: 8 }), slots: [createRune(uid++, 'nova'), createRune(uid++, 'lightning'), createRune(uid++, 'concentrated')] },
    createVessel(uid++, rng, 'magic'),
    // A rune the engine cannot run yet has no implicit to give.
    createRune(uid++, 'beam', 2),
  ];
  return items.map(preImplicit);
}

const runes = (items: readonly Item[]): RuneItem[] => items.flatMap((i) => (i.kind === 'rune' ? [i] : i.kind === 'sigil' ? i.slots : []));

describe('the implicit pass', () => {
  it('gives every castable rune, loose or in a sigil, the neutral roll and changes nothing else', () => {
    const before = oldSave();
    const { items, report } = convertImplicits(before);
    expect(items).toHaveLength(before.length);
    const was = runes(before);
    const now = runes(items);
    expect(now.map((r) => r.uid)).toEqual(was.map((r) => r.uid));
    now.forEach((r, i) => {
      const old = was[i];
      if (!old) throw new Error('lost');
      const { implicit, ...rest } = r;
      expect(rest).toEqual(old);
      expect(implicit).toEqual(neutralImplicit(r.rune) ?? undefined);
      if (implicit) expect(implicit.tier).toBe(IMPLICIT_NEUTRAL_TIER);
    });
    expect(report.runesGiven.sort((a, b) => a - b)).toEqual(was.filter((r) => neutralImplicit(r.rune) !== null).map((r) => r.uid).sort((a, b) => a - b));
    // Stacks keep their count; gear, vessels and sigil fields are untouched.
    expect(items.filter((i) => i.kind === 'vessel')).toEqual(before.filter((i) => i.kind === 'vessel'));
    const sigils = items.filter((i): i is SigilItem => i.kind === 'sigil');
    sigils.forEach((s, i) => {
      const b = before.filter((x): x is SigilItem => x.kind === 'sigil')[i];
      expect({ ...s, slots: [] }).toEqual({ ...b, slots: [] });
    });
  });

  it('moves no gold: the neutral tier adds nothing to any price', () => {
    const before = oldSave();
    const { items } = convertImplicits(before);
    expect(items.map(sellPrice)).toEqual(before.map(sellPrice));
  });

  it('is idempotent, leaves runes that already have one alone, and returns untouched items as they are', () => {
    const { items } = convertImplicits(oldSave());
    const again = convertImplicits(items);
    expect(again.report.runesGiven).toEqual([]);
    expect(again.items).toEqual(items);
    again.items.forEach((it, i) => expect(it).toBe(items[i]));
    const strong: RuneItem = { ...createRune(99, 'bolt'), implicit: { id: 'implicit_base', tier: 5, value: 123 } };
    expect(convertImplicits([strong]).items[0]).toBe(strong);
  });

  it('runs after the rune roll pass, which still finds and rebuilds old kits', () => {
    let uid = 1;
    const def = starterSigilById('multishot');
    const old = oldStarterRunes('multishot');
    if (!def || !old) throw new Error('multishot');
    const sigil: SigilItem = { uid: uid++, kind: 'sigil', tier: 'common', name: def.name, ilvl: 1, affixes: [], slots: old.map((r) => runeItemFromInstance(uid++, r, false)), corrupted: false, starter: 'multishot' };
    const stored = preImplicit({ ...sigil, slots: sigil.slots.map((r) => ({ ...r, affixes: r.affixes.map((a) => ({ ...a, tier: 0 })) })) });
    const rolls = convertRuneRolls([stored]);
    expect(rolls.report.startersRebuilt).toHaveLength(1);
    const { items } = convertImplicits([...rolls.items, ...rolls.returned]);
    expect(runes(items).every((r) => r.implicit !== undefined)).toBe(true);
  });

  it('reads the marker off the stored row', () => {
    const before = oldSave();
    expect(isRuneImplicits1({ runeImplicits: 1 })).toBe(true);
    expect(isRuneImplicits1({ runeImplicits: 2 })).toBe(false);
    expect(loadImplicits({ runeImplicits: 1 }, before).items).toEqual(before);
    expect(loadImplicits({}, before).report.runesGiven.length).toBeGreaterThan(0);
  });
});
