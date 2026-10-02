import { createGear, Rng, type EntitySnap, type LootName } from '@rune/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { dropLootWindow, hoverPile, openLootWindow, opensWindow, pileLabel, receiveLootPile, useLootHover, useLootWindow } from '../src/ui/lootPiles.js';

type LootSnap = Extract<EntitySnap, { k: 'loot' }>;

function pile(names: LootName[], count = names.length, id = 7): LootSnap {
  return { id, x: 0, y: 0, r: 16, k: 'loot', tier: names[0]?.tier ?? 'common', count, names, gold: 0 };
}

describe('pile labels', () => {
  it('names a single item and counts a pile in its best colour', () => {
    expect(pileLabel(pile([{ n: 'Grim Band', tier: 'rare' }]), false)?.text).toBe('Grim Band');
    const many = pileLabel(pile([{ n: 'Grim Band', tier: 'rare' }, { n: 'Ring', tier: 'common' }], 5), false);
    expect(many?.text).toBe('5 items');
    expect(many?.color).toBe(pileLabel(pile([{ n: 'x', tier: 'rare' }]), false)?.color);
    expect(pileLabel(pile([{ n: 'Fire Rune', tier: 'common', c: 7 }]), true)?.text).toBe('Fire Rune x7');
  });

  it('hides common and magic piles until Alt is held; uniques always show', () => {
    expect(pileLabel(pile([{ n: 'Ring', tier: 'magic' }, { n: 'Ring', tier: 'common' }]), false)).toBeNull();
    expect(pileLabel(pile([{ n: 'Ring', tier: 'magic' }, { n: 'Ring', tier: 'common' }]), true)?.text).toBe('2 items');
    expect(pileLabel(pile([{ n: 'Brothers Creation', tier: 'relic', u: true }]), false)).not.toBeNull();
    expect(pileLabel({ ...pile([]), gold: 40 }, true)).toBeNull();
  });

  it('a single item is taken at once, a pile opens its window', () => {
    expect(opensWindow(1)).toBe(false);
    expect(opensWindow(2)).toBe(true);
  });
});

describe('loot window store', () => {
  beforeEach(() => dropLootWindow());
  const item = createGear(1, new Rng(3), 'magic', 1, { category: 'ring' });

  it('fills on the answer for its pile and ignores stale answers for another', () => {
    openLootWindow(5);
    expect(useLootWindow.getState()).toMatchObject({ id: 5, items: null });
    receiveLootPile({ t: 'lootPile', id: 4, items: [item], own: [] });
    expect(useLootWindow.getState().items).toBeNull();
    receiveLootPile({ t: 'lootPile', id: 5, items: [item], own: [item.uid] });
    expect(useLootWindow.getState()).toMatchObject({ id: 5, items: [item], own: [item.uid] });
  });

  it('closes when the server says the pile is gone, but not for another pile', () => {
    openLootWindow(5);
    receiveLootPile({ t: 'lootPile', id: 5, items: [item], own: [] });
    receiveLootPile({ t: 'lootPile', id: 4, items: null });
    expect(useLootWindow.getState().id).toBe(5);
    receiveLootPile({ t: 'lootPile', id: 5, items: null });
    expect(useLootWindow.getState()).toMatchObject({ id: null, items: null });
  });
});

describe('hover preview store', () => {
  it('writes only when what the preview shows changes', () => {
    hoverPile(null);
    let writes = 0;
    const stop = useLootHover.subscribe(() => writes++);
    hoverPile(pile([{ n: 'Ring', tier: 'magic' }]));
    // A new snapshot of the same pile, as arrives every tick.
    hoverPile(pile([{ n: 'Ring', tier: 'magic' }]));
    expect(writes).toBe(1);
    hoverPile(pile([{ n: 'Ring', tier: 'magic' }, { n: 'Band', tier: 'rare' }]));
    expect(writes).toBe(2);
    hoverPile(null);
    hoverPile(null);
    expect(writes).toBe(3);
    stop();
  });
});
