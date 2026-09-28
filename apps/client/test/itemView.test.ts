import { describe, expect, it } from 'vitest';
import { createGear, GEAR_BASES, Simulation } from '@rune/shared';
import { hasGearArt } from '../src/ui/icons.js';
import { affixPips, ICON_MODELS, placeTooltip, unusable } from '../src/ui/itemView.js';

describe('item view rules', () => {
  const sim = new Simulation(3, { kind: 'flat' });

  it('marks gear above your level, or for another class, as unusable', () => {
    const helm = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 9, { category: 'helmet' });
    expect(unusable(helm, 1, 'warrior')).toEqual({ reason: 'level', need: 7 });
    expect(unusable(helm, 7, 'warrior')).toBeNull();
    const bow = createGear(sim.newItemUid(), sim.rand.loot, 'magic', 1, { base: 'short_bow' });
    expect(unusable(bow, 10, 'mage')).toEqual({ reason: 'class' });
    expect(unusable(bow, 10, 'ranger')).toBeNull();
  });

  it('keeps the tooltip inside the viewport, flipping before it clamps', () => {
    expect(placeTooltip(100, 100, 300, 200, 1280, 720)).toEqual({ left: 118, top: 118 });
    // Near the right edge it flips to the left of the cursor.
    expect(placeTooltip(1200, 100, 300, 200, 1280, 720).left).toBe(1200 - 18 - 300);
    // Near the bottom it flips above.
    expect(placeTooltip(100, 700, 300, 200, 1280, 720).top).toBe(700 - 18 - 200);
    // Too tall for either side: clamped to the margin.
    expect(placeTooltip(100, 300, 300, 900, 1280, 720).top).toBe(8);
  });

  it('shows a pip per affix, capped at five', () => {
    const rare = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 9);
    expect(affixPips(rare)).toBe(Math.min(5, rare.affixes.length));
  });

  it('has drawn art for every base, and 3D models only for real bases', () => {
    for (const b of GEAR_BASES) expect(hasGearArt(b.id), b.id).toBe(true);
    const ids = new Set(GEAR_BASES.map((b) => b.id));
    for (const key of Object.keys(ICON_MODELS)) expect(ids.has(key), key).toBe(true);
  });
});
