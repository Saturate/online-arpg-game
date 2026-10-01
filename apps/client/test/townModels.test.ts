import { readFileSync } from 'node:fs';
import { DEFAULT_TOWN_LAYOUT, layoutToMap, loadMap, lookHash, pickHouseModel, validateLayout, type Obstacle, type TownLayout, type WorldMap } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { keepModel } from '../src/game/townEditor.js';
import { houseModel, lookSeed, pillarModel, stallCloth } from '../src/render/props.js';

const liveRaw: unknown = JSON.parse(readFileSync(new URL('../../../packages/shared/test/fixtures/town-layout-live.json', import.meta.url), 'utf8'));
const live = validateLayout(liveRaw, { unknownDecor: 'drop' });
if (!live) throw new Error('the live town fixture must validate');

const TOWNS: [string, TownLayout][] = [
  ['default town', DEFAULT_TOWN_LAYOUT],
  ['live town', live],
];

/** The renderer's pick at the commit before the world (69b8bbf^), copied as it was, for a town at the origin. */
function oldHash(x: number, y: number): number {
  return Math.abs(Math.floor(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453)) % 1000;
}
const OLD_BUILDINGS = ['building_home_A_red', 'building_home_B_red', 'building_home_A_blue', 'building_home_B_yellow', 'building_tavern_red', 'building_blacksmith_blue'];
function oldPick(o: Obstacle): string | null {
  if (o.kind === 'pillar' && o.shape.type === 'circle') {
    const h = oldHash(o.shape.x, o.shape.y);
    return h % 3 === 0 ? 'dungeon_column' : h % 3 === 1 ? 'dungeon_pillar' : 'dungeon_pillar_decorated';
  }
  if (o.kind === 'house' && o.shape.type === 'box') {
    const k = oldHash(o.shape.x, o.shape.y);
    const small = Math.max(o.shape.hw, o.shape.hh) < 100;
    return small ? (k % 2 === 0 ? 'building_home_B_red' : 'building_home_B_yellow') : (OLD_BUILDINGS[k % OLD_BUILDINGS.length] ?? 'building_home_A_red');
  }
  return null;
}

const picked = (o: Obstacle): string | null => houseModel(o) ?? pillarModel(o);

/** The old cloth colour of a stall, from `stall()` at 69b8bbf^. */
const OLD_CLOTHS = [0xc0392b, 0x2e86c1, 0xd4ac0d, 0x7d3c98];

/** A town's pieces of these kinds in a map, in layout order (ruins out in the world have pillars too). */
function townPieces(def: WorldMap, kinds: readonly Obstacle['kind'][] = ['house', 'pillar']): Obstacle[] {
  const rect = def.safeZones?.[0] ?? { x: 0, y: 0, w: def.width, h: def.height };
  return def.obstacles.filter((o) => {
    if (!kinds.includes(o.kind)) return false;
    if (o.shape.type === 'capsule') return false;
    return o.shape.x >= rect.x && o.shape.x <= rect.x + rect.w && o.shape.y >= rect.y && o.shape.y <= rect.y + rect.h;
  });
}

/** The pre-world hash of a piece: its position with the town at the origin. */
function oldSeed(o: Obstacle, at: { x: number; y: number }): number {
  return o.shape.type === 'capsule' ? -1 : oldHash(o.shape.x - at.x, o.shape.y - at.y);
}

describe('town house and pillar models', () => {
  for (const [name, layout] of TOWNS) {
    it(`the ${name} in the world picks the models it had before the world, and the editor preview agrees`, () => {
      // The preview draws the town at its own origin, which is where it stood before the world.
      const preview = townPieces(layoutToMap(layout));
      const before = preview.map(oldPick);
      expect(before.length).toBeGreaterThan(0);
      expect(preview.map(picked)).toEqual(before);
      // Two seeds: the town's offset comes from the world and town sizes, not the seed.
      for (const seed of [3, 904226]) {
        const def = loadMap({ kind: 'world', seed, layout }).def;
        const at = def.townAt;
        expect(at).toBeDefined();
        const inWorld = townPieces(def);
        expect(inWorld.map(picked)).toEqual(before);
        // The world position alone would pick other models for some of them.
        const byWorld = inWorld.map((o) => (o.shape.type === 'box' ? pickHouseModel(lookHash(o.shape.x, o.shape.y), o.shape.hw, o.shape.hh) : null));
        if (name === 'default town') expect(byWorld.filter((m, i) => m !== null && m !== before[i]).length).toBeGreaterThan(0);
      }
    });
  }

  for (const [name, layout] of TOWNS) {
    it(`the ${name}'s trees, rocks and stalls vary by the town position as before the world: tree shapes, cloth colours`, () => {
      const KINDS = ['tree', 'rock', 'stall'] as const;
      const preview = townPieces(layoutToMap(layout), KINDS);
      const before = preview.map((o) => oldSeed(o, { x: 0, y: 0 }));
      expect(preview.filter((o) => o.kind === 'tree').length).toBeGreaterThan(0);
      expect(preview.filter((o) => o.kind === 'stall').length).toBeGreaterThan(0);
      expect(preview.map(lookSeed)).toEqual(before);
      const oldCloths = preview.filter((o) => o.kind === 'stall').map((o) => OLD_CLOTHS[oldSeed(o, { x: 0, y: 0 }) % OLD_CLOTHS.length]);
      expect(preview.filter((o) => o.kind === 'stall').map(stallCloth)).toEqual(oldCloths);
      const def = loadMap({ kind: 'world', seed: 3, layout }).def;
      const at = def.townAt ?? { x: 0, y: 0 };
      const inWorld = townPieces(def, KINDS);
      expect(inWorld.map(lookSeed)).toEqual(before);
      expect(inWorld.map((o) => oldSeed(o, at))).toEqual(before);
      expect(inWorld.filter((o) => o.kind === 'stall').map(stallCloth)).toEqual(oldCloths);
      // The world position would have given other hashes.
      expect(inWorld.filter((o) => o.shape.type !== 'capsule' && oldHash(o.shape.x, o.shape.y) !== lookSeed(o)).length).toBeGreaterThan(0);
    });
  }

  it('trees out in the world keep the hash of their world position', () => {
    const def = loadMap({ kind: 'world', seed: 3 }).def;
    const rect = def.safeZones?.[0];
    if (!rect) throw new Error('the world has a town');
    const outside = def.obstacles.filter((o) => (o.kind === 'tree' || o.kind === 'rock') && o.shape.type === 'circle' && (o.shape.x < rect.x || o.shape.y < rect.y || o.shape.x > rect.x + rect.w || o.shape.y > rect.y + rect.h));
    expect(outside.length).toBeGreaterThan(0);
    for (const o of outside) if (o.shape.type === 'circle') expect(lookSeed(o)).toBe(oldHash(o.shape.x, o.shape.y));
  });

  it('a house moved in the editor keeps its model; without keeping it the move would change it', () => {
    const layout = structuredClone(DEFAULT_TOWN_LAYOUT);
    const i = layout.props.findIndex((p) => p.kind === 'house');
    const house = layout.props[i];
    if (!house) throw new Error('the default town has houses');
    const modelOf = (l: TownLayout): string | null => {
      const o = townPieces(layoutToMap(l)).find((p) => p.shape.type === 'box' && Math.abs(p.shape.x - (l.props[i]?.x ?? 0)) < 0.01 && Math.abs(p.shape.y - (l.props[i]?.y ?? 0)) < 0.01);
      return o ? picked(o) : null;
    };
    const was = modelOf(layout);
    const moved = structuredClone(layout);
    const m = moved.props[i];
    if (!m) throw new Error('the house is there');
    // Offsets the town-local pick changes model for, so the test shows keepModel doing the work.
    let dx = 20;
    for (; dx < 2000; dx += 20) {
      m.x = house.x + dx;
      if (modelOf(moved) !== was) break;
    }
    expect(modelOf(moved)).not.toBe(was);
    m.x = house.x;
    keepModel(m);
    m.x = house.x + dx;
    m.angle += 1;
    m.scale = 1.4;
    expect(m.model).toBe(was);
    expect(modelOf(moved)).toBe(was);
    // And a stored model survives the server's check and the world view.
    const saved = validateLayout(JSON.parse(JSON.stringify(moved)));
    expect(saved?.props[i]?.model).toBe(was);
    if (!saved) throw new Error('the moved layout validates');
    expect(modelOf(saved)).toBe(was);
  });
});
