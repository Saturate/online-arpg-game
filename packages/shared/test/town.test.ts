import { describe, expect, it } from 'vitest';
import { checkLayout, decorCollision, decorFootprint, decorSpec, DEFAULT_TOWN_LAYOUT, GROUND, layoutToMap, loadMap, mapKey, Rng, SIM, stepPlayer, validateLayout, type MoveState } from '../src/index.js';

describe('town layouts', () => {
  it('the default layout survives a JSON round trip through validation', () => {
    const back = validateLayout(JSON.parse(JSON.stringify(DEFAULT_TOWN_LAYOUT)));
    expect(back).toEqual(DEFAULT_TOWN_LAYOUT);
  });

  it('never takes an Object.prototype member for a decor asset', () => {
    const base = JSON.parse(JSON.stringify(DEFAULT_TOWN_LAYOUT));
    for (const asset of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      const piece = { asset, x: 300, y: 300, angle: 0, scale: 1 };
      expect(decorSpec(asset)).toBeUndefined();
      expect(checkLayout({ ...base, decor: [piece] })).toBe(`decor[0]: unknown asset ${asset}`);
      expect(validateLayout({ ...base, decor: [{ ...piece, solid: true }] })).toBeNull();
      // A town loaded from disk drops it like any unknown asset.
      expect(validateLayout({ ...base, decor: [piece] }, { unknownDecor: 'drop' })?.decor).toEqual([]);
      expect(decorFootprint({ ...piece, solid: true })).toBeNull();
      expect(decorCollision({ ...piece, solid: true })).toBeNull();
      expect(layoutToMap({ ...DEFAULT_TOWN_LAYOUT, decor: [{ ...piece, solid: true }] }).obstacles.some((o) => o.kind === 'decor')).toBe(false);
    }
  });

  it('rejects hostile or broken layouts', () => {
    const base = JSON.parse(JSON.stringify(DEFAULT_TOWN_LAYOUT));
    expect(validateLayout({ ...base, width: 1e9 })).toBeNull();
    expect(validateLayout({ ...base, props: [{ ...base.props[0], kind: 'dragon' }] })).toBeNull();
    expect(validateLayout({ ...base, props: [{ ...base.props[0], x: Number.NaN }] })).toBeNull();
    expect(validateLayout({ ...base, portals: [] })).toBeNull();
    expect(validateLayout({ ...base, props: new Array(601).fill(base.props[0]) })).toBeNull();
  });

  it('builds a safe town map with portals, lamps and obstacles', () => {
    const map = layoutToMap(DEFAULT_TOWN_LAYOUT);
    expect(map.safe).toBe(true);
    expect(map.portals.map((p) => p.target).sort()).toEqual(['arena', 'wilds']);
    expect(map.lamps?.length).toBe(4);
    expect(map.obstacles.some((o) => o.kind === 'house')).toBe(true);
  });

  it('a changed layout gets a different map key, so clients rebuild', () => {
    const edited = { ...DEFAULT_TOWN_LAYOUT, props: DEFAULT_TOWN_LAYOUT.props.slice(1) };
    expect(mapKey({ kind: 'town', layout: edited })).not.toBe(mapKey({ kind: 'town', layout: DEFAULT_TOWN_LAYOUT }));
  });
});

describe('paths', () => {
  it('walking on a road is faster than walking on grass', () => {
    const { game } = loadMap({ kind: 'town', layout: DEFAULT_TOWN_LAYOUT });
    // The east road runs from the plaza to x 2060 at y 850; grass lies well south of it.
    const onRoad = stepPlayer(game, { x: 1500, y: 850, dash: null }, { x: 1, y: 0 }, 200, SIM.dt, SIM.playerRadius);
    const onGrass: MoveState = stepPlayer(game, { x: 1500, y: 1150, dash: null }, { x: 1, y: 0 }, 200, SIM.dt, SIM.playerRadius);
    expect(onRoad.x - 1500).toBeCloseTo(200 * SIM.dt * (1 + GROUND.roadSpeedBonus));
    expect(onGrass.x - 1500).toBeCloseTo(200 * SIM.dt);
  });
});

describe('random streams', () => {
  it('streams with different labels are independent and reproducible', () => {
    const a1 = Rng.stream(42, 'loot');
    const a2 = Rng.stream(42, 'loot');
    const b = Rng.stream(42, 'combat');
    const seqA1 = [a1.next(), a1.next(), a1.next()];
    expect([a2.next(), a2.next(), a2.next()]).toEqual(seqA1);
    expect([b.next(), b.next(), b.next()]).not.toEqual(seqA1);
  });
});
