import { convertItemRolls, emptyRuneRollsReport, isClassId, isEnemyTypeId, isRuneFormat2, isRuneTiers6, resolveWorldGen, runeRollsChanged, worldGenOverrides, type ClassId, type GroundPile, type Item, type Vec2, type WorldGenValues, type WorldMemory } from '@rune/shared';
import type { DatabaseSync } from 'node:sqlite';
import { isStoredItem } from './accounts.js';

/**
 * The session state a restart loses, kept from SIGTERM to the next boot (docs/features/seamless-restart.md).
 * Bump the format whenever its shape or the item format inside it changes: a snapshot of another
 * format is dropped on boot rather than read wrong, which costs only what a restart cost before.
 */
export const SNAPSHOT_FORMAT = 1;

/**
 * How long after the boot a player who was online at the shutdown still lands where they stood.
 * A deploy keeps the server away for about a minute (Recreate strategy), and a stale tab reloads
 * once more on top; five minutes covers both with room to spare, and is short enough that someone
 * coming back much later starts in town as always.
 */
export const RESUME_WINDOW_MS = 5 * 60_000;

/** Where a player stood: a spot in the world room, beside a dungeon's entrance, or the town. */
export type SnapshotPlace = { at: 'world'; x: number; y: number } | { at: 'dungeon'; seed: number } | { at: 'town' };

export interface SnapshotPlayer {
  characterId: number;
  accountId: number;
  instanceId: string;
  place: SnapshotPlace;
}

export interface SnapshotInstance {
  id: string;
  seed: number;
  kind: 'public' | 'party';
  name: string;
  partyId: string | null;
  gen: WorldGenValues;
  memory: WorldMemory | null;
  /** `ZoneWorld.memoryLayout()` of the ground the memory belongs to, or null when none is known. */
  layout: string | null;
  /** Where the world room's town lay (`MapDef.townAt`): a new build may centre it elsewhere, and everything moves with it. */
  townAt: Vec2 | null;
  loot: GroundPile[];
}

export interface SnapshotParty {
  id: string;
  leader: number;
  members: [number, string][];
  seen: [number, { cls: ClassId; level: number }][];
  instanceId: string | null;
}

export interface SessionSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  /**
   * The item format markers a character save carries (`runeFormat`, `runeTiers`), for the ground
   * loot: a later build that converts items on load converts these too, by the same markers.
   */
  runeFormat: 2;
  runeTiers: 6;
  takenAt: number;
  build: string;
  nextInstanceId: number;
  nextPartyId: number;
  instances: SnapshotInstance[];
  parties: SnapshotParty[];
  players: SnapshotPlayer[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function list<T>(v: unknown, read: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const r = read(x);
    if (r === null) return null;
    out.push(r);
  }
  return out;
}

function readPlace(v: unknown): SnapshotPlace | null {
  if (!isRecord(v)) return null;
  if (v.at === 'world' && isNum(v.x) && isNum(v.y)) return { at: 'world', x: v.x, y: v.y };
  if (v.at === 'dungeon' && isInt(v.seed)) return { at: 'dungeon', seed: v.seed };
  if (v.at === 'town') return { at: 'town' };
  return null;
}

function readPlayer(v: unknown): SnapshotPlayer | null {
  if (!isRecord(v) || !isInt(v.characterId) || !isInt(v.accountId) || typeof v.instanceId !== 'string') return null;
  const place = readPlace(v.place);
  return place ? { characterId: v.characterId, accountId: v.accountId, instanceId: v.instanceId, place } : null;
}

function readPile(v: unknown): GroundPile | null {
  if (!isRecord(v) || !isNum(v.x) || !isNum(v.y) || !isNum(v.radius) || !isNum(v.gold) || !isNum(v.lifetime) || !isNum(v.maxLife)) return null;
  if (!Array.isArray(v.items) || !v.items.every(isStoredItem)) return null;
  return { x: v.x, y: v.y, radius: v.radius, items: v.items, gold: Math.max(0, Math.floor(v.gold)), lifetime: v.lifetime, maxLife: v.maxLife };
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.filter((x): x is string => typeof x === 'string') : null;
}

function readMemory(v: unknown): WorldMemory | null | undefined {
  if (v === null) return null;
  if (!isRecord(v)) return undefined;
  const bosses = strings(v.bosses);
  const chests = strings(v.chests);
  const gates = list(v.gates, (g) => (isRecord(g) && typeof g.id === 'string' && isEnemyTypeId(g.boss) && isNum(g.sinceDeath) && isInt(g.spawns) ? { id: g.id, boss: g.boss, sinceDeath: g.sinceDeath, spawns: g.spawns } : null));
  return bosses && chests && gates ? { gates, bosses, chests } : undefined;
}

function readInstance(v: unknown): SnapshotInstance | null {
  if (!isRecord(v) || typeof v.id !== 'string' || !isInt(v.seed) || (v.kind !== 'public' && v.kind !== 'party') || typeof v.name !== 'string') return null;
  if (v.partyId !== null && typeof v.partyId !== 'string') return null;
  if (v.layout !== null && typeof v.layout !== 'string') return null;
  const town: unknown = v.townAt;
  const townAt = isRecord(town) && isNum(town.x) && isNum(town.y) ? { x: town.x, y: town.y } : null;
  if (town !== null && townAt === null) return null;
  const memory = readMemory(v.memory);
  const loot = list(v.loot, readPile);
  if (memory === undefined || !loot) return null;
  // The numbers go through the ranges of this build, as the stored public numbers do.
  const gen = worldGenOverrides(resolveWorldGen(v.gen));
  return { id: v.id, seed: v.seed, kind: v.kind, name: v.name, partyId: v.partyId, gen, memory, layout: v.layout, townAt, loot };
}

function readParty(v: unknown): SnapshotParty | null {
  if (!isRecord(v) || typeof v.id !== 'string' || !isInt(v.leader)) return null;
  if (v.instanceId !== null && typeof v.instanceId !== 'string') return null;
  const members = list(v.members, (m): [number, string] | null => (Array.isArray(m) && isInt(m[0]) && typeof m[1] === 'string' ? [m[0], m[1]] : null));
  const seen = list(v.seen, (m): [number, { cls: ClassId; level: number }] | null => {
    if (!Array.isArray(m) || !isInt(m[0])) return null;
    const s: unknown = m[1];
    return isRecord(s) && isClassId(s.cls) && isInt(s.level) ? [m[0], { cls: s.cls, level: s.level }] : null;
  });
  if (!members || !seen) return null;
  return { id: v.id, leader: v.leader, members, seen, instanceId: v.instanceId };
}

/**
 * Ground items through the same load-time conversion a save's go through, by the snapshot's own
 * markers: from before the six rune tiers, the rune roll pass (runes a sigil hands back stay in its
 * pile); from before the rune rework, nothing (that conversion needs a whole character), so the loot
 * is dropped, which costs what a restart cost before. `note` says what happened, for the boot log.
 */
function convertLoot(raw: Record<string, unknown>, instances: SnapshotInstance[]): string | null {
  if (!isRuneFormat2(raw)) {
    let items = 0;
    for (const i of instances) {
      for (const p of i.loot) items += p.items.length;
      i.loot = [];
    }
    return items > 0 ? `${items} ground items from before the rune rework dropped` : null;
  }
  if (isRuneTiers6(raw)) return null;
  const report = emptyRuneRollsReport();
  for (const i of instances) {
    for (const p of i.loot) {
      const items: Item[] = [];
      for (const it of p.items) {
        const r = convertItemRolls(it, report);
        items.push(r.item, ...r.returned);
      }
      p.items = items;
    }
  }
  return runeRollsChanged(report) ? `rune roll pass on ground loot: ${report.runesRetiered.length} runes retiered, ${report.affixesRemoved.length} sigil affixes removed, ${report.startersRebuilt.length} starters rebuilt` : null;
}

/**
 * The snapshot as stored, or why it cannot be used. This server wrote it moments before, so the
 * check is for a snapshot from another build (or a damaged row), not a hostile one; anything off
 * drops the whole snapshot rather than restoring half of it.
 */
export function parseSnapshot(json: string): { snapshot: SessionSnapshot; note: string | null } | string {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return 'not JSON';
  }
  if (!isRecord(v)) return 'not an object';
  if (v.format !== SNAPSHOT_FORMAT) return `format ${String(v.format)}, this build reads ${SNAPSHOT_FORMAT}`;
  if (!isInt(v.takenAt) || typeof v.build !== 'string' || !isInt(v.nextInstanceId) || !isInt(v.nextPartyId)) return 'bad header';
  const instances = list(v.instances, readInstance);
  const parties = list(v.parties, readParty);
  const players = list(v.players, readPlayer);
  if (!instances) return 'bad world copies';
  if (!parties) return 'bad parties';
  if (!players) return 'bad players';
  const note = convertLoot(v, instances);
  return { snapshot: { format: SNAPSHOT_FORMAT, runeFormat: 2, runeTiers: 6, takenAt: v.takenAt, build: v.build, nextInstanceId: v.nextInstanceId, nextPartyId: v.nextPartyId, instances, parties, players }, note };
}

/** One row at most: the snapshot of the last shutdown, until the next boot takes it. */
export class SnapshotStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format INTEGER NOT NULL,
        taken_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
    `);
  }

  /** Only inside the shutdown's transaction, with the character saves of the same moment (AccountStore.saveShutdown). */
  write(snapshot: SessionSnapshot): number {
    return this.writeJson(JSON.stringify(snapshot), snapshot.format, snapshot.takenAt);
  }

  /** The row as text; tests use it to store snapshots this build would not write. */
  writeJson(json: string, format: number, takenAt: number): number {
    this.db.prepare('INSERT INTO session_snapshot (id, format, taken_at, json) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET format = excluded.format, taken_at = excluded.taken_at, json = excluded.json').run(format, takenAt, json);
    return json.length;
  }

  /**
   * Reads and deletes the snapshot in one go, so it is used once whatever happens next: a boot that
   * crashes while restoring starts the following one fresh instead of tripping on it again.
   */
  take(): string | null {
    const r = this.db.prepare('SELECT json FROM session_snapshot WHERE id = 1').get();
    this.db.prepare('DELETE FROM session_snapshot').run();
    const json = r?.json;
    return typeof json === 'string' ? json : null;
  }

  /** Whether a snapshot is waiting, for tests and the boot log. */
  has(): boolean {
    return this.db.prepare('SELECT 1 FROM session_snapshot').get() !== undefined;
  }
}
