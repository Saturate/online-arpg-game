import { ARMOR, HEAT, PROGRESSION } from '../config/sim.js';
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

/** Class base plus automatic growth per character level. */
export function baseStats(p: Pick<PlayerComp, 'classId' | 'level'>): PlayerStats {
  const def = CLASSES[p.classId];
  const gained = p.level - 1;
  return {
    maxLife: Math.round(def.life * (1 + PROGRESSION.lifePerLevel * gained)),
    armor: ARMOR.values[def.armor],
    moveSpeed: def.moveSpeed,
    heatMax: HEAT.max + PROGRESSION.forcePerLevel * gained,
    heatCooling: 1,
    spiritMax: def.baseSpirit + PROGRESSION.spiritPerLevel * gained,
    damageMult: 1 + PROGRESSION.damagePerLevel * gained,
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
    // Level damage and gear damage add up, like "increased" modifiers in PoE.
    damageMult: s.damageMult + (g.damage ?? 0) / 100,
    castSpeedMult: pct(g.castSpeed),
    attackSpeedMult: pct(g.attackSpeed),
    lifeRegen: g.lifeRegen ?? 0,
    minionDamageMult: pct(g.minionDamage),
    minionLifeMult: pct(g.minionLife),
  };
}
