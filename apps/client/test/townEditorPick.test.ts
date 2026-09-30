import { describe, expect, it } from 'vitest';
import { DEFAULT_TOWN_LAYOUT, layoutToMap, type TownLayout } from '@rune/shared';
import {
  cycleClick,
  cycleKey,
  filterRows,
  groupRows,
  hideInMap,
  LAYER_GROUPS,
  layerRows,
  parseKey,
  PICK,
  pickAll,
  refKey,
  shiftKeys,
  stationsOf,
  type DecorLookup,
  type PickContext,
} from '../src/game/townEditorPick.js';

const look: DecorLookup = (asset) => ({ label: asset, kind: asset === 'pine_tree' ? 'nature' : asset === 'grave_post_lantern' ? 'light' : 'other', height: 40 });

/** A small town: a house with a chest, a barrel and the forge rack standing in it, on a plaza. */
function town(): TownLayout {
  return {
    version: 1,
    name: 'Test',
    width: 1000,
    height: 1000,
    spawn: { x: 100, y: 100 },
    props: [
      { kind: 'house', x: 500, y: 500, angle: 0, scale: 1, length: 0 },
      { kind: 'chest', x: 520, y: 500, angle: 0, scale: 1, length: 0 },
      { kind: 'chest', x: 900, y: 900, angle: 0, scale: 1, length: 0 },
      { kind: 'lamp', x: 300, y: 300, angle: 0, scale: 1, length: 0 },
      { kind: 'oak', x: 700, y: 200, angle: 0, scale: 1, length: 0 },
      { kind: 'stall', x: 200, y: 700, angle: 0, scale: 1, length: 0 },
    ],
    paths: [
      {
        points: [
          { x: 0, y: 500 },
          { x: 1000, y: 500 },
        ],
        width: 100,
      },
    ],
    plazas: [{ x: 500, y: 500, r: 300 }],
    portals: [{ target: 'wilds', x: 500, y: 50 }],
    decor: [
      { asset: 'barrel', x: 480, y: 500, angle: 0, scale: 1 },
      { asset: 'weaponrack', x: 560, y: 520, angle: 0, scale: 1 },
      { asset: 'weaponrack', x: 950, y: 950, angle: 0, scale: 1 },
    ],
  };
}

function ctx(layout: TownLayout, skip: (k: string) => boolean = () => false): PickContext {
  return { look, stations: stationsOf(layout), skip };
}

describe('town editor picking', () => {
  it('finds the stations by the same rule as the game map', () => {
    const L = town();
    const s = stationsOf(L);
    expect(s.get('prop:1')).toBe('stash');
    expect(s.get('prop:5')).toBe('trader');
    expect(s.get('decor:1')).toBe('forge');
    expect(s.has('prop:2')).toBe(false);
    const map = layoutToMap(L);
    expect(map.stash).toEqual({ x: 520, y: 500 });
    expect(map.forge).toEqual({ x: 560, y: 520 });
    // The shipped town's forge is found too.
    const d = stationsOf(DEFAULT_TOWN_LAYOUT);
    const forgeKey = [...d].find(([, v]) => v === 'forge')?.[0];
    const rack = forgeKey ? parseKey(forgeKey) : null;
    expect(rack?.type).toBe('decor');
  });

  it('lists everything under a point front to back: stations, small things, big things, ground', () => {
    const L = town();
    const under = pickAll(L, 530, 505, ctx(L)).map(refKey);
    expect(under).toEqual(['decor:1', 'prop:1', 'prop:0', 'path:0', 'plaza:0']);
  });

  it('gives stations a bigger target than their footprint', () => {
    const L = town();
    // 40 units right of the rack: outside its own circle (18 + 6), inside the station reach.
    expect(PICK.stationPad).toBeGreaterThan(PICK.pad);
    const at = { x: 560 + 40, y: 520 };
    expect(pickAll(L, at.x, at.y, ctx(L)).map(refKey)).toContain('decor:1');
    // The same spot beside the spare rack, which is not the forge, misses it.
    expect(pickAll(L, 950 + 40, 950, ctx(L)).map(refKey)).not.toContain('decor:2');
  });

  it('lets clicks pass through locked and hidden objects', () => {
    const L = town();
    const under = pickAll(
      L,
      530,
      505,
      ctx(L, (k) => k === 'prop:1' || k === 'prop:0'),
    ).map(refKey);
    expect(under).toEqual(['decor:1', 'path:0', 'plaza:0']);
  });
});

describe('click cycling', () => {
  const keys = ['a', 'b', 'c'];

  it('steps through the stack at the same spot and wraps', () => {
    let c = cycleClick(null, 100, 100, keys, null);
    const seen = [c && cycleKey(c)];
    for (let i = 0; i < 3; i++) {
      c = cycleClick(c, 102, 101, keys, seen[seen.length - 1] ?? null);
      seen.push(c && cycleKey(c));
    }
    expect(seen).toEqual(['a', 'b', 'c', 'a']);
  });

  it('starts over after a click elsewhere or over different objects', () => {
    const c1 = cycleClick(null, 100, 100, keys, null);
    const c2 = cycleClick(c1, 100, 100, keys, 'a');
    expect(c2 && cycleKey(c2)).toBe('b');
    const far = cycleClick(c2, 200, 100, keys, null);
    expect(far && cycleKey(far)).toBe('a');
    const other = cycleClick(c2, 100, 100, ['a', 'd'], null);
    expect(other && cycleKey(other)).toBe('a');
  });

  it('keeps the current selection on a fresh click over it', () => {
    const c = cycleClick(null, 10, 10, keys, 'c');
    expect(c && cycleKey(c)).toBe('c');
    const next = cycleClick(c, 10, 10, keys, 'c');
    expect(next && cycleKey(next)).toBe('a');
  });

  it('keeps the first order even if the stack is reported in another order', () => {
    const c1 = cycleClick(null, 0, 0, ['a', 'b', 'c'], null);
    const c2 = cycleClick(c1, 0, 0, ['c', 'b', 'a'], 'a');
    expect(c2 && cycleKey(c2)).toBe('b');
  });

  it('selects nothing over empty ground', () => {
    expect(cycleClick(null, 0, 0, [], null)).toBeNull();
  });
});

describe('layer list', () => {
  it('groups rows with the stations first, forge leading', () => {
    const L = town();
    const rows = layerRows(L, look, stationsOf(L));
    expect(rows).toHaveLength(L.props.length + L.decor.length + L.paths.length + L.plazas.length + L.portals.length + 1);
    const groups = groupRows(rows).map((g) => g.group);
    expect(groups).toEqual(LAYER_GROUPS.filter((g) => groups.includes(g)));
    expect(groups[0]).toBe('Stations');
    const stations = rows.filter((r) => r.group === 'Stations').map((r) => r.key);
    expect(stations).toEqual(['decor:1', 'prop:1', 'prop:5', 'portal:0', 'spawn']);
    expect(rows.find((r) => r.key === 'prop:0')?.group).toBe('Buildings');
    expect(rows.find((r) => r.key === 'prop:3')?.group).toBe('Lights and decor');
    expect(rows.find((r) => r.key === 'prop:4')?.group).toBe('Nature');
    expect(rows.find((r) => r.key === 'prop:2')?.group).toBe('Props');
  });

  it('searches names and groups, every word must match', () => {
    const L = town();
    const rows = layerRows(L, look, stationsOf(L));
    expect(filterRows(rows, 'FORGE').map((r) => r.key)).toEqual(['decor:1']);
    expect(filterRows(rows, 'chest').map((r) => r.key)).toEqual(['prop:1', 'prop:2']);
    expect(filterRows(rows, 'chest stations').map((r) => r.key)).toEqual(['prop:1']);
    expect(filterRows(rows, '  ')).toHaveLength(rows.length);
    expect(filterRows(rows, 'nothing like this')).toEqual([]);
  });
});

describe('hide and lock flags', () => {
  it('follow their objects when an earlier one is deleted', () => {
    const keys = new Set(['prop:1', 'prop:3', 'decor:3', 'spawn']);
    expect([...shiftKeys(keys, { type: 'prop', index: 1 })].sort()).toEqual(['decor:3', 'prop:2', 'spawn']);
    expect([...shiftKeys(keys, { type: 'prop', index: 5 })].sort()).toEqual([...keys].sort());
  });

  it('leave hidden objects out of the preview without adding station fallbacks', () => {
    const L = town();
    const full = layoutToMap(L);
    const shown = hideInMap(full, L, new Set(['decor:1', 'prop:0', 'prop:3', 'prop:4', 'plaza:0', 'path:0']));
    expect(shown.decor).toHaveLength(full.decor.length - 1);
    expect(shown.decor.some((d) => d.x === 560 && d.y === 520)).toBe(false);
    expect(shown.forge).toBeUndefined();
    expect(shown.obstacles).toHaveLength(full.obstacles.length - 2);
    expect(shown.lamps).toHaveLength((full.lamps?.length ?? 0) - 1);
    expect(shown.oaks).toHaveLength(0);
    expect(shown.ground).toHaveLength(0);
    // The layout itself is untouched: flags are editor-only.
    expect(L).toEqual(town());
    expect(hideInMap(full, L, new Set())).toBe(full);
  });
});
