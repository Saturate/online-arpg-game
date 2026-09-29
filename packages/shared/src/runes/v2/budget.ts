import type { SpellNode, SpellTree } from './parse.js';
import { SHAPES } from './runes.js';

/**
 * Entity budget measured as the MOST ENTITIES ALIVE AT ONCE for one cast, not the lifetime total.
 * A pulsing orb that fires 10 times but whose shards live for 5 pulses only ever has 5 volleys up.
 * The model is deliberately simple and errs high where timing is fuzzy (on-hit releases count as
 * simultaneous). Lifetimes come from SHAPES and the duration affix; speed does not change them.
 */

// Float division like 1 / 0.2 must not round up to an extra overlapping volley.
const EPS = 1e-9;

function lifetime(node: SpellNode): number {
  return SHAPES[node.shape].lifetime * Math.max(0.1, 1 + node.stats.duration / 100);
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
    case 'every': {
      const overlap = Math.min(fires(node), Math.max(1, Math.ceil(groupSpan(node.payload) / r.seconds - EPS)));
      return 1 + overlap * child;
    }
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
