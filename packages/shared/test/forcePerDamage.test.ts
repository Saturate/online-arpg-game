import { describe, expect, it } from 'vitest';
import { compileRunes, compileSigilItem, createRune, createStarterSigil, DEFAULT_SIGIL_CONTEXT, HEAT, STARTER_SIGILS, tokenizeSpell, type ClassId, type RuneId, type SigilCompile, type SigilItem } from '../src/index.js';
import { measureStarter } from './harness/parity.js';
import { measureSkill, type SkillDpsResult } from './harness/skillDps.js';

// Vitest runs in Node; the shared package builds without Node's types.
declare const console: { log(message: string): void };

/**
 * Force has to buy damage at about the starters' rate, whatever the runes. Each spell here is
 * measured with the same harness as the parity pass and held to at most BOUND times the best
 * starter's damage per Force, to one target and to a pack.
 */
const BOUND = 2;

/** Spells that once dealt far more per Force than any starter, and neighbours of them. */
const SPELLS: readonly { text: string; multicast?: number; classId?: ClassId }[] = [
  // Repeating payloads, then faster and nested variants.
  { text: 'nova[+50% size] lightning' },
  { text: 'orb[every 0.2s] lightning nova' },
  { text: 'zone[every 0.2s] lightning nova' },
  { text: 'zone[every 0.1s] lightning nova' },
  { text: 'zone[every 0.2s] lightning bolt[pierce 4]' },
  { text: 'orb[every 0.2s] lightning bolt' },
  { text: 'orb[every 0.2s] lightning zone' },
  { text: 'orb[every 0.2s] cold split(3) bolt' },
  // Split payloads and split parents that each release a full payload.
  { text: 'zone[every 0.2s] split(6) nova' },
  { text: 'orb[every 0.2s] lightning split(6) nova' },
  { text: 'orb[onhit] fire split(6) nova' },
  { text: 'bolt split(6) onhit fire nova' },
  { text: 'bolt[pierce 4] onhit fire nova' },
  // A ring of piercing orbs from a shape that sits on the pack: every copy lands.
  { text: 'zone[every 0.2s, +75% duration] cold split(2) orb[+50% size, +55% damage] lightning fire cold' },
  { text: 'bolt[onhit, +50% speed, +55% damage] lightning zone[every 0.2s, +55% damage, +75% duration] lightning split(3) orb[+55% damage, +50% size]', classId: 'ranger' },
  { text: 'bolt[onexpire] zone[+55% damage, +75% duration, +50% size] pulse fire cold orb split(2)', classId: 'ranger' },
  { text: 'zone[every 0.2s, +50% size, +75% duration] lightning fire orb[+50% size, +55% damage] split(3)' },
  { text: 'bolt[onhit, +50% speed] zone[every 0.2s, +50% size, +55% damage] lightning lightning bolt[+55% damage] cold split(6)', classId: 'ranger' },
  // One aimed shape from a shape that stays put: every spawn reaches the target.
  { text: 'zone[every 0.2s] lightning bolt', classId: 'ranger' },
  { text: 'zone[every 0.2s, +55% damage, +75% duration] fire lightning bolt', classId: 'ranger' },
  { text: 'nova[after 0.3s, +50% size, +55% damage] zone[+75% duration, +50% size, +55% damage] pulse lightning lightning bolt', classId: 'ranger' },
  { text: 'orb[onhit] lightning zone[every 0.2s, +75% duration, +55% damage] orb', multicast: 2 },
  // The Pulse rune against the every affix.
  { text: 'zone pulse lightning nova' },
  { text: 'orb pulse lightning nova' },
  { text: 'bolt pulse lightning nova' },
  // Multicast.
  { text: 'nova lightning nova fire', multicast: 2 },
  { text: 'nova lightning zone fire', multicast: 2 },
  { text: 'zone[every 0.2s] lightning nova zone', multicast: 2 },
  // Doubled and mixed infusions.
  { text: 'nova lightning lightning lightning' },
  { text: 'nova fire cold lightning' },
  { text: 'bolt fire fire fire fire' },
  { text: 'zone fire fire fire fire' },
  // Once-off payloads, plain and rolled.
  { text: 'nova[after 0.1s] lightning nova[after 0.1s] nova' },
  { text: 'zone[onexpire] lightning nova' },
  { text: 'dash[onland] lightning nova[+50% size]' },
  { text: 'bolt[after 0.3s] nova[+50% size, +55% damage]', classId: 'ranger' },
  { text: 'bolt[onhit] nova[+50% size, +55% damage] lightning lightning', classId: 'ranger' },
  { text: 'bolt[onhit] nova[+50% size, +55% damage] lightning lightning' },
  // Elements on a once-off payload.
  { text: 'bolt[after 0.3s] bolt lightning fire', classId: 'ranger' },
  { text: 'nova[onexpire] zone[after 0.3s, +55% damage] fire cold nova[+55% damage, +50% size] lightning' },
  { text: 'bolt[after 0.3s, +55% damage] nova[onexpire, +50% size, +55% damage] cold cold zone[+55% damage, +75% duration, +50% size] cold lightning', classId: 'ranger' },
  // Stationary roots with a payload, once the cheapest spells a waived first rune reached.
  { text: 'nova[onexpire, +55% damage] zone[+55% damage]', classId: 'warrior' },
  { text: 'zone[after 1.2s] nova[+55% damage]', classId: 'warrior' },
  { text: 'nova[+55% damage]', classId: 'warrior' },
  // Concentrated: alone, stacked with damage rolls and other Concentrated runes, beside Large, and on payloads.
  { text: 'nova concentrated(60)' },
  { text: 'nova lightning concentrated(60)' },
  { text: 'nova[+55% damage] concentrated(60)', classId: 'warrior' },
  { text: 'nova[+55% damage] lightning concentrated(60) concentrated(60)' },
  { text: 'nova[+55% damage, +50% size] concentrated(60) large', classId: 'warrior' },
  { text: 'nova[+50% size] lightning large concentrated(60) concentrated(60)' },
  { text: 'zone[+55% damage, +75% duration] fire concentrated(60)' },
  { text: 'zone[+55% damage, +75% duration] fire concentrated(60) concentrated(60) concentrated(60)' },
  { text: 'bolt concentrated(60)', classId: 'ranger' },
  { text: 'bolt[+55% damage, pierce 3] concentrated(60) concentrated(60) concentrated(60)', classId: 'ranger' },
  { text: 'bolt[+55% damage] lightning concentrated(60) concentrated(60) concentrated(60) concentrated(60)', classId: 'ranger' },
  { text: 'orb[+55% damage] lightning concentrated(60) concentrated(60)' },
  { text: 'bolt[onhit] fire nova[+55% damage] concentrated(60)', classId: 'ranger' },
  { text: 'bolt[onhit] nova[+55% damage, +50% size] lightning lightning concentrated(60) large', classId: 'ranger' },
  { text: 'zone[every 0.2s] lightning nova concentrated(60)' },
  { text: 'zone[every 0.2s, +55% damage, +75% duration] fire lightning bolt concentrated(60)', classId: 'ranger' },
  { text: 'orb[every 0.2s] cold split(3) bolt concentrated(60)' },
  { text: 'nova[onexpire] zone[after 0.3s, +55% damage] fire cold concentrated(60) nova[+55% damage, +50% size] lightning concentrated(60)' },
  { text: 'orb[onhit] fire concentrated(60) split(6) nova concentrated(60)' },
];

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

/** Damage per point of Force spent over the run. */
function perForce(r: SkillDpsResult): { single: number; pack: number } {
  const spent = (r.forcePerCast ?? 0) * (r.casts ?? 0);
  if (spent <= 0) return { single: 0, pack: 0 };
  return { single: (r.single ?? 0) / spent, pack: (r.pack ?? 0) / spent };
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
 * Random spells from the castable runes, with affixes inside their drop tables (data/affixes.ts):
 * speed and size up to +50%, duration up to +75%, damage up to +55%, pierce up to 3, every 0.2 to
 * 0.6 s, after 0.3 to 1.2 s, Split 2 to 6. With `concentrated`, shapes with an area also get
 * Concentrated runes (40 to 60%, one or two on a shape) and sometimes a Large beside them.
 */
function randomSpell(rnd: () => number, concentrated = false): { text: string; multicast: number } {
  const pick = <T,>(list: readonly T[], fallback: T): T => list[Math.floor(rnd() * list.length)] ?? fallback;
  const between = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
  const pct = (lo: number, hi: number): string => `+${Math.round(between(lo, hi))}%`;
  const numbers: Record<string, (() => string)[]> = {
    orb: [() => `${pct(10, 55)} damage`, () => `${pct(15, 75)} duration`, () => `${pct(10, 50)} size`, () => `${pct(10, 50)} speed`, () => `pierce ${1 + Math.floor(rnd() * 3)}`],
    bolt: [() => `${pct(10, 55)} damage`, () => `${pct(15, 75)} duration`, () => `${pct(10, 50)} size`, () => `${pct(10, 50)} speed`, () => `pierce ${1 + Math.floor(rnd() * 3)}`],
    zone: [() => `${pct(10, 55)} damage`, () => `${pct(15, 75)} duration`, () => `${pct(10, 50)} size`],
    nova: [() => `${pct(10, 55)} damage`, () => `${pct(10, 50)} size`],
    dash: [() => `${pct(10, 55)} damage`, () => `${pct(10, 50)} speed`],
  };
  const every = (): string => `every ${between(0.2, 0.6).toFixed(2)}s`;
  const after = (): string => `after ${between(0.3, 1.2).toFixed(1)}s`;
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
      for (let n = 1 + Math.floor(rnd() * 2); n > 0; n--) words.push(`concentrated(${Math.round(between(40, 60))})`);
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
 * Starter runes kept in their sigil but not as the whole starter: every prefix left in place, every
 * single rune moved to the front, each alone and with an infusion or a Split appended. A starter's
 * hand-set rolls are balanced only for the whole starter (Multishot's Bolt alone at +300% damage
 * dealt 2.85x), so these must cast like any in-table spell.
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

describe('damage per Force', () => {
  const starters = STARTER_SIGILS.map((def) => ({ id: def.id, r: measureStarter(def) })).filter((s) => s.r.kind === 'damage');
  const best = {
    single: Math.max(...starters.map((s) => perForce(s.r).single)),
    pack: Math.max(...starters.map((s) => perForce(s.r).pack)),
  };
  const rows = SPELLS.map((s) => ({ text: s.text, r: measureText(s.text, s.multicast, s.classId) }));

  it('prints the table', () => {
    const f = (n: number): string => n.toFixed(2);
    const lines = [
      `best starter: ${f(best.single)} single / ${f(best.pack)} pack per Force; bound ${BOUND}x`,
      ['spell', 'Force', 'single / pack', 'per Force', 'x best'].join(' | '),
      ...rows.map(({ text, r }) => {
        const pf = perForce(r);
        return [text, r.forcePerCast, `${r.single} / ${r.pack}`, `${f(pf.single)} / ${f(pf.pack)}`, `${f(pf.single / best.single)} / ${f(pf.pack / best.pack)}`].join(' | ');
      }),
    ];
    console.log(`\n${lines.join('\n')}\n`);
    expect(rows.length).toBe(SPELLS.length);
  });

  it(`no spell deals more than ${BOUND}x the best starter's damage per Force`, () => {
    for (const { text, r } of rows) {
      const pf = perForce(r);
      expect(pf.single, `${text} single`).toBeLessThanOrEqual(best.single * BOUND);
      expect(pf.pack, `${text} pack`).toBeLessThanOrEqual(best.pack * BOUND);
    }
  });

  it(`starter runes kept without the rest of their starter stay within ${BOUND}x on their cheapest class`, () => {
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
      expect(pf.single, `${label} single on ${best1.classId}`).toBeLessThanOrEqual(best.single * BOUND);
      expect(pf.pack, `${label} pack on ${best1.classId}`).toBeLessThanOrEqual(best.pack * BOUND);
    }
    console.log(`\nstarter pieces: ${measured} measured; worst ${worst.ratio.toFixed(2)}x, ${worst.label}\n`);
    expect(measured).toBeGreaterThan(50);
  }, 60_000);

  for (const search of [
    { what: 'random spells', seed: RANDOM_SEED, concentrated: false },
    { what: 'random spells with Concentrated', seed: CONCENTRATED_SEED, concentrated: true },
  ]) {
    it(`${RANDOM_SPELLS} ${search.what} with in-table affixes stay within ${BOUND}x on their cheapest class`, () => {
      const rnd = seeded(search.seed);
      let measured = 0;
      let worst = { text: '', ratio: 0 };
      for (let i = 0; i < RANDOM_SPELLS; i++) {
        const { text, multicast } = randomSpell(rnd, search.concentrated);
        const found = cheapest(text, multicast);
        if (!found) continue;
        measured++;
        const pf = perForce(measureCompiled(text, found.classId, found.compiled));
        const ratio = Math.max(pf.single / best.single, pf.pack / best.pack);
        if (ratio > worst.ratio) worst = { text: `${found.classId}${multicast > 1 ? ' multicast 2' : ''}: ${text}`, ratio };
        expect(pf.single, `${text} single on ${found.classId}`).toBeLessThanOrEqual(best.single * BOUND);
        expect(pf.pack, `${text} pack on ${found.classId}`).toBeLessThanOrEqual(best.pack * BOUND);
      }
      console.log(`\n${search.what}: ${measured} of ${RANDOM_SPELLS} compiled; worst ${worst.ratio.toFixed(2)}x, ${worst.text}\n`);
      // Most random lists compile, so the search is not quietly measuring nothing.
      expect(measured).toBeGreaterThan(RANDOM_SPELLS / 2);
    }, 60_000);
  }
});
