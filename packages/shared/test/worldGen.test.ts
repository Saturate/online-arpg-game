import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTunables,
  currentWorldGen,
  freshWorld,
  GameMap,
  isWorldGenValues,
  loadMap,
  mapKey,
  maxHubRadius,
  parseTunablePatch,
  planChecksum,
  resetTunables,
  resolveWorldGen,
  Simulation,
  TUNABLES,
  tunableSetProblem,
  WORLD_GEN_DEFAULTS,
  WORLD_GEN_KEYS,
  WORLD_GEN_SPECS,
  WORLD_WAYPOINT_IDS,
  worldGenHash,
  worldGenKey,
  worldGenProblem,
  type MapDescriptor,
  type WorldGenKey,
  type WorldGenValues,
} from '../src/index.js';
import { reachableCells } from '../src/world/zoneGen.js';

afterEach(() => resetTunables());

declare const performance: { now(): number };

/**
 * Generous against the 10 to 30 ms a build takes on a development Mac (world-map.md, "Generation
 * settings"), so a slow CI runner does not fail it; a range that let builds run away would still.
 */
const BUILD_BUDGET_MS = 400;

/** One number at an edge of its range, with the numbers a rule ties it to moved just enough to allow it. */
function atEdge(key: WorldGenKey, v: number): WorldGenValues {
  const gen: WorldGenValues = { [key]: v };
  const d = WORLD_GEN_DEFAULTS;
  if (key === 'size') gen.hubRadius = Math.min(d.hubRadius, maxHubRadius(v));
  if (key === 'hubRadius' && v > maxHubRadius(d.size)) gen.size = WORLD_GEN_SPECS.size.max;
  if (key === 'levelMin' && v > d.levelMax) gen.levelMax = v;
  if (key === 'levelMax' && v < d.levelMin) gen.levelMin = v;
  if (key === 'branchStepsMin' && v > d.branchStepsMax) gen.branchStepsMax = v;
  if (key === 'branchStepsMax' && v < d.branchStepsMin) gen.branchStepsMin = v;
  return gen;
}

const edges = (pick: 'min' | 'max'): WorldGenValues => {
  const out: WorldGenValues = {};
  for (const k of WORLD_GEN_KEYS) out[k] = WORLD_GEN_SPECS[k][pick];
  return out;
};

const CASES: [string, WorldGenValues][] = [
  ...WORLD_GEN_KEYS.flatMap((k): [string, WorldGenValues][] => [
    [`${k} at its least`, atEdge(k, WORLD_GEN_SPECS[k].min)],
    [`${k} at its most`, atEdge(k, WORLD_GEN_SPECS[k].max)],
  ]),
  ['every number at its most', { ...edges('max'), hubRadius: Math.min(WORLD_GEN_SPECS.hubRadius.max, maxHubRadius(WORLD_GEN_SPECS.size.max)) }],
  ['every number at its least', edges('min')],
  ['the smallest world, densest', { size: WORLD_GEN_SPECS.size.min, hubRadius: maxHubRadius(WORLD_GEN_SPECS.size.min), packs: 450, forests: 100, looseRocks: 1100, bones: 700, ridges: 50, campsHome: 10, campsRegion: 10, dungeonsHome: 3, dungeonsRegion: 4, ruinsHome: 4, ruinsRegion: 4 }],
  ['the biggest world, longest roads', { size: WORLD_GEN_SPECS.size.max, branchStepsMin: 8, branchStepsMax: 10, midForks: 3, sideValleyChance: 1, trunkWander: 0.4, branchWander: 0.5 }],
];

describe('world generation numbers', () => {
  it('holds every default inside its range and passes every rule', () => {
    for (const k of WORLD_GEN_KEYS) {
      const s = WORLD_GEN_SPECS[k];
      expect(WORLD_GEN_DEFAULTS[k], k).toBeGreaterThanOrEqual(s.min);
      expect(WORLD_GEN_DEFAULTS[k], k).toBeLessThanOrEqual(s.max);
    }
    expect(worldGenProblem(WORLD_GEN_DEFAULTS)).toBeNull();
    expect(worldGenKey({})).toBe('');
    expect(worldGenHash({})).toBe('');
  });

  it('resolves only numbers in range and puts back both sides of a broken rule', () => {
    expect(resolveWorldGen({ packs: 300, size: 99999, nonsense: 4, forests: 1.5 })).toEqual({ ...WORLD_GEN_DEFAULTS, packs: 300 });
    expect(resolveWorldGen({ levelMin: 30, levelMax: 20 })).toEqual(WORLD_GEN_DEFAULTS);
    expect(resolveWorldGen({ size: 11000, hubRadius: 3000 })).toEqual(WORLD_GEN_DEFAULTS);
    expect(resolveWorldGen('not an object')).toEqual(WORLD_GEN_DEFAULTS);
    expect(isWorldGenValues({ packs: 300 })).toBe(true);
    expect(isWorldGenValues({ packs: 9999 })).toBe(false);
    expect(isWorldGenValues({ unknown: 1 })).toBe(false);
  });

  it('is a live tuning category whose saved set must pass the rules, and is what new copies take', () => {
    const specs = TUNABLES.filter((t) => t.category === 'worldgen');
    expect(specs.map((s) => s.path)).toEqual(WORLD_GEN_KEYS.map((k) => `worldgen.${k}`));
    for (const k of WORLD_GEN_KEYS) expect(specs.find((s) => s.path === `worldgen.${k}`)?.default, k).toBe(WORLD_GEN_DEFAULTS[k]);
    expect(parseTunablePatch({ 'worldgen.size': 20000 })).toMatch(/must be 11000 to 16000/);
    expect(parseTunablePatch({ 'worldgen.packs': 10.5 })).toMatch(/whole number/);
    expect(tunableSetProblem({ 'worldgen.levelMin': 30, 'worldgen.levelMax': 20 })).toMatch(/level at the town gates/);
    expect(tunableSetProblem({ 'worldgen.branchStepsMin': 7 })).toMatch(/shortest branch/);
    expect(tunableSetProblem({ 'worldgen.size': 11000 })).toMatch(/home region of 2400/);
    expect(tunableSetProblem({ 'worldgen.size': 11000, 'worldgen.hubRadius': 1850 })).toBeNull();
    applyTunables({ 'worldgen.packs': 300, 'worldgen.levelCurve': 2 });
    expect(currentWorldGen()).toEqual({ packs: 300, levelCurve: 2 });
    resetTunables();
    expect(currentWorldGen()).toEqual({});
  });

  it.each(CASES)('generates a whole, reachable world in budget with %s', (_name, gen) => {
    const full = resolveWorldGen(gen);
    // The case is what it says: nothing in it was put back for breaking a range or a rule.
    for (const k of WORLD_GEN_KEYS) if (gen[k] !== undefined) expect(full[k], k).toBe(gen[k]);
    expect(worldGenProblem(full)).toBeNull();
    for (const seed of [3, 904226]) {
      const t0 = performance.now();
      const { zone, plan } = freshWorld(seed, undefined, undefined, gen);
      const built = performance.now() - t0;
      expect(built, `${seed} build ms`).toBeLessThan(BUILD_BUDGET_MS);
      const def = zone.whole();
      expect(def.width).toBe(full.size);
      expect([...(def.waypoints ?? []).map((w) => w.id)].sort(), `${seed} waypoints`).toEqual([...WORLD_WAYPOINT_IDS].sort());
      expect(def.gates?.length, `${seed} gates`).toBe(3);
      expect(new Set(plan.spots.filter((s) => s.kind === 'boss').map((s) => s.region)).size, `${seed} a boss in every region`).toBe(6);
      const gm = new GameMap(def);
      const seen = reachableCells(gm, def.spawn.x, def.spawn.y);
      const open = (x: number, y: number): boolean => seen[gm.navCell(x, y)] === 1;
      /**
       * A road can cross a river at a slant beside its bridge, through water past the gap cut for the
       * bridge (8 edges over 85 seeds on the default numbers); walking it goes round over the bridge.
       * So every stretch of road must be reachable within a bridge's reach of it, not on the dot.
       */
      const near = (x: number, y: number): boolean => {
        for (let dy = -120; dy <= 120; dy += 40) for (let dx = -120; dx <= 120; dx += 40) if (open(x + dx, y + dy)) return true;
        return false;
      };
      for (const p of def.portals) expect(open(p.x, p.y), `${seed} ${p.label}`).toBe(true);
      for (const c of def.chests ?? []) expect(open(c.x, c.y), `${seed} chest`).toBe(true);
      for (const e of plan.edges) for (const t of [0.25, 0.5, 0.75]) expect(near(e.ax + (e.bx - e.ax) * t, e.ay + (e.by - e.ay) * t), `${seed} road ${e.a}-${e.b} at ${t}`).toBe(true);
      const levels = plan.nodes.filter((n) => n.road >= 0).map((n) => plan.levelAt(n.x, n.y));
      expect(Math.min(...levels), `${seed} level at the gates`).toBe(full.levelMin);
      expect(Math.max(...levels), `${seed} level at the far ends`).toBe(full.levelMax);
      expect(def.packs.length, `${seed} packs`).toBeLessThanOrEqual(full.packs + 120);
    }
  });
});

describe('a world copy on its own numbers', () => {
  const gen: WorldGenValues = { size: 14500, hubRadius: 2700, packs: 320, branchStepsMax: 8, midForks: 2, trunkWander: 0.25, levelMax: 35, levelCurve: 1.6, campsRegion: 6, rareShare: 0.7 };
  const desc: MapDescriptor = { kind: 'world', seed: 811, gen };

  it('builds the same map on the server and on a client from the descriptor', () => {
    const server = loadMap(desc);
    // A client builds its own from the welcome's descriptor, never sharing the server's objects.
    const client = freshWorld(811, undefined, undefined, JSON.parse(JSON.stringify(gen)));
    const serverPlan = server.zone?.plan;
    if (!serverPlan) throw new Error('no plan');
    expect(planChecksum(client.plan)).toBe(planChecksum(serverPlan));
    expect(JSON.stringify(client.zone.whole())).toBe(JSON.stringify(server.zone?.whole()));
    const sim = new Simulation(5, desc);
    expect(sim.zone?.plan?.gen).toEqual(resolveWorldGen(gen));
    expect(sim.mapDef.width).toBe(14500);
  });

  it('keeps it apart from the default world in the map cache', () => {
    expect(mapKey(desc)).not.toBe(mapKey({ kind: 'world', seed: 811 }));
    expect(mapKey({ kind: 'world', seed: 811, gen: {} })).toBe(mapKey({ kind: 'world', seed: 811 }));
    expect(loadMap(desc)).not.toBe(loadMap({ kind: 'world', seed: 811 }));
  });

  it('changes the plan checksum with every number, levels and counts too', () => {
    const base = planChecksum(freshWorld(3).plan);
    // The default world hashes as it did before the numbers existed.
    expect(base).toBe('6ad71b81');
    for (const k of WORLD_GEN_KEYS) {
      const s = WORLD_GEN_SPECS[k];
      const d = WORLD_GEN_DEFAULTS[k];
      const v = d + (s.int ? 1 : (s.max - s.min) / 10) <= s.max ? d + (s.int ? 1 : (s.max - s.min) / 10) : d - (s.int ? 1 : (s.max - s.min) / 10);
      const changed = atEdge(k, v);
      const a = planChecksum(freshWorld(3, undefined, undefined, changed).plan);
      expect(a, k).not.toBe(base);
      expect(planChecksum(freshWorld(3, undefined, undefined, changed).plan), k).toBe(a);
    }
  });
});
