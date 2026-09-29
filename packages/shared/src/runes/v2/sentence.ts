import type { NodeRelease, SpellNode, SpellTree } from './parse.js';
import { SHAPES } from './runes.js';

const EFFECT_CLAUSE = {
  impact: { one: 'knocks enemies back', many: 'knock enemies back' },
  ward: { one: 'shields allies', many: 'shield allies' },
  restore: { one: 'heals allies', many: 'heal allies' },
} as const;

function fmtSeconds(s: number): string {
  return String(Number(s.toFixed(2)));
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function shaperValue(node: SpellNode, id: SpellNode['shapers'][number]['id']): number | null {
  return node.shapers.find((s) => s.id === id)?.value ?? null;
}

function descriptors(node: SpellNode, long: boolean): string[] {
  const out: string[] = [];
  const { speed, size, duration } = node.stats;
  if (speed < 0) out.push('slow');
  if (speed > 0) out.push('fast');
  if (size < 0) out.push('small');
  if (size > 0) out.push('large');
  if (duration > 0) out.push(long ? 'long-lasting' : 'long');
  if (duration < 0) out.push(long ? 'short-lived' : 'short');
  return out;
}

/** "a slow cold orb", "6 homing orbs". Inherited infusions stay implied, as in the plan's example. */
function nounPhrase(node: SpellNode): string {
  const def = SHAPES[node.shape];
  const adjectives = [...descriptors(node, true)];
  if (shaperValue(node, 'charge') !== null) adjectives.unshift('charged');
  adjectives.push(...node.infusions);
  if (node.stats.homing > 0 || shaperValue(node, 'homing') !== null) adjectives.push('homing');
  const noun = node.copies > 1 ? def.plural : def.noun;
  const words = [...adjectives, noun].join(' ');
  const head = node.copies > 1 ? `${node.copies} ${words}` : `${/^[aeiou]/.test(words) ? 'an' : 'a'} ${words}`;

  const clauses: string[] = [];
  const plural = node.copies > 1;
  if (node.linked) clauses.push('linked by beams');
  if (shaperValue(node, 'orbit') !== null) clauses.push(node.depth === 0 ? 'circling you' : 'circling where they were released');
  const pierce = node.stats.pierce;
  if (pierce > 0) clauses.push(`piercing ${pierce} ${pierce === 1 ? 'enemy' : 'enemies'}`);
  const bounce = node.stats.bounce + (shaperValue(node, 'bounce') ?? 0);
  if (bounce > 0) clauses.push(`bouncing ${bounce} ${bounce === 1 ? 'time' : 'times'}`);
  const chain = shaperValue(node, 'chain');
  if (chain !== null) clauses.push(`chaining to ${chain} more ${chain === 1 ? 'target' : 'targets'}`);
  const stack = shaperValue(node, 'stack');
  if (stack !== null) clauses.push(`stacking up to ${stack} before merging`);
  for (const e of node.effects) clauses.push(`that ${plural ? EFFECT_CLAUSE[e].many : EFFECT_CLAUSE[e].one}`);
  if (node.stats.damage !== 0) clauses.push(`with ${node.stats.damage > 0 ? '+' : ''}${node.stats.damage}% damage`);
  return clauses.length ? `${head}, ${joinAnd(clauses)}` : head;
}

function verbPhrase(node: SpellNode): string {
  if (node.shape === 'bond') return `Binds an ally with ${nounPhrase(node)}`;
  return `${SHAPES[node.shape].verb} ${nounPhrase(node)}`;
}

function whenPhrase(node: SpellNode, release: NodeRelease): string {
  const they = node.copies > 1;
  switch (release.kind) {
    case 'onhit':
      return node.shape === 'trap' ? 'When triggered' : 'On hit';
    case 'onexpire':
      return they ? 'When they expire' : 'When it expires';
    case 'onland':
      return 'On landing';
    case 'onrelease':
      return 'When you let go';
    case 'after':
      return `After ${fmtSeconds(release.seconds)} s`;
    case 'every':
      return `Every ${fmtSeconds(release.seconds)} s`;
  }
}

function groupNouns(group: readonly SpellNode[]): string {
  const list = joinAnd(group.map(nounPhrase));
  return group.length > 1 ? `${list} at once` : list;
}

function describeRelease(node: SpellNode, inGroup: boolean, out: string[]): void {
  if (!node.release || node.payload.length === 0) return;
  const subject = node.copies > 1 ? 'each' : 'it';
  const prefix = inGroup ? `The ${SHAPES[node.shape].noun}: ` : '';
  const when = whenPhrase(node, node.release);
  out.push(`${prefix}${prefix ? when.toLowerCase() : when} ${subject} releases ${groupNouns(node.payload)}.`);
  for (const child of node.payload) describeRelease(child, node.payload.length > 1, out);
}

/** Plain-English reading of a spell tree, one sentence per cast and per release. */
export function describeTree(tree: SpellTree): string {
  const roots = tree.roots;
  if (roots.length === 0) return '';
  const out: string[] = [];
  const phrases = roots.map((n, i) => (i === 0 ? verbPhrase(n) : lower(verbPhrase(n))));
  const charged = roots.find((n) => shaperValue(n, 'charge') !== null);
  let first = joinAnd(phrases) + (roots.length > 1 ? ' at once' : '');
  if (charged) {
    const stages = shaperValue(charged, 'charge') ?? 0;
    first = `Hold to charge (${stages} stages), then release: ${lower(first)}`;
  }
  out.push(`${first}.`);
  for (const root of roots) describeRelease(root, roots.length > 1, out);
  return out.join(' ');
}

function releaseTag(r: NodeRelease): string {
  switch (r.kind) {
    case 'onhit':
      return 'on hit';
    case 'onexpire':
      return 'on expire';
    case 'onland':
      return 'on land';
    case 'onrelease':
      return 'on release';
    case 'after':
      return `after ${fmtSeconds(r.seconds)}s`;
    case 'every':
      return `every ${fmtSeconds(r.seconds)}s`;
  }
}

function nodeTags(node: SpellNode): string[] {
  const tags = descriptors(node, false);
  tags.push(...node.infusions, ...node.effects);
  for (const s of node.shapers) {
    switch (s.id) {
      case 'split':
        break;
      case 'link':
      case 'orbit':
        tags.push(s.id);
        break;
      case 'homing':
        tags.push(s.value > 1 ? `homing${s.value}` : 'homing');
        break;
      case 'charge':
        tags.push(`charge${s.value}`);
        break;
      default:
        tags.push(`${s.id}${s.value}`);
    }
  }
  const st = node.stats;
  if (st.homing > 0 && !node.shapers.some((s) => s.id === 'homing')) tags.push(st.homing > 1 ? `homing${st.homing}` : 'homing');
  if (st.pierce > 0) tags.push(`pierce${st.pierce}`);
  if (st.bounce > 0) tags.push(`bounce${st.bounce}`);
  if (st.damage !== 0) tags.push(`${st.damage > 0 ? '+' : ''}${st.damage}% damage`);
  return tags;
}

function bracketNode(node: SpellNode): string {
  const tags = nodeTags(node);
  let s = `${node.copies > 1 ? `Split${node.copies} ` : ''}${SHAPES[node.shape].name}${tags.length ? `[${tags.join(', ')}]` : ''}`;
  if (node.release) {
    const inner = node.payload.length ? bracketGroup(node.payload) : '?';
    s += ` { ${releaseTag(node.release)}: ${inner} }`;
  }
  return s;
}

function bracketGroup(group: readonly SpellNode[]): string {
  return group.map(bracketNode).join(' + ');
}

/** Compact structural view: `Orb[cold] { every 0.2s: Split4 Bolt[small] }`. Shapes cast together join with `+`. */
export function bracketTree(tree: SpellTree): string {
  return bracketGroup(tree.roots);
}
