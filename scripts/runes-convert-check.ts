/**
 * Dry run of the v1 to v2 save conversion against a copy of a rune.db:
 *
 *   pnpm runes:convert-check <path-to-db-copy>
 *
 * Converts every character, every account stash and the trader shelf in memory, prints what each
 * one gets, and checks nothing is lost or doubled. Account stashes then go through the second
 * one-time conversion, from one grid to tabs (convertStashTabs), which is checked the same way.
 * Then every character, stash and shelf without `runeTiers: 6` goes through the one-time rune roll
 * pass (convertRuneRolls: "first rune is free" removed, old Multishot and Flame Cleave rebuilt,
 * every rune affix roll re-tiered by value among the six tiers), which is checked for lost or
 * doubled items, for values that moved, for gold a re-tier could mint, and against what the
 * server's own load path gives; rows already marked must load exactly as stored. Last, every row
 * without `runeImplicits: 1` goes through the implicit pass (convertImplicits: each rune gets the
 * neutral implicit), checked for lost or doubled items, for anything but the implicit changing,
 * for sell value moving, for idempotence and against the server's load path. It never
 * writes the given file: it is copied to a temp directory first and only the copy is opened.
 * Exits non-zero when any check fails.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountStore } from '../apps/server/src/accounts.js';
import {
  compileSigilItem,
  convertRuneRolls,
  convertImplicits,
  isRuneImplicits1,
  neutralImplicit,
  createStarterSigil,
  OLD_STARTER_RUNES,
  RETIRED_SIGIL_AFFIXES,
  applyTunables,
  clampRuneRolls,
  sixTierRoll,
  isRuneTiers6,
  FORGE,
  sellPrice,
  buyPrice,
  runeRollsChanged,
  type RuneItem,
  type SigilItem,
  toRuneInstance,
  convertCharacterSave,
  convertStash,
  convertStashTabs,
  convertTraderShelf,
  isStashFormat2,
  placements,
  STASH,
  stashItemUids,
  type StashSaveV1,
  isClassId,
  isRuneFormat2,
  isV1RuneId,
  isV1TestSigil,
  starterSigilById,
  V1_TO_V2,
  type ClassId,
  type ConversionReport,
  type Item,
  isItemShape,
  parseGuildStash,
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

const tabTotals = { stashes: 0, runeItems: 0, runeUnits: 0, sigils: 0, stayed: 0 };

/**
 * Checks one stash's grid-to-tabs conversion against the single-grid stash it came from: the same
 * items (whole, by stable JSON), every uid in exactly one tab, items left in tab 1 at their old
 * cells, nothing bound in a list, and converting the result again changes nothing.
 */
function reportTabs(title: string, before: StashSaveV1): void {
  const problems: string[] = [];
  let converted;
  try {
    converted = convertStashTabs(JSON.parse(JSON.stringify(before)));
  } catch (err) {
    failures++;
    console.log(`  FAIL tabs: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const { stash, report: r } = converted;
  tabTotals.stashes++;
  tabTotals.runeItems += r.runesToTab;
  tabTotals.runeUnits += r.runeUnitsToTab;
  tabTotals.sigils += r.sigilsToTab;
  const stayed = r.stayed.reduce((n, x) => n + x.count, 0);
  tabTotals.stayed += stayed;
  const tab1 = stash.general[0];
  console.log(`  tabs: ${r.runesToTab} rune items (${r.runeUnitsToTab} runes) to the rune tab, ${r.sigilsToTab} sigils to the sigil tab, ${tab1 ? placements(tab1.cells, STASH).length : 0} items stay in tab 1${stayed > 0 ? ` (${r.stayed.map((x) => `${x.count} ${x.reason}`).join(', ')})` : ''}`);
  const a = before.items.map(stable).sort();
  const b = stash.items.map(stable).sort();
  check(problems, a.length === b.length && a.every((x, i) => x === b[i]), `items changed: ${a.length} before, ${b.length} after`);
  const places = [...(tab1 ? placements(tab1.cells, STASH).map((p) => p.uid) : []), ...stash.runes.list, ...stash.sigils.list];
  const dup = places.filter((u, i) => places.indexOf(u) !== i);
  check(problems, dup.length === 0, `uid in two tabs: ${[...new Set(dup)].join(', ')}`);
  const beforePlaced = new Set(placements(before.cells.length === STASH.w * STASH.h ? before.cells : [], STASH).map((p) => p.uid));
  const afterPlaced = new Set(stashItemUids(stash));
  const lost = [...beforePlaced].filter((u) => !afterPlaced.has(u));
  check(problems, lost.length === 0, `placed items without a place now: ${lost.join(', ')}`);
  if (tab1 && before.cells.length === STASH.w * STASH.h) {
    const was = new Map(placements(before.cells, STASH).map((p) => [p.uid, `${p.x},${p.y}`]));
    const moved = placements(tab1.cells, STASH).filter((p) => was.get(p.uid) !== `${p.x},${p.y}`);
    check(problems, moved.length === 0, `${moved.length} items left in tab 1 moved cells`);
  }
  const byUid = new Map(stash.items.map((i) => [i.uid, i]));
  const boundListed = [...stash.runes.list, ...stash.sigils.list].filter((u) => {
    const it = byUid.get(u);
    return it?.bound === true || (it?.kind === 'sigil' && it.slots.some((x) => x.bound === true));
  });
  check(problems, boundListed.length === 0, `bound items in a list: ${boundListed.join(', ')}`);
  check(problems, stash.runes.list.every((u) => byUid.get(u)?.kind === 'rune') && stash.sigils.list.every((u) => byUid.get(u)?.kind === 'sigil'), 'a list holds the wrong kind of item');
  const again = convertStashTabs(JSON.parse(JSON.stringify(stash)));
  check(problems, stable(again.stash) === stable(stash) && again.report.runesToTab === 0, 'converting again changed it');
  for (const w of r.warnings) console.log(`  warning (tabs): ${w}`);
  if (problems.length > 0) {
    failures += problems.length;
    for (const p of problems) console.log(`  FAIL tabs: ${p}`);
  } else console.log('  tab checks: ok');
}

const rollTotals = { kitRetiered: 0, kitGold: 0, marked: 0, goldBefore: 0, goldAfter: 0, tierMoves: new Map<string, number>(), containers: 0, sigils: 0, affixesRemoved: 0, renamed: 0, rebuilt: new Map<string, number>(), runesRemoved: 0, runesReturned: 0, retiered: 0, unchanged: 0, edited: 0 };

const recipeText = (s: SigilItem): string => stable(s.slots.map(toRuneInstance));
/** A rune with its roll tiers left out: the pass may only move tiers, to the tier each value falls in among the six. */
const withoutTiers = (r: RuneItem): string => stable({ ...r, affixes: r.affixes.map((a) => ({ id: a.id, value: a.value })) });

/** Every uid with how often it appears, runes inside sigils included. Shelf items all carry uid 0, so only their runes count. */
function uidCounts(items: readonly Item[], shelf: boolean): Counts {
  const m: Counts = new Map();
  for (const it of items) {
    if (!shelf || it.kind !== 'sigil') add(m, shelf ? `shelf ${it.kind}` : String(it.uid), 1);
    if (it.kind === 'sigil') for (const r of it.slots) add(m, String(r.uid), 1);
  }
  return m;
}

/** Each tier change moves a rune roll to the tier its value falls in among the six, and nothing else changes. */
function tiersHonest(before: RuneItem, after: RuneItem): boolean {
  return withoutTiers(before) === withoutTiers(after) && after.affixes.every((a, i) => {
    const b = before.affixes[i];
    return b !== undefined && (a.tier === b.tier || stable(sixTierRoll(b)) === stable(a));
  });
}

/**
 * The old three tiers by name: they were numbered T1 to T3 from the weakest, the reverse of the six
 * tiers' T6 to T1, so printing both as T-numbers would mix the two schemes.
 */
const OLD_TIER_NAMES = ['low', 'middle', 'top'];

/** Sell value per rune affix tier before the six tiers (old low, middle, top). */
const OLD_AFFIX_VALUE = [4, 10, 25];

/** Every rune affix roll in a list, loose or in a sigil, by position, so before and after line up. */
function runeRolls(items: readonly Item[]): RuneItem[] {
  return items.flatMap((i) => (i.kind === 'rune' ? [i] : i.kind === 'sigil' ? i.slots : []));
}

/** What an item sold for before the six tiers: the same base value, rune affixes at the old three tiers' worth. */
function oldSellPrice(item: Item): number {
  if (item.kind === 'sigil') return sellPrice({ ...item, slots: [] }) + item.slots.reduce((n, r) => n + oldSellPrice(r), 0);
  if (item.kind !== 'rune' || item.bound === true) return sellPrice(item);
  const affixes = item.affixes.reduce((n, a) => n + (OLD_AFFIX_VALUE[a.tier] ?? OLD_AFFIX_VALUE[OLD_AFFIX_VALUE.length - 1] ?? 0), 0);
  return (sellPrice({ ...item, affixes: [], count: 1 }) + affixes) * item.count;
}

/** The three tiers every number rune affix had before 2026-10-01, to tell a drop from an old kit roll. */
const OLD_TIERS: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  rune_speed: [[10, 20], [20, 35], [35, 50]],
  rune_size: [[10, 20], [20, 35], [35, 50]],
  rune_duration: [[15, 30], [30, 50], [50, 75]],
  rune_damage: [[10, 20], [20, 35], [35, 55]],
  rune_pierce: [[1, 1], [1, 2], [2, 3]],
  split_count: [[2, 3], [3, 4], [5, 6]],
  rune_concentrated: [[40, 46], [47, 53], [54, 60]],
  release_every: [[0.4, 0.6], [0.3, 0.45], [0.2, 0.3]],
};

/**
 * Gold a re-tier could mint. A drop's roll (inside its old tier) that now sells for 3x what it sold
 * for (the trader's buy multiplier) or more would let anyone who bought it before the deploy sell it
 * back for profit, so it fails. Old kit rolls (outside their stored tier, usually tier 0 whatever
 * the value) go up to their real tier once, as the first rune roll pass did; on unbound runes that
 * is a one-time rise, counted and printed. Bound runes sell for nothing either way.
 */
function goldProblems(before: readonly RuneItem[], after: readonly RuneItem[]): string[] {
  const out: string[] = [];
  before.forEach((b, i) => {
    const a = after[i];
    if (!a || a.uid !== b.uid || b.bound === true) return;
    b.affixes.forEach((x, j) => {
      const y = a.affixes[j];
      // A rebuilt old Multishot or Flame Cleave takes new rolls; only a re-tier keeps the value.
      if (!y || y.tier === x.tier || y.id !== x.id || y.value !== x.value) return;
      const was = OLD_AFFIX_VALUE[x.tier] ?? OLD_AFFIX_VALUE[OLD_AFFIX_VALUE.length - 1] ?? 0;
      const now = FORGE.runeAffixValue[y.tier] ?? 0;
      const old = OLD_TIERS[x.id]?.[x.tier];
      const drop = old !== undefined && x.value >= old[0] && x.value <= old[1];
      if (!drop) {
        rollTotals.kitRetiered++;
        rollTotals.kitGold += (now - was) * b.count;
        return;
      }
      if (now >= was * 3) out.push(`rune ${b.uid} ${x.id} ${x.value}: affix worth ${was} -> ${now}, past the 3x buy price`);
    });
  });
  return out;
}

/**
 * Checks the rune roll pass on one container's items as the earlier conversions left them, and that
 * the server's load path (`loaded`) gives the same result. Only sigils (name, affixes, slots) and
 * rune roll tiers may change; rebuilt old starters hand back their unbound extra runes.
 */
function reportRolls(title: string, before: readonly Item[], loaded: readonly Item[] | null, classId: ClassId, opts: { shelf?: boolean; marked?: boolean; implicitsMarked?: boolean } = {}): Item[] {
  rollTotals.containers++;
  const problems: string[] = [];
  // The server's load path runs the implicit pass after this one, which reportImplicits checks;
  // here its output is compared after the same pass.
  const implicitsOf = (items: readonly Item[]): Item[] => (opts.implicitsMarked ? [...items] : convertImplicits(items).items);
  if (opts.marked) {
    // Already six tiers: the server must load it exactly as stored.
    rollTotals.marked++;
    console.log('  rune rolls: already runeTiers 6; the pass does not run');
    if (loaded !== null) check(problems, stable(loaded) === stable(implicitsOf(opts.shelf ? before.map((x) => ({ ...x, uid: 0 })) : before)), 'the server load path changed a row already marked runeTiers 6');
    if (problems.length > 0) {
      failures += problems.length;
      for (const p of problems) console.log(`  FAIL rolls: ${p}`);
    } else console.log('  roll checks: ok');
    return [...before];
  }
  const { items: after, returned, report: r } = convertRuneRolls(before);
  const oldRolls = runeRolls(before);
  const newRolls = runeRolls(after);
  for (const p of goldProblems(oldRolls, newRolls)) problems.push(p);
  rollTotals.goldBefore += before.reduce((n, i) => n + oldSellPrice(i), 0);
  rollTotals.goldAfter += [...after, ...returned].reduce((n, i) => n + sellPrice(i), 0);
  newRolls.forEach((a, i) => {
    const b = oldRolls[i];
    if (!b || b.uid !== a.uid) return;
    a.affixes.forEach((y, j) => {
      const x = b.affixes[j];
      if (x && x.tier !== y.tier && x.id === y.id && x.value === y.value) add(rollTotals.tierMoves, `old ${OLD_TIER_NAMES[x.tier] ?? `index ${x.tier}`} tier -> T${6 - y.tier}`, 1);
    });
  });
  const removed = r.startersRebuilt.flatMap((x) => x.runesRemoved);
  const back = r.startersRebuilt.flatMap((x) => x.runesReturned);
  rollTotals.sigils += before.filter((i) => i.kind === 'sigil').length;
  rollTotals.affixesRemoved += r.affixesRemoved.length;
  rollTotals.renamed += r.renamed.length;
  rollTotals.runesRemoved += removed.length;
  rollTotals.runesReturned += back.length;
  rollTotals.retiered += r.runesRetiered.length;
  for (const x of r.startersRebuilt) add(rollTotals.rebuilt, x.starter, 1);
  const changed = after.filter((it, i) => it !== before[i]).length;
  rollTotals.unchanged += before.length - changed;
  // Buffed starters that hold neither recipe were changed at the forge and are left as they are.
  const edited = after.filter((it): it is SigilItem => {
    if (it.kind !== 'sigil' || !it.starter || OLD_STARTER_RUNES[it.starter] === undefined) return false;
    const def = starterSigilById(it.starter);
    return def !== undefined && recipeText(it) !== recipeText(createStarterSigil(() => 0, def, { bound: false }));
  });
  rollTotals.edited += edited.length;
  console.log(`  rune rolls: ${changed} of ${before.length} items changed; "first rune is free" removed from ${r.affixesRemoved.length} sigils${r.affixesRemoved.length > 0 ? ` (${r.affixesRemoved.join(', ')})` : ''}; renamed ${r.renamed.map((n) => `${n.from} -> ${n.to}`).join(', ') || 'none'}; starters rebuilt: ${r.startersRebuilt.map((x) => `${x.starter} ${x.sigil} (bound ${x.runesRemoved.join(', ') || 'none'} removed, unbound ${x.runesReturned.join(', ') || 'none'} returned)`).join(', ') || 'none'}; ${r.runesRetiered.length} runes re-tiered`);
  if (edited.length > 0) console.log(`  buffed starters changed at the forge, left alone: ${edited.map((e) => `${e.starter} ${e.uid}`).join(', ')}`);

  check(problems, after.length === before.length, `item count ${before.length} -> ${after.length}`);
  before.forEach((b, i) => {
    const a = after[i];
    if (!a) return;
    if (b.kind === 'rune' && a.kind === 'rune') {
      check(problems, tiersHonest(b, a), `rune ${b.uid} changed beyond its roll tiers`);
      return;
    }
    if (b.kind !== 'sigil' || a.kind !== 'sigil') {
      check(problems, stable(a) === stable(b), `item ${b.uid} (${b.kind}) changed`);
      return;
    }
    const { affixes: _a1, slots: _s1, name: _n1, ...restA } = a;
    const { affixes: _a2, slots: _s2, name: _n2, ...restB } = b;
    check(problems, stable(restA) === stable(restB), `sigil ${b.uid} changed beyond its name, affixes and slots`);
    check(problems, a.name === b.name || r.renamed.some((n) => n.uid === b.uid && n.to === a.name), `sigil ${b.uid} renamed without a report`);
    check(problems, stable(a.affixes) === stable(b.affixes.filter((x) => !RETIRED_SIGIL_AFFIXES.has(x.id))), `sigil ${b.uid} affixes are not its old ones less the retired`);
    const rebuilt = r.startersRebuilt.find((x) => x.sigil === b.uid);
    if (!rebuilt) {
      check(problems, a.slots.length === b.slots.length && a.slots.every((s, j) => {
        const was = b.slots[j];
        return was !== undefined && tiersHonest(was, s);
      }), `sigil ${b.uid} slots changed beyond roll tiers without a rebuild`);
      return;
    }
    const def = starterSigilById(rebuilt.starter);
    check(problems, def !== undefined && recipeText(a) === recipeText(createStarterSigil(() => 0, def, { bound: false })), `rebuilt ${rebuilt.starter} sigil ${b.uid} does not hold the new recipe`);
    check(problems, stable(a.slots.map((x) => x.uid)) === stable(b.slots.slice(0, a.slots.length).map((x) => x.uid)), `rebuilt sigil ${b.uid} did not keep its leading rune uids`);
    check(problems, stable(a.slots.map((x) => x.bound === true)) === stable(b.slots.slice(0, a.slots.length).map((x) => x.bound === true)), `rebuilt sigil ${b.uid} changed a rune's binding`);
    const out = b.slots.slice(a.slots.length);
    check(problems, stable(rebuilt.runesRemoved) === stable(out.filter((x) => x.bound === true).map((x) => x.uid)) && stable(rebuilt.runesReturned) === stable(out.filter((x) => x.bound !== true).map((x) => x.uid)), `rebuilt sigil ${b.uid} reports the wrong runes removed or returned`);
    const c = compileSigilItem(a, def?.classId ?? classId);
    check(problems, c.ok, `rebuilt sigil ${b.uid} does not compile`);
  });
  check(problems, stable(returned.map((x) => x.uid)) === stable(back), 'returned runes are not the reported ones');
  check(problems, returned.every((x) => x.bound !== true && x.count === 1), 'a returned rune is bound or stacked');

  // The uid multiset: what was there, less the bound runes the shorter recipes have no room for, each once.
  const want = uidCounts(before, opts.shelf === true);
  for (const u of removed) add(want, String(u), -1);
  const got = uidCounts([...after, ...returned], opts.shelf === true);
  if (opts.shelf) add(want, 'shelf rune', returned.length);
  check(problems, same(want, got), 'uids do not add up after the pass');
  check(problems, [...got.entries()].every(([k, n]) => k.startsWith('shelf ') || n === 1), 'a uid is in two places after the pass');
  const units = (items: readonly Item[]): { loose: number; inSigils: number } => ({
    loose: items.reduce((n, i) => n + (i.kind === 'rune' ? i.count : 0), 0),
    inSigils: items.reduce((n, i) => n + (i.kind === 'sigil' ? i.slots.length : 0), 0),
  });
  const ub = units(before);
  const ua = units([...after, ...returned]);
  check(problems, ua.loose === ub.loose + back.length, `loose runes ${ub.loose} -> ${ua.loose}, expected ${back.length} more`);
  check(problems, ua.inSigils === ub.inSigils - removed.length - back.length, `runes in sigils ${ub.inSigils} -> ${ua.inSigils}, expected ${removed.length + back.length} fewer`);

  const twice = convertRuneRolls([...after, ...returned]);
  check(problems, !runeRollsChanged(twice.report) && twice.returned.length === 0 && stable(twice.items) === stable([...after, ...returned]), 'a second pass changes something');
  if (loaded !== null) {
    const expected = opts.shelf ? [...after, ...returned.map((x) => ({ ...x, uid: 0 }))] : [...after, ...returned];
    check(problems, stable(loaded) === stable(implicitsOf(expected)), 'the server load path gives other items than the pass');
  }

  if (problems.length > 0) {
    failures += problems.length;
    for (const p of problems) console.log(`  FAIL rolls: ${p}`);
  } else console.log('  roll checks: ok');
  return [...after, ...returned];
}

const implicitTotals = { containers: 0, marked: 0, given: 0, givenInSigils: 0, stacks: 0, units: 0, goldBefore: 0, goldAfter: 0, byImplicit: new Map<string, number>() };

/** A rune without its implicit, to hold the pass to adding that one field. */
const withoutImplicit = (r: RuneItem): string => {
  const { implicit: _i, ...rest } = r;
  return stable(rest);
};

/**
 * Checks the implicit pass on one container's items as the rune roll pass left them, and that the
 * server's load path gives the same: the same items in the same order, every castable rune given
 * the neutral implicit (the middle of T4) and nothing else changed, the uid multiset and rune counts
 * kept, no gold moved, and a second pass changing nothing. A marked row must load as stored.
 */
function reportImplicits(before: readonly Item[], loaded: readonly Item[] | null, opts: { shelf?: boolean; marked?: boolean } = {}): void {
  implicitTotals.containers++;
  const problems: string[] = [];
  const shelfView = (items: readonly Item[]): Item[] => (opts.shelf ? items.map((x) => ({ ...x, uid: 0 })) : [...items]);
  if (opts.marked) {
    implicitTotals.marked++;
    console.log('  implicits: already runeImplicits 1; the pass does not run');
    if (loaded !== null) check(problems, stable(loaded) === stable(shelfView(before)), 'the server load path changed a row already marked runeImplicits 1');
  } else {
    const { items: after, report } = convertImplicits(before);
    const runesBefore = runeRolls(before);
    const runesAfter = runeRolls(after);
    const inSigils = before.reduce((n, i) => n + (i.kind === 'sigil' ? i.slots.filter((r) => r.implicit === undefined && neutralImplicit(r.rune) !== null).length : 0), 0);
    implicitTotals.given += report.runesGiven.length;
    implicitTotals.givenInSigils += inSigils;
    for (const r of before) if (r.kind === 'rune' && r.implicit === undefined && neutralImplicit(r.rune) !== null) {
      implicitTotals.stacks++;
      implicitTotals.units += r.count;
    }
    for (const r of runesAfter) if (r.implicit) add(implicitTotals.byImplicit, `${r.implicit.id} ${r.implicit.value} T${6 - r.implicit.tier}`, r.count);
    const goldBefore = before.reduce((n, i) => n + sellPrice(i), 0);
    const goldAfter = after.reduce((n, i) => n + sellPrice(i), 0);
    implicitTotals.goldBefore += goldBefore;
    implicitTotals.goldAfter += goldAfter;
    console.log(`  implicits: ${report.runesGiven.length} runes given the neutral implicit (${inSigils} in sigils); sell value ${goldBefore} -> ${goldAfter}`);
    check(problems, after.length === before.length, `item count ${before.length} -> ${after.length}`);
    before.forEach((b, i) => {
      const a = after[i];
      if (!a) return;
      if (b.kind === 'rune' && a.kind === 'rune') {
        check(problems, withoutImplicit(a) === withoutImplicit(b), `rune ${b.uid} changed beyond its implicit`);
        return;
      }
      if (b.kind === 'sigil' && a.kind === 'sigil') {
        const { slots: _s1, ...restA } = a;
        const { slots: _s2, ...restB } = b;
        check(problems, stable(restA) === stable(restB), `sigil ${b.uid} changed beyond its runes' implicits`);
        check(problems, a.slots.length === b.slots.length && a.slots.every((r, j) => b.slots[j] !== undefined && withoutImplicit(r) === withoutImplicit(b.slots[j] ?? r)), `sigil ${b.uid} slots changed beyond their implicits`);
        return;
      }
      check(problems, stable(a) === stable(b), `item ${b.uid} (${b.kind}) changed`);
    });
    runesAfter.forEach((r, i) => {
      const was = runesBefore[i];
      const neutral = neutralImplicit(r.rune);
      if (!was || neutral === null) return;
      if (was.implicit !== undefined) check(problems, stable(r.implicit) === stable(was.implicit), `rune ${r.uid} had an implicit and it changed`);
      else check(problems, stable(r.implicit) === stable(neutral), `rune ${r.uid} did not get the neutral implicit`);
    });
    check(problems, same(uidCounts(before, opts.shelf === true), uidCounts(after, opts.shelf === true)), 'uids do not add up after the implicit pass');
    const units = (items: readonly Item[]): number => runeRolls(items).reduce((n, r) => n + r.count, 0);
    check(problems, units(after) === units(before), `rune units ${units(before)} -> ${units(after)}`);
    check(problems, goldAfter === goldBefore, `sell value moved: ${goldBefore} -> ${goldAfter}`);
    const again = convertImplicits(after);
    check(problems, again.report.runesGiven.length === 0 && stable(again.items) === stable(after), 'a second implicit pass changes something');
    if (loaded !== null) check(problems, stable(loaded) === stable(shelfView(after)), 'the server load path gives other items than the implicit pass');
  }
  if (problems.length > 0) {
    failures += problems.length;
    for (const p of problems) console.log(`  FAIL implicits: ${p}`);
  } else console.log('  implicit checks: ok');
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
  // The server's own load path, on the same private copy, to hold the roll pass to what a join gets.
  const store = new AccountStore(copy);
  try {
    console.log(`v1 to v2 conversion check of ${src} (read-only copy)`);
    // Rebuilt sigils compile at the live numbers, so check them at the overrides the server would
    // load from this database, not only the code defaults.
    const tuning = store.tunables.load();
    applyTunables(tuning);
    console.log(`live tuning in this database: ${Object.keys(tuning).length} overrides${Object.keys(tuning).length > 0 ? ` (${Object.entries(tuning).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
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
        const loaded = store.loadCharacter(accountId, Number(row.id))?.save;
        if (!loaded) {
          failures++;
          console.log('  FAIL rolls: the server cannot load this save');
        }
        const rolled = reportRolls(title, save.items, loaded?.items ?? null, classId, { marked: isRuneTiers6(raw), implicitsMarked: isRuneImplicits1(raw) });
        reportImplicits(rolled, loaded?.items ?? null, { marked: isRuneImplicits1(raw) });
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
        const classId = classByAccount.get(Number(row.id)) ?? 'mage';
        // As loadStash does: a stash already in tabs goes straight to the tab check, which leaves it as it is.
        let tabbed: unknown = raw;
        if (isStashFormat2(raw)) console.log(`\n${title}\n  already in tabs`);
        else {
          const { stash, report: r } = convertStash(raw);
          const rawItems = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
          report(title, rawItems, 0, null, stash.items, r, classId, { alreadyV2: isRuneFormat2(raw) });
          reportTabs(title, stash);
          tabbed = stash;
        }
        const loaded = store.loadStash(Number(row.id));
        if (loaded === null || loaded === 'unreadable') {
          failures++;
          console.log('  FAIL rolls: the server cannot load this stash');
        }
        const loadedItems = loaded === null || loaded === 'unreadable' ? null : loaded.stash.items;
        const rolled = reportRolls(title, convertStashTabs(tabbed).stash.items, loadedItems, classId, { marked: isRuneTiers6(raw), implicitsMarked: isRuneImplicits1(raw) });
        reportImplicits(rolled, loadedItems, { marked: isRuneImplicits1(raw) });
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
        const loadedShelf = store.loadMarket().stock.map((e) => e.item);
        const rolled = reportRolls('trader shelf', shelf.stock.map((e) => e.item), loadedShelf, 'mage', { shelf: true, marked: isRuneTiers6(raw), implicitsMarked: isRuneImplicits1(raw) });
        reportImplicits(rolled, loadedShelf, { shelf: true, marked: isRuneImplicits1(raw) });
      } catch (err) {
        failures++;
        console.log(`\ntrader shelf\n  FAIL: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else console.log('\ntrader shelf: none stored');
    // Guild stashes (docs/features/guilds.md) carry the same markers and take the same pass on load.
    const hasGuilds = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'guilds'").length > 0;
    for (const row of hasGuilds ? rows(db, 'SELECT id, name, stash_json FROM guilds ORDER BY id') : []) {
      const title = `guild stash ${String(row.id)} "${String(row.name)}"`;
      try {
        const raw: unknown = typeof row.stash_json === 'string' ? JSON.parse(row.stash_json) : null;
        const stored = isRecord(raw) && Array.isArray(raw.items) ? raw.items.filter(isItemShape) : [];
        console.log(`\n${title}`);
        const loadedGuild = [...parseGuildStash(raw).stash.items.values()];
        const rolled = reportRolls(title, stored, loadedGuild, 'mage', { marked: isRuneTiers6(raw), implicitsMarked: isRuneImplicits1(raw) });
        reportImplicits(rolled, loadedGuild, { marked: isRuneImplicits1(raw) });
      } catch (err) {
        failures++;
        console.log(`\n${title}\n  FAIL: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    `\nrune rolls: ${rollTotals.containers} rows, ${rollTotals.sigils} sigils; "first rune is free" removed from ${rollTotals.affixesRemoved} (${rollTotals.renamed} renamed); starters rebuilt: ${show(rollTotals.rebuilt)} (${rollTotals.runesRemoved} bound runes removed, ${rollTotals.runesReturned} unbound returned); ${rollTotals.retiered} runes re-tiered (${show(rollTotals.tierMoves)}); sell value of every row ${rollTotals.goldBefore} gold before, ${rollTotals.goldAfter} after; ${rollTotals.kitRetiered} unbound old kit rolls rose to their tier once (+${rollTotals.kitGold} gold of sell value); ${rollTotals.marked} rows already runeTiers 6; ${rollTotals.edited} buffed starters changed at the forge and left alone; ${rollTotals.unchanged} items untouched`,
  );
  console.log(
    `implicits: ${implicitTotals.containers} rows (${implicitTotals.marked} already runeImplicits 1); ${implicitTotals.given} runes given the neutral implicit (${implicitTotals.givenInSigils} in sigils, ${implicitTotals.stacks} loose items holding ${implicitTotals.units} runes); sell value of every row ${implicitTotals.goldBefore} gold before, ${implicitTotals.goldAfter} after; runes by implicit: ${show(implicitTotals.byImplicit)}`,
  );
  console.log(
    `summary: ${totals.containers} rows, ${totals.v1Runes} loose or hand-inscribed v1 runes -> ${totals.v2Runes} v2 runes + ${totals.refunded} to gold (${totals.gold} gold paid), ${totals.starters} starter sigils (${totals.replaced} v1 skill-sigil runes replaced by ${totals.starterRunes} starter runes), ${totals.compiled}/${totals.sigils} sigils compile, ${totals.warnings} warnings, ${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`,
  );
  console.log(`tabs: ${tabTotals.stashes} stashes to tabs, ${tabTotals.runeItems} rune items (${tabTotals.runeUnits} runes) to rune tabs, ${tabTotals.sigils} sigils to sigil tabs, ${tabTotals.stayed} runes or sigils left in tab 1`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
