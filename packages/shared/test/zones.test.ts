import { describe, expect, it } from 'vitest';
import { GameMap, HOME_ZONE, loadMap, SIM, Simulation, WILDS, ZONE_IDS, zoneArrival, ZONES, type MapDescriptor, type WorldMap } from '../src/index.js';
import { dealDamage, inSafeZone, isTargetable } from '../src/sim/combat.js';
import { spawnEnemy } from '../src/sim/enemies.js';

function reach(map: WorldMap, x: number, y: number): { gm: GameMap; seen: Set<number> } {
  const gm = new GameMap(map);
  const start = gm.navCell(x, y);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const c = queue.pop() ?? 0;
    const cx = c % gm.navCols;
    const cy = (c - cx) / gm.navCols;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (!gm.isWalkable(cx + dx, cy + dy)) continue;
      const n = (cy + dy) * gm.navCols + cx + dx;
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return { gm, seen };
}

const zone = (z: (typeof ZONE_IDS)[number], seed: number): Extract<MapDescriptor, { kind: 'zone' }> => ({ kind: 'zone', zone: z, seed });

describe('overworld zones', () => {
  it('every zone connects its waypoint and transitions to where you arrive', () => {
    for (const id of ZONE_IDS) {
      for (const seed of [1, 42, 9001]) {
        const { def } = loadMap(zone(id, seed));
        const { gm, seen } = reach(def, def.spawn.x, def.spawn.y);
        const targets = def.portals.filter((p) => p.target === 'waypoint' || p.target === 'zone');
        expect(targets.some((p) => p.target === 'waypoint'), `${id} has a waypoint`).toBe(true);
        for (const p of targets) expect(seen.has(gm.navCell(p.x, p.y)), `${id}/${seed} ${p.label}`).toBe(true);
        for (const pack of def.packs) expect(pack.level, `${id} pack level`).toBeGreaterThanOrEqual(ZONES[id].levels[0]);
      }
    }
  });

  it('the home zone holds the town, safe and free of packs near its walls', () => {
    const { def } = loadMap(zone(HOME_ZONE, 7));
    const town = def.safeZones?.[0];
    expect(town).toBeDefined();
    if (!town) return;
    expect(def.spawn.x).toBeLessThan(town.x + town.w);
    expect(def.portals.some((p) => p.target === 'wilds')).toBe(false);
    for (const p of def.packs) {
      const inside = p.x > town.x - WILDS.aggroRadius && p.x < town.x + town.w + WILDS.aggroRadius && p.y > town.y - WILDS.aggroRadius && p.y < town.y + town.h + WILDS.aggroRadius;
      expect(inside, `pack at ${Math.round(p.x)},${Math.round(p.y)}`).toBe(false);
    }
  });

  it('nobody in town can be targeted or hurt, and monsters outside can be', () => {
    const sim = new Simulation(3, zone(HOME_ZONE, 3));
    const pid = sim.addPlayer('c', 'warrior');
    const pos = sim.world.position.get(pid);
    if (!pos) throw new Error('no player');
    expect(inSafeZone(sim, pos.x, pos.y)).toBe(true);
    expect(isTargetable(sim, pid)).toBe(false);
    const eid = spawnEnemy(sim, 'chaser', pos.x + 40, pos.y, { rare: false, level: 1, aggro: true });
    expect(dealDamage(sim, pid, 50, eid, [])).toBe(0);
    // Out past the gate, the same player is fair game.
    sim.world.position.set(pid, { x: (sim.mapDef.safeZones?.[0]?.w ?? 0) + 400, y: pos.y });
    expect(isTargetable(sim, pid)).toBe(true);
  });

  it('touching a waypoint activates it for the character, and the save keeps it', () => {
    const sim = new Simulation(4, zone('steppe', 4));
    const pid = sim.addPlayer('c', 'mage');
    const wp = sim.mapDef.portals.find((p) => p.target === 'waypoint');
    if (!wp) throw new Error('no waypoint');
    expect(sim.exportPlayer(pid)?.waypoints).toEqual([HOME_ZONE]);
    for (let i = 0; i < 40; i++) sim.step();
    sim.world.position.set(pid, { x: wp.x, y: wp.y });
    sim.step();
    expect(sim.exportPlayer(pid)?.waypoints).toEqual([HOME_ZONE, 'steppe']);
    expect(sim.portalRequests.some((r) => r.target === 'waypoint')).toBe(true);
  });

  it('arrivals land on open ground just off the portal you came through', () => {
    for (const id of ZONE_IDS) {
      const desc = zone(id, 11);
      const { def, game } = loadMap(desc);
      for (const from of ['waypoint', ...def.portals.filter((p) => p.target === 'zone').map((p) => p.zone ?? 'waypoint')] as const) {
        const at = zoneArrival(desc, from);
        expect(game.pointBlocked(at.x, at.y, SIM.playerRadius, 'move'), `${id} from ${from}`).toBe(false);
        for (const p of def.portals) expect(Math.hypot(p.x - at.x, p.y - at.y), `${id} from ${from} lands on ${p.label}`).toBeGreaterThan(p.r);
      }
    }
  });
});
