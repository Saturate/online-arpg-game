import { describe, expect, it } from 'vitest';
import { DEFAULT_TOWN_LAYOUT, freshWorld, GameMap, layoutHash, layoutToMap, loadMap, SIM, Simulation, TOWN_WAYPOINT, waypointArrival, WILDS, WORLD, ZONES, type MapDescriptor, type WorldMap } from '../src/index.js';
import { dealDamage, inSafeZone, isTargetable } from '../src/sim/combat.js';
import { chestKey, openedChests } from '../src/sim/chests.js';
import { spawnEnemy } from '../src/sim/enemies.js';
import { placeTown, townExits } from '../src/world/worldMap.js';
import { HOME_REGION, isWaypointId, WorldPlan, type WorldNode } from '../src/world/worldPlan.js';
import { reachableCells } from '../src/world/zoneGen.js';

const SEEDS = [1, 42, 9001];
const world = (seed: number): Extract<MapDescriptor, { kind: 'world' }> => ({ kind: 'world', seed });

function reach(def: WorldMap): { gm: GameMap; seen: Uint8Array } {
  const gm = new GameMap(def);
  return { gm, seen: reachableCells(gm, def.spawn.x, def.spawn.y) };
}

/** The chain of nodes from the town to `n`, town first. */
function chain(plan: WorldPlan, n: WorldNode): WorldNode[] {
  const out: WorldNode[] = [];
  for (let at: WorldNode | undefined = n; at; at = at.parent === null ? undefined : plan.node(at.parent)) out.push(at);
  return out.reverse();
}

describe('world plan', () => {
  it('is the same for the same seed and differs between seeds', () => {
    const a = freshWorld(42).plan;
    const b = freshWorld(42).plan;
    expect(JSON.stringify([a.nodes, a.edges, a.spots, a.waypoints, a.gates])).toBe(JSON.stringify([b.nodes, b.edges, b.spots, b.waypoints, b.gates]));
    expect(JSON.stringify(freshWorld(43).plan.edges)).not.toBe(JSON.stringify(a.edges));
  });

  it('has three roads, each from its own town gate into its own third of the circle', () => {
    for (const seed of SEEDS) {
      const plan = freshWorld(seed).plan;
      expect(plan.roads).toHaveLength(3);
      expect(new Set(plan.roads.map((r) => r.side)).size).toBe(3);
      const angles = plan.roads.map((r) => r.angle);
      for (let i = 0; i < 3; i++) {
        const d = Math.abs((((angles[(i + 1) % 3] ?? 0) - (angles[i] ?? 0) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        expect(d, `${seed} sectors apart`).toBeCloseTo((Math.PI * 2) / 3, 5);
      }
      for (const [k, road] of plan.roads.entries()) {
        const nodes = plan.nodes.filter((n) => n.road === k);
        // Each road branches: more than a trunk, with forks and dead ends.
        expect(nodes.filter((n) => n.children.length >= 2).length, `${seed} road ${k} forks`).toBeGreaterThanOrEqual(2);
        expect(nodes.filter((n) => n.children.length === 0).length, `${seed} road ${k} ends`).toBeGreaterThanOrEqual(4);
        for (const n of nodes) {
          if (Math.hypot(n.x - plan.centre.x, n.y - plan.centre.y) < WORLD.hubRadius) continue;
          const a = Math.atan2(n.y - plan.centre.y, n.x - plan.centre.x);
          const off = Math.abs(((a - road.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          expect(off, `${seed} road ${k} node ${n.id} in its sector`).toBeLessThanOrEqual(WORLD.sectorHalf);
        }
      }
    }
  });

  it('levels rise with distance from town, along every road and from region to region', () => {
    for (const seed of SEEDS) {
      const plan = freshWorld(seed).plan;
      for (const end of plan.nodes.filter((n) => n.children.length === 0 && n.parent !== null)) {
        const levels = chain(plan, end).map((n) => plan.levelAt(n.x, n.y));
        for (let i = 1; i < levels.length; i++) expect(levels[i] ?? 0, `${seed} toward node ${end.id}`).toBeGreaterThanOrEqual(levels[i - 1] ?? 0);
      }
      expect(plan.levelAt(plan.town.x + plan.town.w + 50, plan.town.y + plan.town.h / 2)).toBe(WORLD.levels[0]);
      // Every road's far end is the hardest, however far its sector lets it run.
      for (const k of [0, 1, 2]) expect(Math.max(...plan.nodes.filter((n) => n.road === k).map((n) => plan.levelAt(n.x, n.y))), `${seed} road ${k}`).toBe(WORLD.levels[1]);
      const home = plan.regions.get(HOME_REGION);
      for (const r of plan.roads) {
        const [inner, outer] = r.regions.map((id) => plan.regions.get(id));
        expect(inner?.levels[0] ?? 0, `${seed} ${inner?.id} starts past the home region`).toBeGreaterThanOrEqual(home?.levels[0] ?? 99);
        if (outer && inner && outer !== inner) expect(outer.levels[0], `${seed} ${outer.id} after ${inner.id}`).toBeGreaterThan(inner.levels[0]);
      }
      // Further out, packs come more often and bigger.
      const near = { x: plan.town.x + plan.town.w + 900, y: plan.town.y + plan.town.h / 2 };
      const far = plan.nodes.reduce((a, b) => (b.depth > a.depth ? b : a));
      expect(plan.packWeight(far.x, far.y)).toBeGreaterThan(plan.packWeight(near.x, near.y));
      expect(plan.packScale(far.x, far.y)).toBeGreaterThan(plan.packScale(near.x, near.y));
    }
  });

  it('gives every region a waypoint, a boss and a dungeon, marks a gate on every road, and names waypoints by id', () => {
    for (const seed of SEEDS) {
      const plan = freshWorld(seed).plan;
      expect(plan.regions.size).toBe(6);
      for (const id of plan.regions.keys()) {
        expect(plan.spots.filter((s) => s.region === id && s.kind === 'boss'), `${seed} ${id} boss`).toHaveLength(1);
        expect(plan.spots.some((s) => s.region === id && s.kind === 'dungeon'), `${seed} ${id} dungeon`).toBe(true);
        if (id !== HOME_REGION) expect(plan.waypoints.some((w) => w.region === id), `${seed} ${id} waypoint`).toBe(true);
      }
      expect(plan.gates).toHaveLength(3);
      for (const g of plan.gates) {
        // Everything past a gate is marked behind it, for the gate bosses to come.
        const beyond = plan.nodes.filter((n) => n.road === g.road && n.depth > (plan.node(g.node)?.depth ?? 0) && n.trunk);
        expect(beyond.length).toBeGreaterThan(0);
        for (const n of beyond) expect(n.behind).toBe(g.id);
      }
      expect(plan.spots.some((s) => s.kind === 'rare') || plan.spots.some((s) => s.kind === 'chest')).toBe(true);
      for (const w of plan.waypoints) expect(isWaypointId(w.id), w.id).toBe(true);
    }
    // Ids of the zones before the world still read as waypoint ids, so saves keep them.
    for (const id of Object.keys(ZONES)) expect(isWaypointId(id)).toBe(true);
    expect(isWaypointId('../etc')).toBe(false);
  });
});

describe('world map', () => {
  it('holds the town byte for byte, moved to the middle, and its gates are the roads out', () => {
    // The pins of the live town (apps/server/test/townDecor.test.ts) are of `layoutToMap`, which the world only moves.
    const town = layoutToMap(DEFAULT_TOWN_LAYOUT);
    const { def } = loadMap(world(5));
    const at = def.townAt;
    if (!at) throw new Error('no town');
    expect(Math.abs(at.x + town.width / 2 - def.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(at.y + town.height / 2 - def.height / 2)).toBeLessThanOrEqual(1);
    const moved = placeTown(town, at);
    const json = def.obstacles.map((o) => JSON.stringify(o));
    const first = json.indexOf(JSON.stringify(moved.obstacles[0]));
    expect(json.slice(first, first + moved.obstacles.length)).toEqual(moved.obstacles.map((o) => JSON.stringify(o)));
    expect(def.stash).toEqual(moved.stash);
    expect(def.forge).toEqual(moved.forge);
    expect(def.spawn).toEqual(moved.spawn);
    expect(def.portals.some((p) => p.target === 'wilds')).toBe(false);
    expect(def.portals.some((p) => p.target === 'arena')).toBe(true);
    expect(layoutHash(DEFAULT_TOWN_LAYOUT)).toBe(layoutHash(JSON.parse(JSON.stringify(DEFAULT_TOWN_LAYOUT))));
    // The default town's gates, north, east and south, are where the roads leave.
    expect(townExits(DEFAULT_TOWN_LAYOUT, town).map((e) => e.side)).toEqual(['north', 'east', 'south']);
  });

  it('reaches every region, waypoint, dungeon, camp and chest from the town', () => {
    for (const seed of SEEDS) {
      const { zone, plan } = freshWorld(seed);
      const def = zone.whole();
      const { gm, seen } = reach(def);
      const open = (x: number, y: number): boolean => seen[gm.navCell(x, y)] === 1;
      for (const p of def.portals) expect(open(p.x, p.y), `${seed} ${p.label}`).toBe(true);
      for (const c of def.camps ?? []) expect(open(c.x, c.y), `${seed} camp`).toBe(true);
      for (const c of def.chests ?? []) expect(open(c.x, c.y), `${seed} chest`).toBe(true);
      // Every road is walkable end to end: the middle of every edge is reachable.
      for (const e of plan.edges) expect(open((e.ax + e.bx) / 2, (e.ay + e.by) / 2), `${seed} road ${e.a}-${e.b}`).toBe(true);
      const regions = new Set(def.packs.map((p) => plan.regionAt(p.x, p.y)));
      expect(regions.size, `${seed} packs in every region`).toBe(6);
      // On the built map, not only in the plan: placing one can fail where its dead end has no room.
      const dungeons = new Set(def.portals.filter((p) => p.target === 'staging').map((p) => plan.regionAt(p.x, p.y)));
      expect(dungeons.size, `${seed} a dungeon in every region`).toBe(6);
      expect(def.waypoints?.length).toBe(1 + plan.waypoints.length);
    }
  });

  it('keeps packs off the town and puts higher levels further out', () => {
    for (const seed of SEEDS) {
      const { zone, plan } = freshWorld(seed);
      const def = zone.whole();
      const town = def.safeZones?.[0];
      if (!town) throw new Error('no town');
      for (const p of def.packs) {
        const inside = p.x > town.x - WILDS.aggroRadius && p.x < town.x + town.w + WILDS.aggroRadius && p.y > town.y - WILDS.aggroRadius && p.y < town.y + town.h + WILDS.aggroRadius;
        expect(inside, `pack at ${Math.round(p.x)},${Math.round(p.y)}`).toBe(false);
      }
      const mean = (f: (p: (typeof def.packs)[number]) => boolean): number => {
        const list = def.packs.filter((p) => !p.boss && f(p));
        return list.reduce((a, p) => a + p.level, 0) / Math.max(1, list.length);
      };
      const home = mean((p) => plan.regionAt(p.x, p.y) === HOME_REGION);
      for (const r of plan.roads) {
        const inner = mean((p) => plan.regionAt(p.x, p.y) === r.regions[0]);
        expect(inner, `${seed} ${r.regions[0]} over the home region`).toBeGreaterThan(home);
        const outerId = r.regions[1];
        if (outerId) expect(mean((p) => plan.regionAt(p.x, p.y) === outerId), `${seed} ${outerId}`).toBeGreaterThan(inner);
      }
      // Pack sizes grow outward: the far half's packs are bigger on average than the near half's.
      const size = (near: boolean): number => {
        const list = def.packs.filter((p) => !p.boss && plan.progressAt(p.x, p.y) < 0.5 === near);
        return list.reduce((a, p) => a + p.count, 0) / Math.max(1, list.length);
      };
      expect(size(false)).toBeGreaterThan(size(true));
    }
  });

  it('nobody in town can be targeted or hurt, and monsters outside can be', () => {
    const sim = new Simulation(3, world(3));
    const pid = sim.addPlayer('c', 'warrior');
    const pos = sim.world.position.get(pid);
    if (!pos) throw new Error('no player');
    expect(inSafeZone(sim, pos.x, pos.y)).toBe(true);
    expect(isTargetable(sim, pid)).toBe(false);
    const eid = spawnEnemy(sim, 'chaser', pos.x + 40, pos.y, { rare: false, level: 1, aggro: true });
    expect(dealDamage(sim, pid, 50, eid, [])).toBe(0);
    const town = sim.mapDef.safeZones?.[0];
    if (!town) throw new Error('no town');
    // Out past the gate, the same player is fair game.
    sim.world.position.set(pid, { x: town.x + town.w + 400, y: pos.y });
    expect(isTargetable(sim, pid)).toBe(true);
  });

  it('touching a waypoint activates it for the character, and the save keeps it with the old zone ids', () => {
    const sim = new Simulation(4, world(4));
    const pid = sim.addPlayer('c', 'mage', 'Hero', undefined);
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    // A save from before the world, as stage 3's conversion will find it.
    p.waypoints = ['barrens', 'steppe'];
    const wp = sim.mapDef.portals.find((x) => x.target === 'waypoint' && x.waypoint === 'steppe-1');
    if (!wp) throw new Error('no waypoint');
    for (let i = 0; i < 40; i++) sim.step();
    sim.world.position.set(pid, { x: wp.x, y: wp.y });
    sim.step();
    expect(sim.exportPlayer(pid)?.waypoints).toEqual(['barrens', 'steppe', 'steppe-1']);
    expect(sim.portalRequests.some((r) => r.target === 'waypoint' && r.portal.waypoint === 'steppe-1')).toBe(true);
    // The town's is everyone's and never listed.
    const town = sim.mapDef.portals.find((x) => x.waypoint === TOWN_WAYPOINT);
    if (!town) throw new Error('no town waypoint');
    if (p) p.portalCooldown = 0;
    sim.world.position.set(pid, { x: town.x, y: town.y });
    sim.step();
    expect(sim.exportPlayer(pid)?.waypoints).toEqual(['barrens', 'steppe', 'steppe-1']);
  });

  it('a waypoint traveller lands on open ground, off every portal', () => {
    for (const seed of SEEDS) {
      const desc = world(seed);
      const { def, game } = loadMap(desc);
      for (const w of def.waypoints ?? []) {
        const at = waypointArrival(def, game, w.id);
        if (!at) throw new Error(`no arrival at ${w.id}`);
        expect(Math.hypot(at.x - w.x, at.y - w.y)).toBeLessThan(250);
        expect(game.pointBlocked(at.x, at.y, SIM.playerRadius, 'move'), `${seed} ${w.id}`).toBe(false);
        for (const p of def.portals) expect(Math.hypot(p.x - at.x, p.y - at.y), `${seed} ${w.id} lands on ${p.label}`).toBeGreaterThan(p.r);
      }
      expect(waypointArrival(def, game, 'nowhere')).toBeNull();
    }
  });

  it('a chest drops its loot once, for the first to reach it, even with two arriving on one tick', () => {
    const sim = new Simulation(6, world(6));
    const a = sim.addPlayer('a', 'warrior');
    const b = sim.addPlayer('b', 'mage');
    const chest = sim.mapDef.chests?.[0];
    if (!chest) throw new Error('no chest');
    for (const id of [a, b]) {
      const p = sim.world.player.get(id);
      if (p) p.god = true;
    }
    const bags = () => [...sim.world.loot.values()].filter((l) => l.items.length > 0);
    sim.step();
    const before = bags().length;
    sim.world.position.set(a, { x: chest.x + 30, y: chest.y });
    sim.world.position.set(b, { x: chest.x - 30, y: chest.y });
    sim.step();
    expect(openedChests(sim).has(chestKey(chest))).toBe(true);
    expect(bags().length).toBe(before + 1);
    const uids = bags().flatMap((l) => l.items.map((i) => i.uid));
    expect(new Set(uids).size).toBe(uids.length);
    for (const id of [a, b]) sim.world.position.set(id, { x: chest.x + 600, y: chest.y });
    sim.step();
    sim.world.position.set(a, { x: chest.x + 30, y: chest.y });
    sim.step();
    expect(bags().length).toBe(before + 1);
  });
});
