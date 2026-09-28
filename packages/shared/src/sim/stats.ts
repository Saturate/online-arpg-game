import { ARMOR, HEAT } from '../config/sim.js';
import { CLASSES } from '../data/classes.js';
import { GEAR_SLOTS } from '../data/gear.js';
import { gearStats, type GearItem } from '../items/items.js';
import type { PlayerComp } from './ecs.js';

/** A player's effective numbers: class base plus everything equipped. */
export interface PlayerStats {
  maxLife: number;
  armor: number;
  moveSpeed: number;
  heatMax: number;
  /** Multiplier on Force recovery per second. */
  heatCooling: number;
  spiritMax: number;
  damageMult: number;
  castSpeedMult: number;
  attackSpeedMult: number;
  lifeRegen: number;
  minionDamageMult: number;
  minionLifeMult: number;
}

export function baseStats(p: Pick<PlayerComp, 'classId'>): PlayerStats {
  const def = CLASSES[p.classId];
  return {
    maxLife: def.life,
    armor: ARMOR.values[def.armor],
    moveSpeed: def.moveSpeed,
    heatMax: HEAT.max,
    heatCooling: 1,
    spiritMax: def.baseSpirit,
    damageMult: 1,
    castSpeedMult: 1,
    attackSpeedMult: 1,
    lifeRegen: 0,
    minionDamageMult: 1,
    minionLifeMult: 1,
  };
}

export function equippedGear(p: PlayerComp): GearItem[] {
  const out: GearItem[] = [];
  for (const slot of GEAR_SLOTS) {
    const uid = p.gear[slot];
    const item = uid === null ? undefined : p.items.get(uid);
    if (item?.kind === 'gear') out.push(item);
  }
  return out;
}

export function computeStats(p: PlayerComp): PlayerStats {
  const s = baseStats(p);
  const g = gearStats(equippedGear(p));
  const pct = (v: number | undefined): number => 1 + (v ?? 0) / 100;
  return {
    maxLife: s.maxLife + (g.life ?? 0),
    armor: s.armor + (g.armor ?? 0),
    moveSpeed: s.moveSpeed * pct(g.moveSpeed),
    heatMax: s.heatMax + (g.heatMax ?? 0),
    heatCooling: pct(g.heatCooling),
    spiritMax: s.spiritMax + (g.spirit ?? 0),
    damageMult: pct(g.damage),
    castSpeedMult: pct(g.castSpeed),
    attackSpeedMult: pct(g.attackSpeed),
    lifeRegen: g.lifeRegen ?? 0,
    minionDamageMult: pct(g.minionDamage),
    minionLifeMult: pct(g.minionLife),
  };
}
