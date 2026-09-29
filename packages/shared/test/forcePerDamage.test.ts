import { describe, expect, it } from 'vitest';
import { compileRunes, DEFAULT_SIGIL_CONTEXT, HEAT, STARTER_SIGILS, tokenizeSpell } from '../src/index.js';
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
const SPELLS: readonly { text: string; multicast?: number }[] = [
  // Repeating payloads: the review's three, then faster and nested variants.
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
  // Once-off payloads.
  { text: 'nova[after 0.1s] lightning nova[after 0.1s] nova' },
  { text: 'zone[onexpire] lightning nova' },
  { text: 'dash[onland] lightning nova[+50% size]' },
];

const SELF_CENTRED = new Set(['nova', 'zone', 'dash']);

function measureText(text: string, multicast = 1): SkillDpsResult {
  const runes = tokenizeSpell(text).runes;
  const compiled = compileRunes(runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage', multicast });
  if (!compiled.ok) throw new Error(`${text}: ${compiled.errors.map((e) => e.message).join('; ')}`);
  const shape = runes[0]?.id ?? 'bolt';
  return measureSkill({
    classId: 'mage',
    equip: () => ({ uid: -1, compiled, misfireMultiplier: 1, castDelay: HEAT.castCooldownSeconds }),
    ...(SELF_CENTRED.has(shape) ? { distance: 40 } : {}),
  });
}

/** Damage per point of Force spent over the run. */
function perForce(r: SkillDpsResult): { single: number; pack: number } {
  const spent = (r.forcePerCast ?? 0) * (r.casts ?? 0);
  if (spent <= 0) return { single: 0, pack: 0 };
  return { single: (r.single ?? 0) / spent, pack: (r.pack ?? 0) / spent };
}

describe('damage per Force', () => {
  const starters = STARTER_SIGILS.map((def) => ({ id: def.id, r: measureStarter(def) })).filter((s) => s.r.kind === 'damage');
  const best = {
    single: Math.max(...starters.map((s) => perForce(s.r).single)),
    pack: Math.max(...starters.map((s) => perForce(s.r).pack)),
  };
  const rows = SPELLS.map((s) => ({ text: s.text, r: measureText(s.text, s.multicast) }));

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
});
