/**
 * Dry run of the v1 to v2 save conversion against a copy of a rune.db:
 *
 *   pnpm runes:convert-check <path-to-db-copy>
 *
 * Converts every character, every account stash and the trader shelf in memory, prints what each
 * one gets, and checks nothing is lost or doubled. It never writes: the file is copied to a temp
 * directory first and that copy is opened read-only. Exits non-zero when any check fails.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  compileSigilItem,
  convertCharacterSave,
  convertStash,
  convertTraderShelf,
  isClassId,
  isRuneFormat2,
  isV1RuneId,
  isV1TestSigil,
  starterSigilById,
  V1_TO_V2,
  type ClassId,
  type ConversionReport,
  type Item,
} from '../packages/shared/src/index.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON with object keys sorted, so two items compare equal whatever order their fields were written in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isRecord(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}

type Counts = Map<string, number>;

function add(m: Counts, key: string, n: number): void {
  m.set(key, (m.get(key) ?? 0) + n);
}

function show(m: Counts): string {
  const parts = [...m.entries()].filter(([, n]) => n !== 0).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} x${n}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

function same(a: Counts, b: Counts): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) return false;
  return true;
}

const key = (rune: string, bound: boolean): string => `${rune}${bound ? ' (bound)' : ''}`;

/** What the v1 data holds, read straight from the raw JSON so the check does not trust the converter. */
interface V1Tally {
  /** Loose, hand-inscribed and Test Sigil runes, by v1 id and binding. */
  runes: Counts;
  /** Runes inside built-in skill sigils, by v1 id: starter runes replace them, and the report must list them. */
  inSkillSigils: Counts;
  testSigils: number;
  /** Rune units plus one per other item: what the conversion must keep, less gold runes and Test Sigils. */
  units: number;
  sigils: number;
  /** Gear and vessels, as stable JSON: compared as a multiset, since every shelf item carries uid 0. */
  others: string[];
  gold: number;
}

function tallyV1(rawItems: readonly unknown[], gold: number): V1Tally {
  const t: V1Tally = { runes: new Map(), inSkillSigils: new Map(), testSigils: 0, units: 0, sigils: 0, others: [], gold };
  for (const it of rawItems) {
    if (!isRecord(it)) continue;
    const bound = it.bound === true;
    if (it.kind === 'rune') {
      const n = typeof it.count === 'number' ? it.count : 0;
      add(t.runes, key(String(it.rune), bound), n);
      t.units += n;
    } else if (it.kind === 'sigil') {
      t.sigils++;
      t.units++;
      const runes = Array.isArray(it.runes) ? it.runes : [];
      const flags = Array.isArray(it.boundSlots) ? it.boundSlots : [];
      const test = isV1TestSigil(it);
      if (test) t.testSigils++;
      if (!test && typeof it.skill === 'string' && starterSigilById(it.skill)) {
        for (const r of runes) add(t.inSkillSigils, String(r), 1);
        continue;
      }
      runes.forEach((r: unknown, i: number) => {
        const f: unknown = flags[i];
        add(t.runes, key(String(r), typeof f === 'boolean' ? f : test ? true : bound), 1);
        t.units++;
      });
    } else {
      t.units++;
      t.others.push(stable(it));
    }
  }
  return t;
}

interface V2Tally {
  runes: Counts;
  starterRunes: number;
  units: number;
  sigils: number;
  uids: number[];
}

function tallyV2(items: readonly Item[]): V2Tally {
  const t: V2Tally = { runes: new Map(), starterRunes: 0, units: 0, sigils: 0, uids: [] };
  for (const it of items) {
    t.uids.push(it.uid);
    if (it.kind === 'rune') {
      add(t.runes, key(it.rune, it.bound === true), it.count);
      t.units += it.count;
      continue;
    }
    t.units++;
    if (it.kind !== 'sigil') continue;
    t.sigils++;
    for (const r of it.slots) {
      t.uids.push(r.uid);
      if (it.starter) t.starterRunes++;
      else {
        add(t.runes, key(r.rune, r.bound === true), 1);
        t.units++;
      }
    }
  }
  return t;
}

let failures = 0;
const totals = { containers: 0, v1Runes: 0, v2Runes: 0, gold: 0, refunded: 0, replaced: 0, starters: 0, starterRunes: 0, warnings: 0, compiled: 0, sigils: 0 };

function check(problems: string[], ok: boolean, what: string): void {
  if (!ok) problems.push(what);
}

/** Checks and prints one converted container. */
function report(title: string, rawItems: readonly unknown[], goldBefore: number, goldAfter: number | null, items: readonly Item[], r: ConversionReport, classId: ClassId, opts: { shelf?: boolean; alreadyV2?: boolean } = {}): void {
  totals.containers++;
  console.log(`\n${title}`);
  if (opts.alreadyV2) {
    console.log('  already runeFormat 2; left as it is');
    return;
  }
  const v1 = tallyV1(rawItems, goldBefore);
  const v2 = tallyV2(items);
  const problems: string[] = [];

  // Every v1 rune is either mapped (same binding) or paid out.
  const expected: Counts = new Map();
  const refundedUnits: Counts = new Map();
  let v1Total = 0;
  for (const [k, n] of v1.runes) {
    v1Total += n;
    const bound = k.endsWith(' (bound)');
    const id = bound ? k.slice(0, -' (bound)'.length) : k;
    if (!isV1RuneId(id)) {
      problems.push(`unknown v1 rune ${id}`);
      continue;
    }
    const to = V1_TO_V2[id];
    if (to === null) add(refundedUnits, id, n);
    else add(expected, key(to, bound), n);
  }
  const reportedRefunds: Counts = new Map(r.runesRefunded.map((x) => [x.from, x.count]));
  let v2Total = 0;
  for (const n of v2.runes.values()) v2Total += n;
  let refundTotal = 0;
  for (const n of refundedUnits.values()) refundTotal += n;
  let goldRefunds = 0;
  for (const x of r.runesRefunded) goldRefunds += x.gold;

  let replacedTotal = 0;
  for (const n of v1.inSkillSigils.values()) replacedTotal += n;
  const reportedReplaced: Counts = new Map(r.runesReplaced.map((x) => [x.from, x.count]));
  console.log(`  v1 runes: ${show(v1.runes)}`);
  console.log(`  v1 runes in built-in skill sigils, replaced by starter runes (no gold): ${show(reportedReplaced)}`);
  console.log(`  v2 runes: ${show(v2.runes)}${v2.starterRunes > 0 ? `; plus ${v2.starterRunes} inside starter sigils` : ''}`);
  const refundLine = r.runesRefunded.map((x) => `${x.from} x${x.count} = ${x.gold} gold`).join(', ');
  console.log(`  to gold: ${refundLine || 'none'}${opts.shelf ? '; the shelf has no owner, so nobody is paid' : goldAfter === null ? `; owed to the character that loads it: ${r.gold}` : `; gold ${goldBefore} -> ${goldAfter}`}`);
  console.log(`  starter sigils: ${r.starterSigils.length > 0 ? r.starterSigils.join(', ') : 'none'}`);
  console.log(`  returned from sigils: ${r.runesReturned} (${r.runesPending} pending); Test Sigils taken apart: ${r.testSigilsUnpacked}`);

  check(problems, same(expected, v2.runes), `runes do not add up: expected ${show(expected)}, got ${show(v2.runes)}`);
  check(problems, same(v1.inSkillSigils, reportedReplaced), `replaced runes do not add up: found ${show(v1.inSkillSigils)}, reported ${show(reportedReplaced)}`);
  const starterExpected = r.starterSigils.reduce((n, id) => n + (starterSigilById(id)?.runes.length ?? 0), 0);
  check(problems, v2.starterRunes === starterExpected, `starter sigils hold ${v2.starterRunes} runes, their definitions ${starterExpected}`);
  check(problems, same(refundedUnits, reportedRefunds), `refunds do not add up: expected ${show(refundedUnits)}, reported ${show(reportedRefunds)}`);
  check(problems, v2Total + refundTotal === v1Total, `rune total: ${v2Total} mapped + ${refundTotal} to gold != ${v1Total} v1`);
  check(problems, r.gold === (opts.shelf ? 0 : goldRefunds), `report gold ${r.gold} != refunds ${goldRefunds}`);
  if (goldAfter !== null) check(problems, goldAfter === goldBefore + r.gold, `gold ${goldAfter} != ${goldBefore} + ${r.gold}`);
  check(problems, v2.units === v1.units - refundTotal - v1.testSigils, `item count: ${v2.units} units after, expected ${v1.units} - ${refundTotal} to gold - ${v1.testSigils} Test Sigils`);
  check(problems, v2.sigils === v1.sigils - v1.testSigils, `sigils: ${v2.sigils} after, expected ${v1.sigils} - ${v1.testSigils}`);
  check(problems, r.testSigilsUnpacked === v1.testSigils, `Test Sigils: reported ${r.testSigilsUnpacked}, found ${v1.testSigils}`);
  // Shelf items all carry uid 0 by design; only the runes inside its sigils need their own.
  const uids = opts.shelf ? items.flatMap((i) => (i.kind === 'sigil' ? i.slots.map((s) => s.uid) : [])) : v2.uids;
  const dup = uids.filter((u, i) => uids.indexOf(u) !== i);
  check(problems, dup.length === 0, `uid in two places: ${[...new Set(dup)].join(', ')}`);
  const othersAfter = items.filter((i) => i.kind !== 'rune' && i.kind !== 'sigil').map(stable).sort();
  const othersBefore = [...v1.others].sort();
  const changed = othersBefore.filter((s, i) => s !== othersAfter[i]).length + Math.abs(othersBefore.length - othersAfter.length);
  check(problems, changed === 0, `${changed} gear or vessel items changed`);

  const compiles: string[] = [];
  for (const it of items) {
    if (it.kind !== 'sigil') continue;
    totals.sigils++;
    const c = compileSigilItem(it, classId);
    if (c.ok) totals.compiled++;
    const label = `${it.name}${it.starter ? ` [${it.starter}]` : it.slots.length === 0 ? ' [blank]' : ' [hand-inscribed]'}`;
    compiles.push(`${label}: ${c.ok ? 'ok' : c.errors.map((e) => e.message).join('; ')}`);
    if (it.starter) check(problems, c.ok, `starter sigil ${it.name} does not compile`);
  }
  if (compiles.length > 0) console.log(`  sigils compile:\n    ${compiles.join('\n    ')}`);
  for (const w of r.warnings) console.log(`  warning: ${w}`);

  totals.v1Runes += v1Total;
  totals.v2Runes += v2Total;
  totals.gold += r.gold;
  totals.refunded += refundTotal;
  totals.replaced += replacedTotal;
  totals.starterRunes += v2.starterRunes;
  totals.starters += r.starterSigils.length;
  totals.warnings += r.warnings.length;
  if (problems.length > 0) {
    failures += problems.length;
    for (const p of problems) console.log(`  FAIL: ${p}`);
  } else console.log('  checks: ok');
}

function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all().filter(isRecord);
}

function main(): void {
  const src = process.argv[2];
  if (!src || !existsSync(src)) {
    console.error('usage: pnpm runes:convert-check <path-to-db-copy>');
    process.exit(2);
  }
  // Worked on a private copy (with its WAL, which may hold recent writes), so the given file is
  // never touched, not even by SQLite's read-only housekeeping.
  const dir = mkdtempSync(join(tmpdir(), 'rune-convert-check-'));
  const copy = join(dir, basename(src));
  copyFileSync(src, copy);
  if (existsSync(`${src}-wal`)) copyFileSync(`${src}-wal`, `${copy}-wal`);
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    console.log(`v1 to v2 conversion check of ${src} (read-only copy)`);
    const classByAccount = new Map<number, ClassId>();
    for (const row of rows(db, 'SELECT id, account_id, name, class_id, save_json FROM characters ORDER BY id')) {
      const classId = row.class_id;
      const accountId = Number(row.account_id);
      const title = `character ${String(row.id)} "${String(row.name)}" (${String(classId)}, account ${accountId})`;
      if (!isClassId(classId)) {
        failures++;
        console.log(`\n${title}\n  FAIL: unknown class`);
        continue;
      }
      if (!classByAccount.has(accountId)) classByAccount.set(accountId, classId);
      if (typeof row.save_json !== 'string') {
        console.log(`\n${title}\n  never saved; nothing to convert`);
        continue;
      }
      try {
        const raw: unknown = JSON.parse(row.save_json);
        const { save, report: r } = convertCharacterSave(raw);
        const rawItems = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
        const goldBefore = isRecord(raw) && typeof raw.gold === 'number' ? raw.gold : 0;
        report(title, rawItems, goldBefore, save.gold, save.items, r, classId, { alreadyV2: isRuneFormat2(raw) });
      } catch (err) {
        failures++;
        console.log(`\n${title}\n  FAIL: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const row of rows(db, 'SELECT id, username, stash_json FROM accounts ORDER BY id')) {
      if (typeof row.stash_json !== 'string') continue;
      const title = `stash of account ${String(row.id)} "${String(row.username)}"`;
      try {
        const raw: unknown = JSON.parse(row.stash_json);
        const { stash, report: r } = convertStash(raw);
        const rawItems = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
        report(title, rawItems, 0, null, stash.items, r, classByAccount.get(Number(row.id)) ?? 'mage', { alreadyV2: isRuneFormat2(raw) });
      } catch (err) {
        failures++;
        console.log(`\n${title}\n  FAIL: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const shelfRow = rows(db, "SELECT value FROM settings WHERE key = 'trader'")[0];
    if (typeof shelfRow?.value === 'string') {
      try {
        const raw: unknown = JSON.parse(shelfRow.value);
        const { shelf, report: r } = convertTraderShelf(raw);
        const rawItems = isRecord(raw) && Array.isArray(raw.stock) ? raw.stock.map((e: unknown) => (isRecord(e) ? e.item : undefined)) : [];
        report(`trader shelf (${shelf.stock.length} entries)`, rawItems, 0, null, shelf.stock.map((e) => e.item), r, 'mage', { shelf: true, alreadyV2: isRuneFormat2(raw) });
      } catch (err) {
        failures++;
        console.log(`\ntrader shelf\n  FAIL: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else console.log('\ntrader shelf: none stored');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    `\nsummary: ${totals.containers} rows, ${totals.v1Runes} loose or hand-inscribed v1 runes -> ${totals.v2Runes} v2 runes + ${totals.refunded} to gold (${totals.gold} gold paid), ${totals.starters} starter sigils (${totals.replaced} v1 skill-sigil runes replaced by ${totals.starterRunes} starter runes), ${totals.compiled}/${totals.sigils} sigils compile, ${totals.warnings} warnings, ${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
