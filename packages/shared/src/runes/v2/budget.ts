import { SIM } from '../../config/sim.js';
import { affixMultiplier, formLifetime, type FormId } from '../../sim/program.js';
import type { SpellNode, SpellTree } from './parse.js';
import { SHAPES, type ShapeId } from './runes.js';

/**
 * Entity budget measured as the MOST ENTITIES ALIVE AT ONCE for one cast, not the lifetime total.
 * A pulsing orb that fires 10 times but whose shards live for 5 pulses only ever has 5 volleys up.
 * The model is deliberately simple and errs high where timing is fuzzy (on-hit releases count as
 * simultaneous). Lifetimes are the engine's (`formLifetime`), speed and duration affixes included;
 * shapes the engine cannot run yet fall back to SHAPES.
 */

// Float division like 1 / 0.2 must not round up to an extra overlapping volley.
const EPS = 1e-9;

const ENGINE_FORMS: Partial<Record<ShapeId, FormId>> = { orb: 'orb', bolt: 'bolt', nova: 'nova', zone: 'zone', dash: 'dash', aura: 'aura', bond: 'bond' };

/** The engine form a shape runs as, or undefined for the phase 4 shapes. */
export function engineForm(shape: ShapeId): FormId | undefined {
  return ENGINE_FORMS[shape];
}

export function lifetime(node: SpellNode): number {
  const form = engineForm(node.shape);
  const range = affixMultiplier(node.stats.duration);
  if (!form) return SHAPES[node.shape].lifetime * range;
  return formLifetime(form, affixMultiplier(node.stats.speed), range);
}

function shaperValue(node: SpellNode, id: 'chain'): number {
  return node.shapers.find((s) => s.id === id)?.value ?? 0;
}

/** Seconds from this shape spawning until the last thing it releases is gone. */
function span(node: SpellNode): number {
  const own = lifetime(node);
  if (!node.release || node.payload.length === 0) return own;
  const child = groupSpan(node.payload);
  if (node.release.kind === 'after') return Math.max(own, node.release.seconds + child);
  return own + child;
}

function groupSpan(group: readonly SpellNode[]): number {
  return group.reduce((m, n) => Math.max(m, span(n)), 0);
}

/** How many times one instance releases its payload over its life. */
function fires(node: SpellNode): number {
  const r = node.release;
  if (!r) return 0;
  if (r.kind === 'every') {
    const l = lifetime(node);
    return Number.isFinite(l) ? Math.max(1, Math.floor(l / r.seconds + EPS)) : 1;
  }
  if (r.kind === 'onhit') return 1 + node.stats.pierce + node.stats.bounce + shaperValue(node, 'chain');
  return 1;
}

const toTicks = (seconds: number): number => Math.ceil(seconds / SIM.dt - EPS);

/** The engine updates projectiles, then novas, then zones; a dash runs with the input before all. */
const SYSTEM_ORDER: Record<FormId, number> = { dash: -1, orb: 0, bolt: 0, nova: 1, zone: 2, aura: 3, bond: 3 };

/**
 * Ticks a payload shape is alive once spawned. A shape spawned by a system that runs before its own
 * (or earlier in the same one) is updated on its spawn tick too, so it ends one tick sooner.
 */
function aliveTicks(parent: SpellNode, child: SpellNode): number {
  const pf = engineForm(parent.shape);
  const cf = engineForm(child.shape);
  const sameTick = pf !== undefined && cf !== undefined && SYSTEM_ORDER[cf] >= SYSTEM_ORDER[pf];
  return Math.max(1, toTicks(span(child)) - (sameTick ? 1 : 0));
}

/**
 * Peak of a shape releasing every X s, walked tick by tick as the engine's pulse timer runs: volley n
 * spawns on the first tick at or past n x X and is gone once its span has passed; the shape itself
 * is gone on the tick it ends, even when it releases on that tick.
 */
function everyPeak(node: SpellNode, seconds: number, child: number): number {
  const n = fires(node);
  const own = lifetime(node);
  if (!Number.isFinite(own)) return 1 + child;
  const ownTicks = toTicks(own);
  const childTicks = node.payload.reduce((m, c) => Math.max(m, aliveTicks(node, c)), 1);
  const at = Array.from({ length: n }, (_, i) => toTicks((i + 1) * seconds));
  // Spawn ticks only grow, so the volleys alive at volley m are a window ending at m. Linear rather
  // than counting every pair: live tuning can stretch a pulsing shape to thousands of volleys, and
  // the compiler runs on the game thread.
  let peak = 1;
  let first = 0;
  for (let m = 0; m < n; m++) {
    const t = at[m] ?? 0;
    while (first < m && (at[first] ?? 0) + childTicks <= t) first++;
    // Volleys spawning on the same tick as m (a pulse shorter than a tick) are alive too.
    let last = m;
    while (last + 1 < n && (at[last + 1] ?? 0) <= t) last++;
    peak = Math.max(peak, (t < ownTicks ? 1 : 0) + (last - first + 1) * child);
  }
  return peak;
}

/** Peak alive from one copy of this shape, counting itself and everything it releases. */
function instancePeak(node: SpellNode): number {
  const r = node.release;
  if (!r || node.payload.length === 0) return 1;
  const child = groupPeak(node.payload);
  switch (r.kind) {
    case 'onexpire':
    case 'onland':
      return Math.max(1, child);
    case 'onhit': {
      const hits = fires(node);
      // A shape that stops on its first hit is gone when the payload appears.
      return hits > 1 ? 1 + hits * child : Math.max(1, child);
    }
    case 'onrelease':
      return 1 + child;
    case 'after':
      return r.seconds < lifetime(node) ? 1 + child : Math.max(1, child);
    case 'every':
      return everyPeak(node, r.seconds, child);
  }
}

function groupPeak(group: readonly SpellNode[]): number {
  return group.reduce((sum, n) => sum + n.copies * instancePeak(n) + (n.linked ? n.copies - 1 : 0), 0);
}

function instanceLifetime(node: SpellNode): number {
  if (!node.release || node.payload.length === 0) return 1;
  return 1 + fires(node) * groupLifetime(node.payload);
}

function groupLifetime(group: readonly SpellNode[]): number {
  return group.reduce((sum, n) => sum + n.copies * instanceLifetime(n) + (n.linked ? n.copies - 1 : 0), 0);
}

export function measureBudget(tree: SpellTree): { peak: number; lifetime: number } {
  return { peak: groupPeak(tree.roots), lifetime: groupLifetime(tree.roots) };
}
