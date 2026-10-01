import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  BALANCE_SPELLS,
  BENCH_MARKS,
  compileRunes,
  compileSigilItem,
  createRune,
  createStarterSigil,
  DEFAULT_SIGIL_CONTEXT,
  measureSkill,
  measureStarter,
  perForce,
  STARTER_SIGILS,
  tokenizeSpell,
  type AffixId,
  type ClassId,
  type RuneId,
  type SigilCompile,
  type SigilItem,
  type SkillDpsResult,
} from '../src/index.js';

// Vitest runs in Node; the shared package builds without Node's types.
declare const console: { log(message: string): void };

/**
 * Force has to buy damage at about the kits' rate, whatever the runes. Each spell here is measured
 * with the same harness as the parity pass against the best kit skill's damage per Force, to one
 * target and to a pack. The owner made that a report, not a limit (2026-10-01): the tests fail only
 * above LIMIT times the best kit, to catch a broken combination, and print every spell past REPORT.
 */
const LIMIT = BENCH_MARKS.hard;
const REPORT = BENCH_MARKS.soft;

const SELF_CENTRED = new Set(['nova', 'zone', 'dash']);
const CLASS_IDS: readonly ClassId[] = ['warrior', 'ranger', 'mage', 'priest', 'binder'];

function measureCompiled(text: string, classId: ClassId, compiled: SigilCompile): SkillDpsResult {
  const shape = tokenizeSpell(text).runes[0]?.id ?? 'bolt';
  return measureSkill({
    classId,
    equip: () => ({ uid: -1, compiled, misfireMultiplier: 1, castDelayShare: 1 }),
    ...(SELF_CENTRED.has(shape) ? { distance: 40 } : {}),
  });
}

function measureText(text: string, multicast = 1, classId: ClassId = 'mage'): SkillDpsResult {
  const compiled = compileRunes(tokenizeSpell(text).runes, { ...DEFAULT_SIGIL_CONTEXT, classId, multicast });
  if (!compiled.ok) throw new Error(`${text}: ${compiled.errors.map((e) => e.message).join('; ')}`);
  return measureCompiled(text, classId, compiled);
}

/** mulberry32: a fixed seed gives the same spells on every run and machine. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The lowest and highest roll of an affix over all its tiers, T1 included, as the drop table has
 * them; with `top`, only its best tier (T1, the last), so a search can be made of the rarest rolls.
 */
function span(id: AffixId, top = false): [number, number] {
  const all = AFFIXES[id].tiers;
  const tiers = top ? all.slice(-1) : all;
  return [Math.min(...tiers.map((t) => t.min)), Math.max(...tiers.map((t) => t.max))];
}

/**
 * Random spells from the castable runes, with affixes anywhere in their drop tables
 * (data/affixes.ts), the rare T1 included: speed, size, duration, damage, pierce, every and after
 * from the table, Split 2 to 6. With `concentrated`, shapes with an area also get Concentrated
 * runes (40 to 60%, at most one on a shape) and sometimes a Large beside them. With `top`, every
 * number affix rolls in its T1 range.
 */
function randomSpell(rnd: () => number, concentrated = false, top = false): { text: string; multicast: number } {
  const pick = <T,>(list: readonly T[], fallback: T): T => list[Math.floor(rnd() * list.length)] ?? fallback;
  const between = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
  const pct = (id: AffixId): string => `+${Math.round(between(...span(id, top)))}%`;
  const [pierceLo, pierceHi] = span('rune_pierce', top);
  const pierce = (): string => `pierce ${pierceLo + Math.floor(rnd() * (pierceHi - pierceLo + 1))}`;
  const numbers: Record<string, (() => string)[]> = {
    orb: [() => `${pct('rune_damage')} damage`, () => `${pct('rune_duration')} duration`, () => `${pct('rune_size')} size`, () => `${pct('rune_speed')} speed`, pierce],
    bolt: [() => `${pct('rune_damage')} damage`, () => `${pct('rune_duration')} duration`, () => `${pct('rune_size')} size`, () => `${pct('rune_speed')} speed`, pierce],
    zone: [() => `${pct('rune_damage')} damage`, () => `${pct('rune_duration')} duration`, () => `${pct('rune_size')} size`],
    nova: [() => `${pct('rune_damage')} damage`, () => `${pct('rune_size')} size`],
    dash: [() => `${pct('rune_damage')} damage`, () => `${pct('rune_speed')} speed`],
  };
  const every = (): string => `every ${between(...span('release_every', top)).toFixed(2)}s`;
  const after = (): string => `after ${between(...span('release_after')).toFixed(1)}s`;
  const releases: Record<string, readonly string[]> = {
    orb: ['onhit', 'onexpire', 'after', 'every'],
    bolt: ['onhit', 'onexpire', 'after', 'every'],
    zone: ['onexpire', 'after', 'every'],
    nova: ['onexpire', 'after'],
    dash: ['onhit', 'onland', 'after'],
  };
  const shapeText = (shape: string, release: boolean): string => {
    const pool = [...(numbers[shape] ?? [])];
    const parts: string[] = [];
    if (release) {
      const kind = pick(releases[shape] ?? [], 'onexpire');
      parts.push(kind === 'every' ? every() : kind === 'after' ? after() : kind);
    }
    for (let n = Math.floor(rnd() * (release ? 3 : 4)); n > 0 && pool.length > 0; n--) {
      const [roll] = pool.splice(Math.floor(rnd() * pool.length), 1);
      if (roll) parts.push(roll());
    }
    return parts.length > 0 ? `${shape}[${parts.join(', ')}]` : shape;
  };
  const words: string[] = [];
  let shape = pick(['orb', 'bolt', 'nova', 'zone', 'dash', 'orb', 'zone'], 'orb');
  const depth = 1 + Math.floor(rnd() * 3);
  for (let level = 0; ; level++) {
    const release = level < depth && rnd() < 0.9;
    const pulse = release && shape !== 'nova' && shape !== 'dash' && rnd() < 0.15;
    words.push(shapeText(shape, release && !pulse));
    if (pulse) words.push('pulse');
    for (let n = Math.floor(rnd() * 3); n > 0; n--) words.push(pick(['fire', 'cold', 'lightning', 'lightning'], 'fire'));
    if (concentrated && shape !== 'dash' && rnd() < 0.6) {
      words.push(`concentrated(${Math.round(between(40, 60))})`);
      if (rnd() < 0.25) words.push('large');
    }
    if (rnd() < 0.3) words.push(`split(${2 + Math.floor(rnd() * 5)})`);
    if (!release) break;
    shape = pick(['nova', 'zone', 'bolt', 'orb', 'nova'], 'nova');
  }
  return { text: words.join(' '), multicast: rnd() < 0.25 ? 2 : 1 };
}

/** The class a spell is cheapest on, since a player would cast it there. */
function cheapest(text: string, multicast: number): { classId: ClassId; compiled: SigilCompile } | null {
  const runes = tokenizeSpell(text).runes;
  if (runes.length > DEFAULT_SIGIL_CONTEXT.slots) return null;
  let best: { classId: ClassId; compiled: SigilCompile } | null = null;
  for (const classId of CLASS_IDS) {
    const compiled = compileRunes(runes, { ...DEFAULT_SIGIL_CONTEXT, classId, multicast });
    if (!compiled.ok) return null;
    if (!best || compiled.force < best.compiled.force) best = { classId, compiled };
  }
  return best;
}

/**
 * Kit runes kept in their sigil but not as the whole kit: every prefix left in place, every single
 * rune moved to the front, each alone and with an infusion or a Split appended. Kits hold only
 * in-table rolls, so these are ordinary spells; they stay to show how the kits' pieces measure.
 */
const APPENDED: readonly (readonly RuneId[])[] = [[], ['lightning'], ['fire'], ['cold'], ['lightning', 'lightning']];

function starterPieces(): { label: string; sigil: SigilItem }[] {
  let uid = 1;
  const out: { label: string; sigil: SigilItem }[] = [];
  for (const def of STARTER_SIGILS) {
    const whole = createStarterSigil(() => uid++, def, { bound: false });
    const kept: { what: string; slots: SigilItem['slots'] }[] = [];
    for (let k = 1; k <= whole.slots.length; k++) kept.push({ what: `first ${k}`, slots: whole.slots.slice(0, k) });
    whole.slots.forEach((r, i) => {
      if (i > 0) kept.push({ what: `rune ${i + 1} alone`, slots: [r] });
    });
    for (const { what, slots } of kept) {
      for (const extra of APPENDED) {
        if (slots.length === whole.slots.length && extra.length === 0) continue;
        const added = extra.map((id) => createRune(uid++, id));
        out.push({ label: `${def.id} ${what}${extra.length > 0 ? ` + ${extra.join(' ')}` : ''}`, sigil: { ...whole, slots: [...slots, ...added] } });
      }
    }
  }
  return out;
}

const RANDOM_SPELLS = 300;
const RANDOM_SEED = 20260930;
const CONCENTRATED_SEED = 20261001;
const T1_SEED = 20261002;

describe('damage per Force', () => {
  const starters = STARTER_SIGILS.map((def) => ({ id: def.id, r: measureStarter(def) })).filter((s) => s.r.kind === 'damage');
  const best = {
    single: Math.max(...starters.map((s) => perForce(s.r).single)),
    pack: Math.max(...starters.map((s) => perForce(s.r).pack)),
  };
  const rows = BALANCE_SPELLS.map((s) => ({ text: s.text, r: measureText(s.text, s.multicast, s.classId) }));

  it('prints the table', () => {
    const f = (n: number): string => n.toFixed(2);
    const lines = [
      `best kit: ${f(best.single)} single / ${f(best.pack)} pack per Force; fails above ${LIMIT}x, reports past ${REPORT}x`,
      ['spell', 'Force', 'single / pack', 'per Force', 'x best'].join(' | '),
      ...rows.map(({ text, r }) => {
        const pf = perForce(r);
        return [text, r.forcePerCast, `${r.single} / ${r.pack}`, `${f(pf.single)} / ${f(pf.pack)}`, `${f(pf.single / best.single)} / ${f(pf.pack / best.pack)}`].join(' | ');
      }),
    ];
    console.log(`\n${lines.join('\n')}\n`);
    expect(rows.length).toBe(BALANCE_SPELLS.length);
  });

  it(`no spell deals more than ${LIMIT}x the best kit's damage per Force, and those past ${REPORT}x are listed`, () => {
    const past: string[] = [];
    for (const { text, r } of rows) {
      const pf = perForce(r);
      const ratio = Math.max(pf.single / best.single, pf.pack / best.pack);
      if (ratio > REPORT) past.push(`${ratio.toFixed(2)}x ${text}`);
      expect(pf.single, `${text} single`).toBeLessThanOrEqual(best.single * LIMIT);
      expect(pf.pack, `${text} pack`).toBeLessThanOrEqual(best.pack * LIMIT);
    }
    console.log(`\nhand-picked spells past ${REPORT}x: ${past.length > 0 ? `\n${past.join('\n')}` : 'none'}\n`);
  });

  it(`kit runes kept without the rest of their kit stay within ${LIMIT}x on their cheapest class`, () => {
    let measured = 0;
    let worst = { label: '', ratio: 0 };
    for (const { label, sigil } of starterPieces()) {
      let best1: { classId: ClassId; compiled: SigilCompile } | null = null;
      for (const classId of CLASS_IDS) {
        const compiled = compileSigilItem(sigil, classId);
        if (compiled.ok && (!best1 || compiled.force < best1.compiled.force)) best1 = { classId, compiled };
      }
      if (!best1 || !best1.compiled.ok || best1.compiled.persistent) continue;
      const r = measureSkill({
        classId: best1.classId,
        equip: () => ({ uid: -1, compiled: best1.compiled, misfireMultiplier: 1, castDelayShare: 1 }),
        ...(SELF_CENTRED.has(sigil.slots[0]?.rune ?? 'bolt') ? { distance: 40 } : {}),
      });
      if (r.kind !== 'damage') continue;
      measured++;
      const pf = perForce(r);
      const ratio = Math.max(pf.single / best.single, pf.pack / best.pack);
      if (ratio > worst.ratio) worst = { label: `${best1.classId}: ${label}`, ratio };
      expect(pf.single, `${label} single on ${best1.classId}`).toBeLessThanOrEqual(best.single * LIMIT);
      expect(pf.pack, `${label} pack on ${best1.classId}`).toBeLessThanOrEqual(best.pack * LIMIT);
    }
    console.log(`\nkit pieces: ${measured} measured; worst ${worst.ratio.toFixed(2)}x, ${worst.label}\n`);
    expect(measured).toBeGreaterThan(50);
  }, 60_000);

  for (const search of [
    { what: 'random spells', seed: RANDOM_SEED, concentrated: false },
    { what: 'random spells with Concentrated', seed: CONCENTRATED_SEED, concentrated: true },
    { what: 'random spells of T1 rolls only', seed: T1_SEED, concentrated: true, top: true },
  ]) {
    it(`${RANDOM_SPELLS} ${search.what} with in-table affixes stay within ${LIMIT}x on their cheapest class`, () => {
      const rnd = seeded(search.seed);
      let measured = 0;
      let worst = { text: '', ratio: 0 };
      for (let i = 0; i < RANDOM_SPELLS; i++) {
        const { text, multicast } = randomSpell(rnd, search.concentrated, search.top === true);
        const found = cheapest(text, multicast);
        if (!found) continue;
        measured++;
        const pf = perForce(measureCompiled(text, found.classId, found.compiled));
        const ratio = Math.max(pf.single / best.single, pf.pack / best.pack);
        if (ratio > worst.ratio) worst = { text: `${found.classId}${multicast > 1 ? ' multicast 2' : ''}: ${text}`, ratio };
        expect(pf.single, `${text} single on ${found.classId}`).toBeLessThanOrEqual(best.single * LIMIT);
        expect(pf.pack, `${text} pack on ${found.classId}`).toBeLessThanOrEqual(best.pack * LIMIT);
      }
      console.log(`\n${search.what}: ${measured} of ${RANDOM_SPELLS} compiled; worst ${worst.ratio.toFixed(2)}x, ${worst.text}\n`);
      // Most random lists compile, so the search is not quietly measuring nothing.
      expect(measured).toBeGreaterThan(RANDOM_SPELLS / 2);
    }, 60_000);
  }
});
