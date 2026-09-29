import {
  ENEMIES,
  ENEMY_TYPE_IDS,
  enemySource,
  MINION_DEFS,
  MINION_TYPE_IDS,
  minionSource,
  MonsterTuning,
  type EnemyTypeId,
  type MinionTypeId,
  type ModelOverride,
  type TuningOverrides,
} from '@rune/shared';
import { assetById, type AnimRole, type AssetDef } from '../../render/assets.js';
import { ENEMY_ASSETS, MINION_ASSETS } from '../../render/characters.js';

/**
 * Turns the saved overrides into code: new entries for data/enemies.ts and data/minions.ts, and the
 * asset lines a model change needs, so the owner can paste them in and then reset the overrides.
 */

function hex(n: number): string {
  return `0x${n.toString(16).padStart(6, '0')}`;
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function clipsSource(clips: Partial<Record<AnimRole, string>>): string {
  const parts = Object.entries(clips).map(([role, name]) => `${role}: ${quote(name)}`);
  return `{ ${parts.join(', ')} }`;
}

/** One ASSETS entry, written out in full (the registry's spreads of shared clip maps included). */
export function assetSource(def: AssetDef): string {
  const parts = [`id: ${quote(def.id)}`, `label: ${quote(def.label)}`, `category: ${quote(def.category)}`, `url: ${quote(def.url)}`, `height: ${def.height}`];
  if (def.clips) parts.push(`clips: ${clipsSource(def.clips)}`);
  if (def.hide) parts.push(`hide: [${def.hide.map(quote).join(', ')}]`);
  if (def.weapon) parts.push(`weapon: { url: ${quote(def.weapon.url)}, bone: ${quote(def.weapon.bone)} }`);
  if (def.tint !== undefined) parts.push(`tint: ${hex(def.tint)}`);
  if (def.glow !== undefined) parts.push(`glow: ${hex(def.glow)}`);
  return `  { ${parts.join(', ')} },`;
}

interface ModelChange {
  typeId: string;
  mapLine: string | null;
  asset: string;
  newId: string | null;
}

/**
 * A type's model override as code. Only a new height on the type's own model rewrites that entry;
 * any other change gets a dedicated entry named after the type, since a registry model can be
 * shared by several types.
 */
function modelChange(typeId: string, name: string, prefix: 'mon' | 'minion', defaultId: string | undefined, o: ModelOverride): ModelChange | null {
  const chosen = assetById(o.model ?? defaultId ?? '');
  if (!chosen) return null;
  const height = o.height ?? chosen.height;
  if (chosen.id === defaultId) return { typeId, mapLine: null, asset: assetSource({ ...chosen, height }), newId: null };
  const id = `${prefix}_${typeId}`;
  return { typeId, mapLine: `  ${typeId}: ${quote(id)},`, asset: assetSource({ ...chosen, id, label: name, height }), newId: id };
}

function hasStats(o: object): boolean {
  return Object.keys(o).some((k) => k !== 'model' && k !== 'height');
}

export function exportOverrides(saved: TuningOverrides, date = new Date()): string {
  const tuning = new MonsterTuning(saved);
  const enemyIds = ENEMY_TYPE_IDS.filter((id) => saved.monsters[id] !== undefined);
  const minionIds = MINION_TYPE_IDS.filter((id) => saved.minions[id] !== undefined);
  if (enemyIds.length === 0 && minionIds.length === 0) return '// No overrides to export.\n';
  const out: string[] = [`// Overrides exported from the admin page on ${date.toISOString().slice(0, 10)}.`];

  const enemyStats = enemyIds.filter((id) => hasStats(saved.monsters[id] ?? {}));
  if (enemyStats.length > 0) out.push('', '// packages/shared/src/data/enemies.ts: replace these entries in ENEMIES.', ...enemyStats.map((id) => enemySource(tuning.enemy(id))));
  const minionStats = minionIds.filter((id) => hasStats(saved.minions[id] ?? {}));
  if (minionStats.length > 0) out.push('', '// packages/shared/src/data/minions.ts: replace these entries in MINION_DEFS.', ...minionStats.map((id) => minionSource(tuning.minion(id))));

  const enemyModels = enemyIds.flatMap((id: EnemyTypeId) => {
    const o = saved.monsters[id];
    const m = o && (o.model !== undefined || o.height !== undefined) ? modelChange(id, ENEMIES[id].name, 'mon', ENEMY_ASSETS[id], o) : null;
    return m ? [m] : [];
  });
  const minionModels = minionIds.flatMap((id: MinionTypeId) => {
    const o = saved.minions[id];
    const m = o && (o.model !== undefined || o.height !== undefined) ? modelChange(id, MINION_DEFS[id].name, 'minion', MINION_ASSETS[id], o) : null;
    return m ? [m] : [];
  });
  const models = [...enemyModels, ...minionModels];
  if (models.length > 0) {
    out.push('', '// apps/client/src/render/assets.ts: add these to ASSETS, replacing an entry with the same id.', ...models.map((m) => m.asset));
    if (enemyModels.some((m) => m.mapLine)) out.push('', '// apps/client/src/render/characters.ts: set these in ENEMY_ASSETS.', ...enemyModels.flatMap((m) => (m.mapLine ? [m.mapLine] : [])));
    if (minionModels.some((m) => m.mapLine)) out.push('', '// apps/client/src/render/characters.ts: set these in MINION_ASSETS.', ...minionModels.flatMap((m) => (m.mapLine ? [m.mapLine] : [])));
    const newIds = models.flatMap((m) => (m.newId ? [m.newId] : []));
    if (newIds.length > 0) out.push('', '// packages/shared/src/data/tuning.ts: add the new ids to MONSTER_MODEL_IDS.', ...newIds.map((id) => `  ${quote(id)},`));
  }
  out.push('', `// Then reset these on the admin page: ${[...enemyIds, ...minionIds.map((id) => `${id} (minion)`)].join(', ')}.`);
  return `${out.join('\n')}\n`;
}

/** The registry entry for a file checked in the Model check, and where the file should go. */
export function newAssetEntry(fileName: string, height: number, clips: Partial<Record<AnimRole, string>>, typeId: string | null, kind: 'monsters' | 'minions'): string {
  const slug =
    fileName
      .replace(/\.glb$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'model';
  const id = `mon_${slug}`;
  const def: AssetDef = { id, label: fileName.replace(/\.glb$/i, ''), category: 'monster', url: `/assets/monsters/${slug}.glb`, height, clips };
  const lines = [`// Save the file as apps/client/public/assets/monsters/${slug}.glb`, '', '// apps/client/src/render/assets.ts, in ASSETS:', assetSource(def)];
  if (typeId) lines.push('', `// apps/client/src/render/characters.ts, in ${kind === 'monsters' ? 'ENEMY_ASSETS' : 'MINION_ASSETS'}:`, `  ${typeId}: ${quote(id)},`);
  lines.push('', '// packages/shared/src/data/tuning.ts, in MONSTER_MODEL_IDS:', `  ${quote(id)},`);
  return `${lines.join('\n')}\n`;
}
