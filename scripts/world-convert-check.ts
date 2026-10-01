/**
 * Dry run of the seamless world's save conversion against a copy of a rune.db:
 *
 *   pnpm world:convert-check <path-to-db-copy>
 *
 * Loads every character through the server's own load path (AccountStore.loadCharacter, so v1 saves
 * go through the rune conversion first, as on the server), prints each one's waypoints before and
 * after and the gates it gets, and checks every old zone id mapped, the gates its old zones lay
 * behind opened, nothing but the waypoint list, the gates and the marker changed,
 * and a save written back loads the same. The file is copied to a temp directory first and only the
 * copy is opened and written. Exits non-zero when any check fails.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountStore } from '../apps/server/src/accounts.js';
import { convertCharacterSave, convertWorldWaypoints, isGateId, isRuneFormat2, isWaypointId, isWorldFormat1, isZoneId, WORLD_WAYPOINT_IDS, ZONE_WAYPOINT } from '../packages/shared/src/index.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON with object keys sorted, so two saves compare equal whatever order their fields were written in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isRecord(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}

const list = (xs: readonly string[]): string => (xs.length > 0 ? xs.join(', ') : 'none');

let failures = 0;
const totals = { characters: 0, converted: 0, alreadyMarked: 0, neverSaved: 0, mapped: 0, dropped: 0, unknown: 0, gated: 0 };

function main(): void {
  const src = process.argv[2];
  if (!src || !existsSync(src)) {
    console.error('usage: pnpm world:convert-check <path-to-db-copy>');
    process.exit(2);
  }
  // A private copy (with its WAL, which may hold recent writes), so the given file is never touched.
  const dir = mkdtempSync(join(tmpdir(), 'world-convert-check-'));
  const copy = join(dir, basename(src));
  copyFileSync(src, copy);
  if (existsSync(`${src}-wal`)) copyFileSync(`${src}-wal`, `${copy}-wal`);
  const raw = new DatabaseSync(copy, { readOnly: true });
  const store = new AccountStore(copy);
  try {
    console.log(`world save conversion check of ${src} (copy)`);
    const characters = raw.prepare('SELECT id, account_id, name, class_id, save_json FROM characters ORDER BY id').all().filter(isRecord);
    for (const row of characters) {
      totals.characters++;
      const id = Number(row.id);
      const accountId = Number(row.account_id);
      console.log(`\ncharacter ${id} "${String(row.name)}" (${String(row.class_id)}, account ${accountId})`);
      if (typeof row.save_json !== 'string') {
        totals.neverSaved++;
        console.log('  never saved; nothing to convert');
        continue;
      }
      const problems: string[] = [];
      const before: unknown = JSON.parse(row.save_json);
      if (!isRecord(before)) {
        failures++;
        console.log('  FAIL: save is not an object');
        continue;
      }
      const rawList = Array.isArray(before.waypoints) ? before.waypoints.filter((w): w is string => typeof w === 'string') : [];
      const marked = isWorldFormat1(before);
      console.log(`  stored: runeFormat ${isRuneFormat2(before) ? 2 : 1}, ${marked ? 'worldFormat 1' : 'no worldFormat'}; waypoints ${list(rawList)}`);
      const loaded = store.loadCharacter(accountId, id)?.save;
      if (!loaded) {
        failures++;
        console.log('  FAIL: the server cannot load this save');
        continue;
      }
      const rawGates = Array.isArray(before.gates) ? before.gates.filter(isGateId) : [];
      console.log(`  loaded: waypoints ${list(loaded.waypoints)}; gates ${list(loaded.gates ?? [])}`);
      if (marked) {
        totals.alreadyMarked++;
        check(problems, stable(loaded.waypoints) === stable(rawList.filter(isWaypointId)), 'a marked save had its waypoints changed');
        check(problems, stable(loaded.gates ?? []) === stable(rawGates), 'a marked save had its gates changed');
      } else {
        totals.converted++;
        const { waypoints, gates, report } = convertWorldWaypoints(rawList.filter(isWaypointId));
        totals.mapped += report.mapped.length;
        totals.dropped += report.dropped.length;
        totals.unknown += report.unknown.length;
        totals.gated += report.gatesGranted.length;
        console.log(`  mapped: ${list(report.mapped.map((m) => `${m.from} -> ${m.to}`))}`);
        console.log(`  dropped (the town's, everyone has it): ${list(report.dropped)}`);
        console.log(`  unknown, kept: ${list(report.unknown)}`);
        console.log(`  gates opened (the old zones lie behind them): ${list(report.gatesGranted)}`);
        check(problems, stable(loaded.gates ?? []) === stable([...new Set([...rawGates, ...gates])]), `loaded gates ${list(loaded.gates ?? [])} != stored ${list(rawGates)} plus granted ${list(gates)}`);
        check(problems, stable(loaded.waypoints) === stable(waypoints), `loaded waypoints ${list(loaded.waypoints)} != converted ${list(waypoints)}`);
        for (const w of rawList) {
          const to = isZoneId(w) ? ZONE_WAYPOINT[w] : undefined;
          if (to) check(problems, loaded.waypoints.includes(to), `old zone ${w} did not map to ${to}`);
        }
        check(problems, loaded.waypoints.every((w) => WORLD_WAYPOINT_IDS.includes(w) || report.unknown.includes(w)), 'an old zone id is left in the list');
        check(problems, new Set(loaded.waypoints).size === loaded.waypoints.length, 'a waypoint is listed twice');
      }
      check(problems, loaded.worldFormat === 1, 'loaded save is not marked worldFormat 1');
      const again0 = convertWorldWaypoints(loaded.waypoints);
      check(problems, stable(again0.waypoints) === stable(loaded.waypoints) && again0.gates.every((g) => (loaded.gates ?? []).includes(g)), 'converting again changes the list or grants another gate');

      // Everything but the waypoint list and the marker is what the load path gave before the world:
      // the raw row for a v2 save, the rune conversion's output for a v1 one.
      const expected: unknown = isRuneFormat2(before) ? before : convertCharacterSave(before).save;
      if (isRecord(expected)) {
        const keys = new Set([...Object.keys(expected), ...Object.keys(loaded)]);
        const changed = [...keys].filter((k) => k !== 'waypoints' && k !== 'worldFormat' && k !== 'gates' && stable(expected[k]) !== stable(Reflect.get(loaded, k)));
        if (changed.length > 0) console.log(`  normalised by the existing load path (not this conversion): ${changed.join(', ')}`);
        check(problems, changed.every((k) => k === 'stash' || k === 'gold' || k === 'level' || k === 'xp'), `fields changed: ${changed.join(', ')}`);
      }

      // Written back and loaded again, a converted save is read as it is.
      store.saveCharacter(id, loaded);
      const again = store.loadCharacter(accountId, id)?.save;
      check(problems, again !== undefined && again !== null && stable(again) === stable(loaded), 'a written-back save loads differently');

      if (problems.length > 0) {
        failures += problems.length;
        for (const p of problems) console.log(`  FAIL: ${p}`);
      } else console.log('  checks: ok');
    }
  } finally {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    `\nsummary: ${totals.characters} characters, ${totals.converted} converted, ${totals.alreadyMarked} already marked, ${totals.neverSaved} never saved; ${totals.mapped} zone ids mapped, ${totals.dropped} dropped, ${totals.unknown} unknown kept, ${totals.gated} gates opened; ${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function check(problems: string[], ok: boolean, what: string): void {
  if (!ok) problems.push(what);
}

main();
