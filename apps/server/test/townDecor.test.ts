import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decorCollision, GameMap, layoutHash, layoutToMap, parseClientMessage, TOWN_DECOR_ASSETS, TOWN_LIMITS, validateLayout, type TownDecor, type TownLayout } from '@rune/shared';

/** The town as it is live (the committed file matched arpg.akj.io/api/town on 2026-09-30). */
const liveRaw: unknown = JSON.parse(readFileSync(new URL('../data/town-layout.json', import.meta.url), 'utf8'));

function live(): TownLayout {
  const l = validateLayout(liveRaw);
  if (!l) throw new Error('the committed town must validate');
  return l;
}

function fnv(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

function withDecor(decor: unknown[]): unknown {
  return { ...structuredClone(live()), decor };
}

const piece = (asset: string, extra: Partial<TownDecor> = {}): TownDecor => ({ asset, x: 1100, y: 500, angle: 0, scale: 1, ...extra });

describe('town decor from the palette', () => {
  it('the live town loads exactly as before the palette: same layout, same hash, same map', () => {
    const l = live();
    // Hashes taken with the code before the palette existed.
    expect(JSON.stringify(l)).toBe(JSON.stringify(liveRaw));
    expect(layoutHash(l)).toBe('oz7hq8');
    const map = layoutToMap(l);
    // `look` (each house's and pillar's model) came later, and is the only addition to the map.
    expect(fnv(JSON.stringify(map, (k, v: unknown) => (k === 'look' ? undefined : v)))).toBe('1yv56t2');
    expect(map.obstacles).toHaveLength(73);
    expect(map.obstacles.some((o) => o.kind === 'decor')).toBe(false);
    // The server's lenient load changes nothing either.
    expect(validateLayout(liveRaw, { unknownDecor: 'drop' })).toEqual(l);
  });

  it('a save giving a prop an unknown model is rejected; a town loaded from disk drops just the model', () => {
    const l = live();
    const i = l.props.findIndex((p) => p.kind === 'house');
    const withModel = (model: unknown): unknown => ({ ...structuredClone(l), props: l.props.map((p, j) => (j === i ? { ...p, model } : p)) });
    expect(parseClientMessage({ t: 'saveTown', layout: withModel('building_castle_red') })).toBeNull();
    expect(parseClientMessage({ t: 'saveTown', layout: withModel(7) })).toBeNull();
    // A pillar's model on a house is as unknown as a made-up one.
    expect(parseClientMessage({ t: 'saveTown', layout: withModel('dungeon_column') })).toBeNull();
    const ok = parseClientMessage({ t: 'saveTown', layout: withModel('building_tavern_red') });
    expect(ok?.t === 'saveTown' ? ok.layout.props[i]?.model : null).toBe('building_tavern_red');
    expect(validateLayout(withModel('building_castle_red'), { unknownDecor: 'drop' })).toEqual(l);
  });

  it('every asset in the live town is placeable', () => {
    for (const d of live().decor) expect(TOWN_DECOR_ASSETS[d.asset], d.asset).toBeDefined();
  });

  it('a save naming an unknown asset is rejected; a town loaded from disk drops just that piece', () => {
    const bad = withDecor([...live().decor, piece('dragon_statue')]);
    expect(validateLayout(bad)).toBeNull();
    const loaded = validateLayout(bad, { unknownDecor: 'drop' });
    expect(loaded?.decor).toEqual(live().decor);
    // The editor's save goes through the protocol check, which is strict.
    expect(parseClientMessage({ t: 'saveTown', layout: bad })).toBeNull();
    expect(parseClientMessage({ t: 'saveTown', layout: withDecor([piece('campfire')]) })).not.toBeNull();
  });

  it('keeps solid only when true, so layouts without solid pieces serialise as before', () => {
    const l = validateLayout(withDecor([piece('barrel', { solid: true }), { ...piece('sack'), solid: false }]));
    expect(l?.decor[0]).toEqual({ asset: 'barrel', x: 1100, y: 500, angle: 0, scale: 1, solid: true });
    expect(l?.decor[1]).toEqual({ asset: 'sack', x: 1100, y: 500, angle: 0, scale: 1 });
    expect(Object.hasOwn(l?.decor[1] ?? {}, 'solid')).toBe(false);
    expect(validateLayout(withDecor([{ ...piece('barrel'), solid: 'yes' }]))).toBeNull();
  });

  it('bounds decor, solid decor and lit decor', () => {
    const many = (n: number, d: TownDecor) => new Array<TownDecor>(n).fill(d);
    expect(validateLayout(withDecor(many(TOWN_LIMITS.decor + 1, piece('barrel'))))).toBeNull();
    expect(validateLayout(withDecor(many(TOWN_LIMITS.solidDecor, piece('barrel', { solid: true }))))).not.toBeNull();
    expect(validateLayout(withDecor(many(TOWN_LIMITS.solidDecor + 1, piece('barrel', { solid: true }))))).toBeNull();
    expect(validateLayout(withDecor(many(TOWN_LIMITS.litDecor, piece('campfire'))))).not.toBeNull();
    expect(validateLayout(withDecor(many(TOWN_LIMITS.litDecor + 1, piece('grave_candle'))))).toBeNull();
  });

  it('a solid building blocks walking at its footprint; the same piece without solid does not', () => {
    const house = piece('building_tavern_blue', { x: 400, y: 900 });
    const solid = layoutToMap({ ...live(), decor: [{ ...house, solid: true }] });
    const loose = layoutToMap({ ...live(), decor: [house] });
    expect(solid.obstacles.filter((o) => o.kind === 'decor')).toHaveLength(1);
    expect(new GameMap(solid).pointBlocked(400, 900, 10, 'move')).toBe(true);
    expect(new GameMap(loose).pointBlocked(400, 900, 10, 'move')).toBe(false);
    // Tall enough to stop shots too; the map decor itself carries no solid flag.
    expect(solid.obstacles.find((o) => o.kind === 'decor')?.blocksShots).toBe(true);
    expect(Object.hasOwn(solid.decor.at(-1) ?? {}, 'solid')).toBe(false);
  });

  it('turns and offsets footprints with the model, and trees block only at the trunk', () => {
    const spec = TOWN_DECOR_ASSETS.dungeon_wall_half;
    expect(spec?.ox).toBeGreaterThan(10);
    const turned = decorCollision(piece('dungeon_wall_half', { angle: Math.PI / 2 }));
    // The half wall sits to the model's +x; turned a quarter it sits to the map's +y.
    expect(turned?.type).toBe('box');
    if (turned?.type === 'box') {
      expect(turned.x).toBeCloseTo(1100, 5);
      expect(turned.y).toBeCloseTo(500 + (spec?.ox ?? 0), 5);
    }
    const tree = decorCollision(piece('tree_single_A', { scale: 2 }));
    expect(tree?.type).toBe('circle');
    if (tree?.type === 'circle') expect(tree.r).toBeLessThan(((TOWN_DECOR_ASSETS.tree_single_A?.w ?? 0) / 2) * 2 * 0.5);
  });
});
