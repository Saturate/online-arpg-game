import { ZONE_IDS, type ZoneId } from '../data/zones.js';
import { TOWN_WAYPOINT, WORLD_WAYPOINT_IDS } from './worldPlan.js';

/**
 * The one-time save conversion for the seamless world (stage 3): a character's waypoint list held
 * the old zones' ids (`steppe`, `hollows`), which unlock nothing in the world, and gets the world's
 * waypoint ids for them instead. Saves never stored a zone or a position, so nothing else changes.
 */

/** Marks a save whose waypoint list holds world ids; a save without it is converted on load. */
export const WORLD_FORMAT = 1;

/**
 * Each old zone's waypoint in the world: the entrance of the region of the same name, the first
 * waypoint a character walking in from town would touch. `barrens` was the town's own zone and is
 * the home region now, which has no waypoint of its own; the town's is everyone's, so it maps to
 * nothing.
 */
export const ZONE_WAYPOINT: Record<ZoneId, string | null> = {
  barrens: null,
  steppe: 'steppe-1',
  gloomvale: 'gloomvale-1',
  thornwood: 'thornwood-1',
  dunes: 'dunes-1',
  hollows: 'hollows-1',
};

/**
 * The gate each old zone now lies behind. A character that had found the zone had walked there
 * through every zone before it, so it keeps the way there: the conversion opens that gate for it
 * (owner decision, 2026-10-01), as if it had killed the gate boss.
 */
export const ZONE_BEHIND_GATE: Partial<Record<ZoneId, string>> = {
  dunes: 'steppe-gate',
  hollows: 'gloomvale-gate',
};

export interface WorldConversionReport {
  mapped: { from: ZoneId; to: string }[];
  /** Ids that need no entry: `barrens` and the town's, which everyone has without one. */
  dropped: string[];
  /** Ids that are neither an old zone nor a world waypoint, kept as they were. */
  unknown: string[];
  /** Gates the old zones lay behind, opened for the character; see ZONE_BEHIND_GATE. */
  gatesGranted: string[];
  warnings: string[];
}

export interface WorldWaypointConversion {
  waypoints: string[];
  /** Gates to open for the character, added to whatever its save already lists. */
  gates: string[];
  report: WorldConversionReport;
}

export function isWorldFormat1(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && Reflect.get(raw, 'worldFormat') === WORLD_FORMAT;
}

function zoneOf(id: string): ZoneId | undefined {
  return ZONE_IDS.find((z) => z === id);
}

/**
 * Old zone ids to world waypoint ids, in the order they were found, without repeats, and the gates
 * the old zones lay behind. World ids pass through and open nothing, so converting twice changes
 * nothing. Unknown ids are kept, since a dropped id cannot be
 * given back and a kept one unlocks nothing: a later fix can still map it.
 */
export function convertWorldWaypoints(list: readonly string[]): WorldWaypointConversion {
  const report: WorldConversionReport = { mapped: [], dropped: [], unknown: [], gatesGranted: [], warnings: [] };
  const out: string[] = [];
  const push = (id: string): void => {
    if (!out.includes(id)) out.push(id);
  };
  for (const id of list) {
    const zone = zoneOf(id);
    if (zone) {
      const to = ZONE_WAYPOINT[zone];
      const gate = ZONE_BEHIND_GATE[zone];
      if (gate && !report.gatesGranted.includes(gate)) report.gatesGranted.push(gate);
      if (to === null) report.dropped.push(id);
      else {
        report.mapped.push({ from: zone, to });
        push(to);
      }
    } else if (id === TOWN_WAYPOINT) report.dropped.push(id);
    else if (WORLD_WAYPOINT_IDS.includes(id)) push(id);
    else {
      report.unknown.push(id);
      report.warnings.push(`unknown waypoint ${id}; kept as it was`);
      push(id);
    }
  }
  return { waypoints: out, gates: [...report.gatesGranted], report };
}
