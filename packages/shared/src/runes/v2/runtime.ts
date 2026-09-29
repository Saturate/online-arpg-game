import { SPELL } from '../../config/sim.js';
import { NEUTRAL_TUNING, countEntities, type CompileResult, type SpellBranch, type SpellNode as RuntimeNode } from '../compiler.js';
import type { ElementId, EffectId as RuntimeEffectId, FormId, TriggerId } from '../../data/runes.js';
import type { SpellNode, SpellTree } from './parse.js';
import type { ReleaseKind, ShapeId } from './runes.js';

/**
 * Turns a v2 spell tree into what today's engine runs, so Spell Lab spells can be cast at training
 * dummies before the real rework. Only parts the engine already has are castable; everything else
 * is listed, not silently dropped. Dev tools only: nothing in the game uses this.
 */
export type RuntimeResult = { ok: true; compiled: Extract<CompileResult, { ok: true }>; notes: string[] } | { ok: false; unsupported: string[] };

const FORM_FOR_SHAPE: Partial<Record<ShapeId, FormId>> = { orb: 'bolt', bolt: 'bolt', nova: 'nova', zone: 'zone', dash: 'dash' };

/** Orb is a slow, big bolt until the engine has its own shape. */
const ORB_TUNING = { speed: 0.55, radius: 2, range: 1.3 };

const TRIGGER_FOR_RELEASE: Partial<Record<ReleaseKind, TriggerId>> = { onhit: 'onhit', onexpire: 'onexpire', after: 'timer', every: 'pulse', onland: 'onland' };

/** Each extra copy of an infusion adds this much damage: doubled runes stack for now. */
const STACKED_INFUSION_BONUS = 0.25;

/** A rough Force price until the rework has a real one: base cost per shape, more per payload level. */
const FORCE_PER_SHAPE = 10;
const FORCE_PER_RUNE = 3;

export function toRuntime(tree: SpellTree): RuntimeResult {
  const unsupported: string[] = [];
  const notes: string[] = [];
  const root = tree.roots[0];
  if (!root) return { ok: false, unsupported: ['An empty spell'] };
  if (tree.roots.length > 1) unsupported.push('Casting several shapes together (multicast)');
  let force = 0;

  const build = (node: SpellNode, inheritedScale: number): RuntimeNode | null => {
    const form = FORM_FOR_SHAPE[node.shape];
    if (!form) {
      unsupported.push(`The ${node.shape} shape`);
      return null;
    }
    for (const s of node.shapers) if (s.id !== 'split') unsupported.push(`The ${s.id} shaper`);
    if (node.payload.length > 1) unsupported.push('A payload of several shapes cast together');
    force += (FORCE_PER_SHAPE + FORCE_PER_RUNE * (node.infusions.length + node.effects.length + node.shapers.length)) * (1 + 0.5 * node.depth);

    const elements: ElementId[] = [];
    let stackBonus = 1;
    for (const el of node.effectiveInfusions) {
      if (elements.includes(el)) stackBonus += STACKED_INFUSION_BONUS;
      else elements.push(el);
    }
    const copies = node.copies;
    const splitScale = copies > 1 ? SPELL.splitEfficiency / copies : 1;
    const pct = (v: number): number => Math.max(0.1, 1 + v / 100);
    const base = node.shape === 'orb' ? ORB_TUNING : { speed: 1, radius: 1, range: 1 };
    const out: RuntimeNode = {
      form,
      elements,
      effects: node.effects.filter((e): e is RuntimeEffectId => e === 'impact' || e === 'ward' || e === 'restore'),
      modifiers: { swift: 0, large: 0, linger: 0, pierce: node.stats.pierce / SPELL.modifiers.pierceHits },
      castSplit: copies,
      branch: null,
      depth: node.depth,
      combos: [],
      damageScale: inheritedScale * splitScale * stackBonus,
      areaScale: 1,
      tuning: {
        ...NEUTRAL_TUNING,
        speed: base.speed * pct(node.stats.speed),
        radius: base.radius * pct(node.stats.size),
        range: base.range * pct(node.stats.duration),
        damage: pct(node.stats.damage),
      },
    };

    const release = node.release;
    const child = node.payload[0];
    if (release && child) {
      const trigger = TRIGGER_FOR_RELEASE[release.kind];
      if (!trigger) unsupported.push(`The ${release.kind} release`);
      else {
        if (release.kind === 'after' && release.seconds !== SPELL.timerSeconds) notes.push(`"after ${release.seconds}s" runs at the engine's ${SPELL.timerSeconds}s`);
        if (release.kind === 'every' && release.seconds !== SPELL.pulseSeconds) notes.push(`"every ${release.seconds}s" runs at the engine's ${SPELL.pulseSeconds}s`);
        const built = build(child, 1);
        if (built) {
          const branch: SpellBranch = { trigger, action: 'form', node: built };
          out.branch = branch;
        }
      }
    }
    return out;
  };

  const program = build(root, 1);
  if (!program || unsupported.length > 0) return { ok: false, unsupported: [...new Set(unsupported)] };
  return {
    ok: true,
    notes: [...new Set(notes)],
    compiled: { ok: true, program, heat: Math.round(force), spirit: 0, worstCaseEntities: countEntities(program), combos: [], persistent: false },
  };
}
