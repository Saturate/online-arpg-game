import { existsSync } from 'node:fs';
import { TOWN_DECOR_ASSETS, TOWN_PROP_KINDS, validateLayout, DEFAULT_TOWN_LAYOUT, layoutToMap } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { filterPalette, groupPalette, paletteEntries } from '../src/game/townPalette.js';
import { hideInMap, pickAll, stationsOf } from '../src/game/townEditorPick.js';
import { ASSETS } from '../src/render/assets.js';
import { isLitDecor, PROCEDURAL_DECOR } from '../src/render/props.js';

const PUBLIC = new URL('../public', import.meta.url).pathname;

describe('town editor palette', () => {
  it('asset ids are unique', () => {
    const ids = ASSETS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every scenery model file is in public/', () => {
    for (const a of ASSETS.filter((d) => d.category !== 'hero' && d.category !== 'monster')) expect(existsSync(`${PUBLIC}${a.url}`), a.url).toBe(true);
  });

  it('the shared list matches the registry (run scripts/assets/town-decor.ts after changing assets.ts)', () => {
    const placeable = ASSETS.filter((a) => a.category !== 'hero' && a.category !== 'monster' && a.town !== false);
    const expected = [...placeable.map((a) => a.id), ...Object.keys(PROCEDURAL_DECOR)].sort();
    expect(Object.keys(TOWN_DECOR_ASSETS).sort()).toEqual(expected);
    for (const a of placeable) {
      expect(TOWN_DECOR_ASSETS[a.id]?.h, a.id).toBe(a.height);
      expect(TOWN_DECOR_ASSETS[a.id]?.lit, a.id).toBe(isLitDecor(a.id));
    }
    // Cute or misleading pieces stay out of town.
    for (const id of ['grave_pumpkin_orange', 'dungeon_chest', 'dungeon_coin_stack']) expect(TOWN_DECOR_ASSETS[id]).toBeUndefined();
  });

  it('lists every prop kind and every placeable asset once, in groups', () => {
    const entries = paletteEntries();
    expect(entries).toHaveLength(TOWN_PROP_KINDS.length + Object.keys(TOWN_DECOR_ASSETS).length);
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
    const groups = groupPalette(entries).map((g) => g.group);
    expect(groups[0]).toBe('Town pieces');
    expect(groups).toContain('Lights and fires');
    expect(entries.find((e) => e.key === 'decor:weaponrack')?.hint).toBe('the forge');
    expect(entries.find((e) => e.key === 'prop:chest')?.hint).toBe('the stash');
  });

  it('search finds the camp fire and the lights', () => {
    const entries = paletteEntries();
    expect(filterPalette(entries, 'camp fire').map((e) => e.key)).toEqual(['decor:campfire']);
    const lit = filterPalette(entries, 'lit').map((e) => e.key);
    expect(lit).toContain('decor:grave_candle_triple');
    expect(lit).toContain('prop:lamp');
    expect(filterPalette(entries, 'TOWER').length).toBeGreaterThan(3);
  });

  it('a placed building is picked anywhere on its footprint, and hiding it drops its collision from the preview', () => {
    const layout = validateLayout({ ...DEFAULT_TOWN_LAYOUT, decor: [{ asset: 'building_castle_red', x: 500, y: 1100, angle: 0, scale: 1, solid: true }] });
    if (!layout) throw new Error('valid layout');
    const look = () => ({ label: 'Castle', kind: 'building' as const, height: 280 });
    // 60 units from the centre is well inside the castle, outside the small-decor circle cap.
    const under = pickAll(layout, 500 + 60, 1100 + 70, { look, stations: stationsOf(layout), skip: () => false });
    expect(under[0]).toEqual({ type: 'decor', index: 0 });
    const full = layoutToMap(layout);
    const shown = hideInMap(full, layout, new Set(['decor:0']));
    expect(full.obstacles.filter((o) => o.kind === 'decor')).toHaveLength(1);
    expect(shown.obstacles.filter((o) => o.kind === 'decor')).toHaveLength(0);
  });
});
