import { describe, expect, it } from 'vitest';
import { BAG, createRune, emptyGrid, STASH, type InventoryMessage, type Item, type RuneItem, type SigilItem } from '@rune/shared';
import { buildPool, draftSigil, insertAt, keepAll, moveSlot, plainRef, refundOverflow, removeAt, resolveDraft, runeStock } from '../src/ui/forge/draft.js';

const priceOf = (r: RuneItem): number => (r.affixes.length > 0 ? 50 : 5);

function rolled(uid: number, rune: RuneItem['rune']): RuneItem {
  return { ...createRune(uid, rune), affixes: [{ id: 'rune_damage', tier: 0, value: 20 }] };
}

function sigilWith(slots: RuneItem[]): SigilItem {
  return { uid: 100, kind: 'sigil', tier: 'magic', name: 'Test Sigil', ilvl: 1, affixes: [], slots, corrupted: false };
}

function inventory(bag: Item[], stash: Item[] = []): InventoryMessage {
  const inv = emptyGrid(BAG);
  bag.forEach((it, i) => (inv[i] = it.uid));
  const st = emptyGrid(STASH);
  stash.forEach((it, i) => (st[i] = it.uid));
  return { t: 'inventory', items: [...bag, ...stash], inventory: inv, stash: st, gold: 100, sigils: [null, null, null, null], warband: [], gear: { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null } };
}

describe('forge draft', () => {
  it('lists only owned runes, bag and stash counts apart', () => {
    const inv = inventory([createRune(1, 'fire', 3), rolled(2, 'orb')], [createRune(3, 'fire', 4), createRune(4, 'cold', 1)]);
    const pool = buildPool(sigilWith([]), [], runeStock(inv));
    expect(pool.plain.map((p) => [p.rune, p.bag, p.stash])).toEqual([
      ['fire', 3, 4],
      ['cold', 0, 1],
    ]);
    expect(pool.rolled.map((r) => [r.item.uid, r.origin])).toEqual([[2, 'bag']]);
  });

  it('hides runes the engine cannot run', () => {
    const inv = inventory([createRune(1, 'beam', 2)]);
    expect(buildPool(sigilWith([]), [], runeStock(inv)).plain).toEqual([]);
  });

  it('takes plain runes from the bag before the stash, and prices each insert', () => {
    const stock = runeStock(inventory([createRune(1, 'fire', 1)], [createRune(2, 'fire', 5)]));
    const res = resolveDraft(sigilWith([]), [{ from: 'plain', rune: 'fire' }, { from: 'plain', rune: 'fire' }], stock, priceOf);
    expect(res.slots.map((s) => s.origin)).toEqual(['bag', 'stash']);
    expect(res.price).toBe(10);
    // The one-rune bag stack is used up, so its cell frees for a refund.
    expect(res.freedBagCells).toBe(1);
  });

  it('drops refs to runes the character no longer has', () => {
    const stock = runeStock(inventory([createRune(1, 'fire', 1)]));
    const res = resolveDraft(sigilWith([]), [{ from: 'plain', rune: 'fire' }, { from: 'plain', rune: 'fire' }, { from: 'rolled', uid: 99 }], stock, priceOf);
    expect(res.valid).toEqual([{ from: 'plain', rune: 'fire' }]);
  });

  it('keeps are free, and every slot not kept is refunded', () => {
    const orb = rolled(10, 'orb');
    const fire = createRune(11, 'fire');
    const sigil = sigilWith([orb, fire]);
    const stock = runeStock(inventory([]));
    const res = resolveDraft(sigil, [{ from: 'keep', index: 1 }], stock, priceOf);
    expect(res.price).toBe(0);
    expect(res.refunds.map((r) => r.uid)).toEqual([10]);
    expect(draftSigil(sigil, res).slots.map((r) => r.rune)).toEqual(['fire']);
  });

  it('puts a rune taken out back as a keep before buying another', () => {
    const fire = createRune(11, 'fire');
    const sigil = sigilWith([fire]);
    const stock = runeStock(inventory([createRune(1, 'fire', 5)]));
    const pool = buildPool(sigil, [], stock);
    const entry = pool.plain.find((p) => p.rune === 'fire');
    expect(entry?.loose).toBe(1);
    expect(entry && plainRef(sigil, [], entry)).toEqual({ from: 'keep', index: 0 });
    expect(entry && plainRef(sigil, [{ from: 'keep', index: 0 }], entry)).toEqual({ from: 'plain', rune: 'fire' });
    // A rolled rune taken out shows in the pool as its keep.
    const orb = rolled(12, 'orb');
    expect(buildPool(sigilWith([orb]), [], stock).rolled.map((r) => r.ref)).toEqual([{ from: 'keep', index: 0 }]);
  });

  it('never offers one rolled rune twice', () => {
    const orb = rolled(2, 'orb');
    const stock = runeStock(inventory([orb]));
    expect(buildPool(sigilWith([]), [{ from: 'rolled', uid: 2 }], stock).rolled).toEqual([]);
    const res = resolveDraft(sigilWith([]), [{ from: 'rolled', uid: 2 }, { from: 'rolled', uid: 2 }], stock, priceOf);
    expect(res.valid).toHaveLength(1);
  });

  it('reorders, inserts and removes slots', () => {
    const d = keepAll(sigilWith([createRune(1, 'orb'), createRune(2, 'fire'), createRune(3, 'nova')]));
    expect(moveSlot(d, 0, 2)).toEqual([{ from: 'keep', index: 1 }, { from: 'keep', index: 2 }, { from: 'keep', index: 0 }]);
    expect(insertAt(d, { from: 'plain', rune: 'cold' }, 1)[1]).toEqual({ from: 'plain', rune: 'cold' });
    expect(removeAt(d, 1)).toEqual([{ from: 'keep', index: 0 }, { from: 'keep', index: 2 }]);
  });

  it('counts refunds that will not fit in a full bag', () => {
    const filler: Item[] = Array.from({ length: BAG.w * BAG.h }, (_, i) => rolled(200 + i, 'bolt'));
    const inv = inventory(filler);
    const sigil = sigilWith([rolled(10, 'orb'), createRune(11, 'fire')]);
    const stock = runeStock(inv);
    expect(refundOverflow(inv, stock, resolveDraft(sigil, [], stock, priceOf))).toBe(2);
    // Taking a rolled rune out of the bag frees its cell for one refund.
    expect(refundOverflow(inv, stock, resolveDraft(sigil, [{ from: 'rolled', uid: 200 }], stock, priceOf))).toBe(1);
  });

  it('the bench offers every castable rune for free', () => {
    const stock = runeStock(inventory([]), true);
    const pool = buildPool(sigilWith([]), [], stock);
    expect(pool.plain.some((p) => p.rune === 'orb' && p.unlimited)).toBe(true);
    const res = resolveDraft(sigilWith([]), [{ from: 'plain', rune: 'orb' }], stock, priceOf);
    expect(res.price).toBe(0);
    expect(res.slots[0]?.item.bound).toBe(true);
  });
});
