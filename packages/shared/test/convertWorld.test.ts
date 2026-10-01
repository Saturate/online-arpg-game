import { describe, expect, it } from 'vitest';
import { convertWorldWaypoints, freshWorld, isWorldFormat1, TOWN_WAYPOINT, WORLD_WAYPOINT_IDS, ZONE_BEHIND_GATE, ZONE_IDS, ZONE_WAYPOINT } from '../src/index.js';

const SEEDS = [1, 42, 9001];

describe('world save conversion', () => {
  it('lists the same waypoint ids every world has', () => {
    for (const seed of SEEDS) {
      const ids = freshWorld(seed).def.waypoints?.map((w) => w.id) ?? [];
      expect([...ids].sort()).toEqual([...WORLD_WAYPOINT_IDS].sort());
    }
  });

  it('maps every old zone to its region entrance, and barrens to nothing (the town is everyone\'s)', () => {
    for (const seed of SEEDS) {
      const { def, plan } = freshWorld(seed);
      for (const zone of ZONE_IDS) {
        const to = ZONE_WAYPOINT[zone];
        if (zone === 'barrens') {
          expect(to).toBeNull();
          continue;
        }
        const wp = def.waypoints?.find((w) => w.id === to);
        if (!wp) throw new Error(`${zone} maps to ${String(to)}, not a waypoint`);
        // The first waypoint of the region a walk from town reaches.
        const first = plan.waypoints.find((w) => w.region === zone);
        expect(first?.id, zone).toBe(to);
        // The gate it lies behind is the one the plan marks.
        expect(wp.behind ?? undefined, zone).toBe(ZONE_BEHIND_GATE[zone]);
      }
      for (const gate of Object.values(ZONE_BEHIND_GATE)) expect(plan.gates.some((g) => g.id === gate)).toBe(true);
    }
  });

  it('converts a save from the zones in order, without repeats', () => {
    const { waypoints, gates, report } = convertWorldWaypoints(['barrens', 'steppe', 'gloomvale', 'thornwood', 'dunes', 'hollows', 'steppe']);
    expect(waypoints).toEqual(['steppe-1', 'gloomvale-1', 'thornwood-1', 'dunes-1', 'hollows-1']);
    expect(report.dropped).toEqual(['barrens']);
    expect(report.unknown).toEqual([]);
    expect(report.warnings).toEqual([]);
    // The zones behind a gate keep their way in: those gates open, the others stay sealed.
    expect(gates).toEqual(['steppe-gate', 'gloomvale-gate']);
    expect(report.gatesGranted).toEqual(gates);
    expect(convertWorldWaypoints(['steppe', 'gloomvale', 'thornwood']).gates).toEqual([]);
  });

  it('keeps world ids found after the world shipped beside the mapped ones, and drops the town\'s', () => {
    const { waypoints, report } = convertWorldWaypoints(['barrens', 'steppe', 'steppe-1', 'thornwood-2', TOWN_WAYPOINT]);
    expect(waypoints).toEqual(['steppe-1', 'thornwood-2']);
    expect(report.dropped).toEqual(['barrens', TOWN_WAYPOINT]);
  });

  it('is idempotent', () => {
    const once = convertWorldWaypoints(['barrens', 'steppe', 'hollows', 'gloomvale-2', 'mystery']);
    const twice = convertWorldWaypoints(once.waypoints);
    expect(twice.waypoints).toEqual(once.waypoints);
    expect(twice.report.mapped).toEqual([]);
    expect(twice.report.dropped).toEqual([]);
    // World ids open nothing, so a second pass grants no gate the first did not.
    expect(once.gates).toEqual(['gloomvale-gate']);
    expect(twice.gates).toEqual([]);
    for (const id of WORLD_WAYPOINT_IDS.filter((x) => x !== TOWN_WAYPOINT)) expect(convertWorldWaypoints([id]).waypoints).toEqual([id]);
  });

  it('keeps an id it cannot map, with a warning', () => {
    const { waypoints, report } = convertWorldWaypoints(['steppe', 'mystery', 'wilds-9']);
    expect(waypoints).toEqual(['steppe-1', 'mystery', 'wilds-9']);
    expect(report.unknown).toEqual(['mystery', 'wilds-9']);
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings[0]).toMatch(/mystery/);
  });

  it('reads the marker', () => {
    expect(isWorldFormat1({ worldFormat: 1 })).toBe(true);
    expect(isWorldFormat1({ runeFormat: 2 })).toBe(false);
    expect(isWorldFormat1(null)).toBe(false);
  });
});
