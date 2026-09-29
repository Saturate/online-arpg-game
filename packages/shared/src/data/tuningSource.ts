import type { Ability, EnemyDef, MonsterDef } from './enemies.js';
import type { MinionDef } from './minions.js';

/**
 * Prints definitions the way data/enemies.ts and data/minions.ts write them, so the admin page's
 * export can be pasted over the old entry and the overrides then reset.
 */

function hex(n: number): string {
  return `0x${n.toString(16).padStart(6, '0')}`;
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function value(v: unknown, key = ''): string {
  if (typeof v === 'number') return key === 'color' ? hex(v) : String(v);
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => value(x)).join(', ')}]`;
  if (typeof v === 'object' && v !== null) {
    const parts = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${k}: ${value(x, k)}`);
    return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`;
  }
  return 'undefined';
}

/** The `base` argument of the monster() helper, leaving out what it defaults (cooldown 1, range 0). */
function monsterBase(def: MonsterDef): string {
  const parts = [`life: ${def.life}`, `speed: ${def.moveSpeed}`, `radius: ${def.radius}`, `contact: ${def.contactDamage}`];
  if (def.contactCooldown !== 1) parts.push(`contactCooldown: ${def.contactCooldown}`);
  parts.push(`color: ${hex(def.color)}`);
  if (def.preferredRange !== 0) parts.push(`range: ${def.preferredRange}`);
  if (def.xp !== undefined) parts.push(`xp: ${def.xp}`);
  return `{ ${parts.join(', ')} }`;
}

function abilityList(abilities: readonly Ability[], indent: string): string {
  if (abilities.length === 0) return '[]';
  if (abilities.length === 1) return `[${value(abilities[0])}]`;
  return `[\n${abilities.map((a) => `${indent}  ${value(a)},`).join('\n')}\n${indent}]`;
}

function monsterSource(def: MonsterDef): string {
  const head = [quote(def.id), quote(def.name), quote(def.family), quote(def.movement), monsterBase(def)];
  const hasTraits = Object.keys(def.traits).length > 0;
  if (def.abilities.length === 0 && !hasTraits) return `  ${def.id}: monster(${head.join(', ')}),`;
  const args = [...head, abilityList(def.abilities, '    ')];
  if (hasTraits) args.push(value(def.traits));
  return `  ${def.id}: monster(\n${args.map((a) => `    ${a},`).join('\n')}\n  ),`;
}

/** One entry of the ENEMIES record, with its trailing comma. */
export function enemySource(def: EnemyDef): string {
  if (def.behaviour === 'monster') return monsterSource(def);
  const lines = Object.entries(def)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `    ${k}: ${value(v, k)},`);
  return `  ${def.id}: {\n${lines.join('\n')}\n  },`;
}

/** One entry of the MINION_DEFS record, with its trailing comma. */
export function minionSource(def: MinionDef): string {
  const lines = Object.entries(def).map(([k, v]) => `    ${k}: ${value(v, k)},`);
  return `  ${def.id}: {\n${lines.join('\n')}\n  },`;
}
