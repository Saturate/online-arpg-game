import { describe, expect, it } from 'vitest';
import { buildMap, GameMap, HOME_ZONE, Rng, scaledZone, Simulation, STREAMING, WILDS, ZONE_IDS, ZONE_SIZE, type EntityId, type MapDescriptor, type Obstacle, type WorldMap, type ZoneId } from '../src/index.js';
import { reachableCells, SPILL } from '../src/world/zoneGen.js';
import { spawnEverywhere, streamingStats, updateStreaming } from '../src/sim/streaming.js';

function fnv(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

const SEEDS = [1, 42, 9001];

/** A zone generated afresh, every chunk still ungenerated. */
function fresh(zone: ZoneId, seed: number) {
  return scaledZone(zone, seed, 1);
}

function centre(o: Obstacle): { x: number; y: number } {
  return o.shape.type === 'capsule' ? { x: (o.shape.ax + o.shape.bx) / 2, y: (o.shape.ay + o.shape.by) / 2 } : o.shape;
}

describe('zone plan', () => {
  it('rivers, bridges, the road and the ridges are where the whole-zone generator put them', () => {
    // Taken with the generator before step 3 (HEAD 366b5c0): these draw from the seed's main stream
    // in the same order, so they must not move.
    const before: Record<string, [string, string, number, string]> = {
      'barrens:1': ['12dfag0', '1q5iyom', 22, '17sq14g'],
      'barrens:9001': ['1jqd66o', '1ade7sn', 25, 'y49ojr'],
      'steppe:1': ['dzc2yx', '1tiuxu2', 17, '1tytbfk'],
      'thornwood:42': ['skq0vw', '1rgm7cu', 14, '1ptiwzl'],
      'hollows:9001': ['a24n75', 'qn5ts3', 18, '3jfqn3'],
    };
    for (const [key, [rivers, roads, ridgeCount, ridges]] of Object.entries(before)) {
      const [zone, seed] = key.split(':');
      const def = buildMap({ kind: 'zone', zone: ZONE_IDS.find((z) => z === zone) ?? HOME_ZONE, seed: Number(seed) });
      const plan = fresh(ZONE_IDS.find((z) => z === zone) ?? HOME_ZONE, Number(seed)).def;
      expect(fnv(JSON.stringify([def.rivers, def.bridges])), key).toBe(rivers);
      expect(fnv(JSON.stringify(def.ground.filter((g) => g.kind === 'road'))), key).toBe(roads);
      const ridgeRocks = plan.obstacles.filter((o) => o.kind === 'rock');
      expect(ridgeRocks.length, key).toBe(ridgeCount);
      expect(fnv(JSON.stringify(ridgeRocks)), key).toBe(ridges);
    }
  });

  it('carries no chunk content and no packs, and the home zone carries the town whole', () => {
    const { def, zone } = fresh(HOME_ZONE, 7);
    expect(def.packs).toEqual([]);
    const town = def.safeZones?.[0];
    if (!town) throw new Error('no town');
    // No tree or loose rock outside the town: those are chunk content. Ridge rocks are the plan's.
    expect(def.obstacles.some((o) => o.kind === 'tree' && o.shape.type === 'circle' && o.shape.x > town.x + town.w)).toBe(false);
    expect(zone.generatedChunks).toBe(0);
    // Every town obstacle is in the plan, in the town's own order.
    const planJson = def.obstacles.map((o) => JSON.stringify(o));
    const townJson = buildMap({ kind: 'town' }).obstacles.map((o) => JSON.stringify(o));
    const start = planJson.indexOf(townJson[0] ?? '');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(planJson.slice(start, start + townJson.length)).toEqual(townJson);
  });

  it('is the same for the same seed and differs between seeds', () => {
    for (const id of ZONE_IDS) {
      const a = fresh(id, 42).zone.whole();
      const b = fresh(id, 42).zone.whole();
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(JSON.stringify(fresh(id, 43).zone.whole().obstacles)).not.toBe(JSON.stringify(a.obstacles));
    }
  });
});

describe('zone chunks', () => {
  it('a chunk generated alone is exactly that chunk of a whole-zone build', () => {
    for (const id of [HOME_ZONE, 'steppe', 'hollows'] as const) {
      for (const seed of [1, 9001]) {
        const whole = fresh(id, seed).zone;
        whole.whole();
        for (let cy = 0; cy < whole.rows; cy++) {
          for (let cx = 0; cx < whole.cols; cx++) {
            const alone = fresh(id, seed).zone;
            // Packs first: they read the obstacles around and the packs of earlier phases.
            expect(alone.packs(cx, cy), `${id}/${seed} packs ${cx},${cy}`).toEqual(whole.packs(cx, cy));
            expect(alone.obstacles(cx, cy), `${id}/${seed} obstacles ${cx},${cy}`).toEqual(whole.obstacles(cx, cy));
            expect(alone.decor(cx, cy), `${id}/${seed} decor ${cx},${cy}`).toEqual(whole.decor(cx, cy));
            // Alone means alone: at most the chunks within 3 of it, for the phases it reads.
            expect(alone.generatedChunks).toBeLessThanOrEqual(49);
          }
        }
      }
    }
  });

  it('a chunk generated in a zone 25 times today\'s reads only a fixed window of chunks around it', () => {
    const big = scaledZone('thornwood', 5, 5).zone;
    const cx = Math.floor(big.cols / 2);
    const cy = Math.floor(big.rows / 2);
    // Obstacles read earlier phases up to 3 chunks out; packs read packs up to 3 out and the
    // obstacles around those, so 7 out at most. Neither depends on the zone's size.
    big.obstacles(cx, cy);
    expect(big.generatedChunks).toBeLessThanOrEqual(7 * 7);
    big.packs(cx, cy);
    expect(big.generatedChunks).toBeLessThanOrEqual(15 * 15);
    expect(big.cols * big.rows).toBeGreaterThan(15 * 15 * 2);
  });

  it('obstacles stay within the spill of their chunk, and keep their spacing across chunk borders', () => {
    for (const id of ['steppe', 'thornwood'] as const) {
      for (const seed of SEEDS) {
        const { zone } = fresh(id, seed);
        const placed: { o: Obstacle; cx: number; cy: number; fit: number }[] = [];
        for (let cy = 0; cy < zone.rows; cy++) {
          for (let cx = 0; cx < zone.cols; cx++) {
            for (const o of zone.obstacles(cx, cy)) {
              const c = centre(o);
              const r = o.shape.type === 'circle' ? o.shape.r : 0;
              expect(c.x + r).toBeLessThanOrEqual((cx + 1) * zone.size + SPILL);
              expect(c.x - r).toBeGreaterThanOrEqual(cx * zone.size - SPILL);
              expect(c.y + r).toBeLessThanOrEqual((cy + 1) * zone.size + SPILL);
              expect(c.y - r).toBeGreaterThanOrEqual(cy * zone.size - SPILL);
              // The radius each was checked with when placed: 24 for a tree, its own for a rock.
              placed.push({ o, cx, cy, fit: o.kind === 'tree' ? 24 : r });
            }
          }
        }
        let across = 0;
        for (let i = 0; i < placed.length; i++) {
          const a = placed[i];
          if (!a) continue;
          for (let j = i + 1; j < placed.length; j++) {
            const b = placed[j];
            if (!b || (a.cx === b.cx && a.cy === b.cy)) continue;
            const ca = centre(a.o);
            const cb = centre(b.o);
            const d = Math.hypot(ca.x - cb.x, ca.y - cb.y);
            if (d > 300) continue;
            across++;
            const ra = a.o.shape.type === 'circle' ? a.o.shape.r : 0;
            const rb = b.o.shape.type === 'circle' ? b.o.shape.r : 0;
            // Whichever came second kept 46 past its fit radius from the first one's edge.
            expect(d, `${id}/${seed} ${a.o.kind} at ${a.cx},${a.cy} and ${b.o.kind} at ${b.cx},${b.cy}`).toBeGreaterThanOrEqual(46 + Math.min(a.fit + rb, b.fit + ra) - 1e-9);
          }
        }
        expect(across).toBeGreaterThan(20);
      }
    }
  });
});

describe('zone packs', () => {
  /** Nav cells reachable from the spawn on the whole map. */
  function reach(def: WorldMap): { gm: GameMap; seen: Uint8Array } {
    const gm = new GameMap(def);
    return { gm, seen: reachableCells(gm, def.spawn.x, def.spawn.y) };
  }

  it('keep the counts of the whole-zone generator, their spacing, and stay reachable', () => {
    for (const id of ZONE_IDS) {
      for (const seed of SEEDS) {
        const def = buildMap({ kind: 'zone', zone: id, seed });
        const scale = (def.width * def.height) / (WILDS.width * WILDS.height);
        const regular = def.packs.filter((p) => !p.boss);
        const camps = (def.camps ?? []).filter((c) => c.guarded).length;
        // Every chunk got its share and found room for it, give or take one.
        expect(regular.length - camps, `${id}/${seed}`).toBeGreaterThanOrEqual(Math.round(WILDS.packs * scale) - 1);
        expect(regular.length - camps, `${id}/${seed}`).toBeLessThanOrEqual(Math.round(WILDS.packs * scale));
        expect(def.packs.filter((p) => p.boss)).toHaveLength(1);
        const { gm, seen } = reach(def);
        for (const p of def.packs) {
          expect(seen[gm.navCell(p.x, p.y)], `${id}/${seed} pack at ${Math.round(p.x)},${Math.round(p.y)} reachable`).toBe(1);
          expect(Math.hypot(p.x - def.spawn.x, p.y - def.spawn.y)).toBeGreaterThanOrEqual(WILDS.safeRadius);
          expect(gm.pointBlocked(p.x, p.y, 20, 'move')).toBe(false);
        }
        // Only the boss stands on another pack (the one it holds the far end over).
        for (const [i, a] of def.packs.entries()) {
          for (const b of def.packs.slice(i + 1)) {
            if (a.boss || b.boss) continue;
            expect(Math.hypot(a.x - b.x, a.y - b.y), `${id}/${seed}`).toBeGreaterThanOrEqual(WILDS.packSpacing);
          }
        }
      }
    }
  });
});

describe('collision and nav built by chunk', () => {
  it('answer every query exactly as the map built whole, whatever order chunks are asked in', () => {
    for (const [id, seed] of [
      [HOME_ZONE, 3],
      ['dunes', 77],
    ] as const) {
      const { zone } = fresh(id, seed);
      const whole = new GameMap(zone.whole());
      const lazy = new GameMap(zone.def, zone);
      expect(lazy.builtChunks).toBe(0);
      const rng = new Rng(seed);
      for (let i = 0; i < 20000; i++) {
        const x = rng.range(-50, whole.width + 50);
        const y = rng.range(-50, whole.height + 50);
        const r = rng.range(4, 70);
        expect(lazy.pointBlocked(x, y, r, 'move')).toBe(whole.pointBlocked(x, y, r, 'move'));
        expect(lazy.pointBlocked(x, y, r, 'shots')).toBe(whole.pointBlocked(x, y, r, 'shots'));
        expect(lazy.resolveCircle({ x, y }, r)).toEqual(whole.resolveCircle({ x, y }, r));
        expect(lazy.speedAt(x, y)).toBe(whole.speedAt(x, y));
        const cx = rng.int(0, whole.navCols - 1);
        const cy = rng.int(0, whole.navRows - 1);
        expect(lazy.isWalkable(cx, cy)).toBe(whole.isWalkable(cx, cy));
        if (i % 10 === 0) {
          const bx = x + rng.range(-600, 600);
          const by = y + rng.range(-600, 600);
          expect(lazy.lineClear(x, y, bx, by, 8, 'shots')).toBe(whole.lineClear(x, y, bx, by, 8, 'shots'));
        }
      }
      lazy.ensureAll();
      expect(Array.from(lazy.walkable)).toEqual(Array.from(whole.walkable));
    }
  });
});

describe('a room over a zone generated by chunk', () => {
  /** A descriptor nothing else in this file loads, so its chunks start ungenerated. */
  const desc = (zone: ZoneId, seed: number): MapDescriptor => ({ kind: 'zone', zone, seed });

  it('builds no chunk when created, and only the chunks near its players when they arrive', () => {
    const old = { ...ZONE_SIZE };
    // A zone 25 times today's; loadMap caches by descriptor, so the seed is used nowhere else.
    Object.assign(ZONE_SIZE, { width: old.width * 5, height: old.height * 5 });
    try {
      const sim = new Simulation(1, desc('thornwood', 424242));
      const zone = sim.zone;
      if (!zone) throw new Error('not a generated zone');
      expect(zone.generatedChunks).toBe(0);
      expect(sim.map.builtChunks).toBe(0);
      expect(sim.world.enemy.size).toBe(0);
      sim.addPlayer('p', 'mage');
      sim.step();
      const total = zone.cols * zone.rows;
      const stats = streamingStats(sim);
      expect(stats.spawnedChunks).toBe(stats.awakeChunks);
      // Awake: within 2000 of the player. Built: what anything asked about, the flow field's
      // search (90 nav cells, 3600 units) the farthest. Generated: those and what they read.
      expect(stats.spawnedChunks).toBeLessThanOrEqual(5 * 5);
      expect(sim.map.builtChunks).toBeLessThanOrEqual(10 * 10);
      expect(zone.generatedChunks).toBeLessThan(total / 2);
      // Every monster stands in or next to a chunk that has woken.
      for (const id of sim.world.enemy.keys()) {
        const p = sim.world.position.get(id);
        if (p) expect(Math.hypot(p.x - sim.mapDef.spawn.x, p.y - sim.mapDef.spawn.y)).toBeLessThan(STREAMING.awakeChunks * STREAMING.chunkSize * 2);
      }
    } finally {
      Object.assign(ZONE_SIZE, old);
    }
  });

  it('a chunk spawns the same monsters whenever it first wakes, as all at once did', () => {
    const d = desc('gloomvale', 515151);
    const key = (sim: Simulation, id: EntityId): string => {
      const e = sim.world.enemy.get(id);
      const q = sim.world.position.get(id);
      const h = sim.world.health.get(id);
      return JSON.stringify([e?.typeId, e?.level, e?.rare, e?.boss, e?.affixes, e?.facing, e?.cooldowns, q?.x, q?.y, h?.maxLife]);
    };
    const all = new Simulation(8, d);
    spawnEverywhere(all);
    const everything = [...all.world.enemy.keys()].map((id) => key(all, id)).sort();

    // The streaming system alone, so the monsters are compared as they spawned, before they act.
    const lazy = new Simulation(8, d);
    const pid = lazy.addPlayer('p', 'warrior');
    updateStreaming(lazy);
    const nearSpawn = lazy.world.enemy.size;
    const first = streamingStats(lazy).spawnedChunks;
    expect(nearSpawn).toBeGreaterThan(0);
    expect(first).toBeLessThan(streamingStats(lazy).chunks);
    // A jump to the far corner wakes the chunks there on the spot.
    const pos = lazy.world.position.get(pid);
    if (!pos) throw new Error('no player');
    pos.x = lazy.map.width - 400;
    pos.y = lazy.map.height - 400;
    updateStreaming(lazy);
    expect(streamingStats(lazy).spawnedChunks).toBeGreaterThan(first);
    expect(lazy.world.enemy.size).toBeGreaterThan(nearSpawn);
    const set = new Set(everything);
    for (const id of lazy.world.enemy.keys()) expect(set.has(key(lazy, id)), `monster ${id}`).toBe(true);
    // And the rest: in the end the zone holds exactly the monsters the whole-zone spawn held.
    spawnEverywhere(lazy);
    expect([...lazy.world.enemy.keys()].map((id) => key(lazy, id)).sort()).toEqual(everything);
  });
});
