import { ENEMY_TYPE_IDS, type EnemyTypeId } from '../data/enemies.js';
import { GEAR_SLOTS, categoryForSlot, type GearCategory } from '../data/gear.js';
import { ITEM_TIERS, createGear, createSigil, createVessel, type ItemTier } from '../items/items.js';
import type { EntityId } from './ecs.js';
import { spawnEnemy } from './enemies.js';
import { addItem } from './inventory.js';
import type { Simulation } from './simulation.js';

/** Encounter sandbox commands. Only honoured for roles with the devTools permission (builder and up). */
export type DevCommand =
  | { c: 'spawn'; enemy: EnemyTypeId; count: number; rare: boolean; level: number; x: number; y: number }
  | { c: 'god'; on: boolean }
  | { c: 'killAll' }
  | { c: 'clearLoot' }
  | { c: 'heal' }
  | { c: 'give'; item: 'sigil' | 'vessel' | 'gear'; tier: ItemTier; level: number; category: GearCategory | null }
  | { c: 'teleport'; x: number; y: number }
  | { c: 'timeScale'; scale: number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

const CATEGORIES: readonly GearCategory[] = [...new Set(GEAR_SLOTS.map(categoryForSlot))];

export function parseDevCommand(v: unknown): DevCommand | null {
  if (!isRecord(v)) return null;
  switch (v.c) {
    case 'spawn': {
      const enemy = ENEMY_TYPE_IDS.find((e) => e === v.enemy);
      const count = num(v.count, 1, 50);
      const level = num(v.level, 1, 30);
      const x = num(v.x, 0, 100_000);
      const y = num(v.y, 0, 100_000);
      if (!enemy || count === null || level === null || x === null || y === null) return null;
      return { c: 'spawn', enemy, count: Math.floor(count), rare: v.rare === true, level: Math.floor(level), x, y };
    }
    case 'god':
      return { c: 'god', on: v.on === true };
    case 'killAll':
      return { c: 'killAll' };
    case 'clearLoot':
      return { c: 'clearLoot' };
    case 'heal':
      return { c: 'heal' };
    case 'give': {
      const tier = ITEM_TIERS.find((t) => t === v.tier);
      const level = num(v.level, 1, 30);
      const item = v.item === 'sigil' || v.item === 'vessel' || v.item === 'gear' ? v.item : null;
      const category = CATEGORIES.find((c) => c === v.category) ?? null;
      if (!tier || level === null || !item) return null;
      return { c: 'give', item, tier, level: Math.floor(level), category };
    }
    case 'teleport': {
      const x = num(v.x, 0, 100_000);
      const y = num(v.y, 0, 100_000);
      return x === null || y === null ? null : { c: 'teleport', x, y };
    }
    case 'timeScale': {
      const scale = num(v.scale, 0.1, 8);
      return scale === null ? null : { c: 'timeScale', scale };
    }
    default:
      return null;
  }
}

/** Applies a dev command inside the simulation. Time scale is handled by the room, not here. */
export function applyDev(sim: Simulation, pid: EntityId, cmd: DevCommand): string | null {
  const w = sim.world;
  const p = w.player.get(pid);
  switch (cmd.c) {
    case 'spawn':
      for (let i = 0; i < cmd.count; i++) {
        const a = (Math.PI * 2 * i) / cmd.count;
        const r = cmd.count > 1 ? 40 + cmd.count * 4 : 0;
        spawnEnemy(sim, cmd.enemy, cmd.x + Math.cos(a) * r, cmd.y + Math.sin(a) * r, { rare: cmd.rare, level: cmd.level, aggro: true });
      }
      return `Spawned ${cmd.count} ${cmd.rare ? 'rare ' : ''}${cmd.enemy}`;
    case 'god':
      if (p) p.god = cmd.on;
      return cmd.on ? 'God mode on' : 'God mode off';
    case 'killAll':
      for (const id of w.enemy.keys()) w.destroy(id);
      return 'Cleared all monsters';
    case 'clearLoot':
      for (const id of w.loot.keys()) w.destroy(id);
      return 'Cleared loot';
    case 'heal': {
      const h = w.health.get(pid);
      if (h) h.life = h.maxLife;
      if (p) p.heat = 0;
      return 'Healed';
    }
    case 'give': {
      if (!p) return null;
      const rng = sim.rand.loot;
      const item =
        cmd.item === 'gear'
          ? createGear(sim.newItemUid(), rng, cmd.tier, cmd.level, cmd.category ? { category: cmd.category } : {})
          : cmd.item === 'vessel'
            ? createVessel(sim.newItemUid(), rng, cmd.tier, undefined, cmd.level)
            : createSigil(sim.newItemUid(), rng, cmd.tier, { ilvl: cmd.level, skill: 'random' });
      return addItem(p, item) ? `Gave ${item.name}` : 'Inventory is full';
    }
    case 'teleport': {
      const pos = sim.map.findOpen(cmd.x, cmd.y, 16);
      w.position.set(pid, pos);
      if (p) p.dash = null;
      return null;
    }
    case 'timeScale':
      return null;
  }
}
