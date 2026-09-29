import type { ClassId } from './classes.js';

/**
 * Equipment. Each slot has a few base types with an implicit stat line; affixes come from the shared
 * affix engine (targets 'gear'). Stats are additive unless the name says "increased" (a percentage).
 */

export const GEAR_SLOTS = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'belt', 'amulet', 'ring1', 'ring2'] as const;
export type GearSlot = (typeof GEAR_SLOTS)[number];

/** Item categories; both ring slots take rings. */
export type GearCategory = 'weapon' | 'helmet' | 'body' | 'gloves' | 'boots' | 'belt' | 'amulet' | 'ring';

export function categoryForSlot(slot: GearSlot): GearCategory {
  return slot === 'ring1' || slot === 'ring2' ? 'ring' : slot;
}

export const STAT_IDS = [
  'life',
  'armor',
  'moveSpeed',
  'heatMax',
  'heatCooling',
  'spirit',
  'damage',
  'castSpeed',
  'attackSpeed',
  'lifeRegen',
  'minionDamage',
  'minionLife',
] as const;
export type StatId = (typeof STAT_IDS)[number];

export type StatBlock = Partial<Record<StatId, number>>;

/**
 * A number as players should read it: at most `decimals` places, no binary float noise
 * (0.1 + 0.2 shows as 0.3) and no "-0".
 */
export function formatNumber(v: number, decimals = 2): string {
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return String(r === 0 ? 0 : r);
}

export const STAT_LABELS: Record<StatId, (v: number) => string> = {
  life: (v) => `+${formatNumber(v)} to maximum life`,
  armor: (v) => `+${formatNumber(v)} to armour`,
  moveSpeed: (v) => `${formatNumber(v)}% increased movement speed`,
  heatMax: (v) => `+${formatNumber(v)} to maximum Force`,
  heatCooling: (v) => `${formatNumber(v)}% faster Force recovery`,
  spirit: (v) => `+${formatNumber(v)} to spirit`,
  damage: (v) => `${formatNumber(v)}% increased damage`,
  castSpeed: (v) => `${formatNumber(v)}% increased cast speed`,
  attackSpeed: (v) => `${formatNumber(v)}% increased attack speed`,
  lifeRegen: (v) => `Regenerate ${formatNumber(v)} life per second`,
  minionDamage: (v) => `Minions deal ${formatNumber(v)}% increased damage`,
  minionLife: (v) => `Minions have ${formatNumber(v)}% increased life`,
};

export interface GearBase {
  id: string;
  name: string;
  category: GearCategory;
  /** Monster level this base starts dropping at. */
  level: number;
  implicit: StatBlock;
  /** Weapons only: which classes can wield it. Other gear fits everyone. */
  classes?: readonly ClassId[];
}

export const GEAR_BASES: readonly GearBase[] = [
  // Weapons: one per class family, better bases at higher levels.
  { id: 'rusty_axe', name: 'Rusted Axe', category: 'weapon', level: 1, implicit: { damage: 10 }, classes: ['warrior'] },
  { id: 'war_axe', name: 'War Axe', category: 'weapon', level: 4, implicit: { damage: 25, attackSpeed: 5 }, classes: ['warrior'] },
  { id: 'short_bow', name: 'Short Bow', category: 'weapon', level: 1, implicit: { damage: 10 }, classes: ['ranger'] },
  { id: 'recurve_bow', name: 'Recurve Bow', category: 'weapon', level: 4, implicit: { damage: 20, attackSpeed: 10 }, classes: ['ranger'] },
  { id: 'gnarled_staff', name: 'Gnarled Staff', category: 'weapon', level: 1, implicit: { damage: 10 }, classes: ['mage', 'priest'] },
  { id: 'runed_staff', name: 'Runed Staff', category: 'weapon', level: 4, implicit: { damage: 20, castSpeed: 10 }, classes: ['mage', 'priest'] },
  { id: 'bone_wand', name: 'Bone Wand', category: 'weapon', level: 1, implicit: { minionDamage: 15 }, classes: ['binder'] },
  { id: 'grave_sceptre', name: 'Grave Sceptre', category: 'weapon', level: 4, implicit: { minionDamage: 30, spirit: 10 }, classes: ['binder'] },
  // Armour
  { id: 'leather_cap', name: 'Leather Cap', category: 'helmet', level: 1, implicit: { armor: 6 } },
  { id: 'iron_helm', name: 'Iron Helm', category: 'helmet', level: 3, implicit: { armor: 16 } },
  { id: 'circlet', name: 'Circlet', category: 'helmet', level: 3, implicit: { heatMax: 40 } },
  { id: 'padded_vest', name: 'Padded Vest', category: 'body', level: 1, implicit: { armor: 10, life: 10 } },
  { id: 'chain_mail', name: 'Chain Mail', category: 'body', level: 3, implicit: { armor: 28 } },
  { id: 'silk_robe', name: 'Silk Robe', category: 'body', level: 3, implicit: { spirit: 15, heatCooling: 10 } },
  { id: 'wraps', name: 'Cloth Wraps', category: 'gloves', level: 1, implicit: { attackSpeed: 4 } },
  { id: 'gauntlets', name: 'Iron Gauntlets', category: 'gloves', level: 3, implicit: { armor: 10 } },
  { id: 'spellweave_gloves', name: 'Spellweave Gloves', category: 'gloves', level: 3, implicit: { castSpeed: 8 } },
  { id: 'sandals', name: 'Sandals', category: 'boots', level: 1, implicit: { moveSpeed: 4 } },
  { id: 'greaves', name: 'Greaves', category: 'boots', level: 3, implicit: { armor: 10, moveSpeed: 2 } },
  { id: 'rope_belt', name: 'Rope Belt', category: 'belt', level: 1, implicit: { life: 12 } },
  { id: 'heavy_belt', name: 'Heavy Belt', category: 'belt', level: 3, implicit: { life: 20, armor: 5 } },
  { id: 'bone_amulet', name: 'Bone Amulet', category: 'amulet', level: 1, implicit: { spirit: 8 } },
  { id: 'jade_amulet', name: 'Jade Amulet', category: 'amulet', level: 3, implicit: { life: 20 } },
  { id: 'iron_ring', name: 'Iron Ring', category: 'ring', level: 1, implicit: { damage: 5 } },
  { id: 'coral_ring', name: 'Coral Ring', category: 'ring', level: 2, implicit: { life: 12 } },
  { id: 'moonstone_ring', name: 'Moonstone Ring', category: 'ring', level: 3, implicit: { heatMax: 25 } },
];

export function gearBase(id: string): GearBase | undefined {
  return GEAR_BASES.find((b) => b.id === id);
}

/** Which gear stat each gear affix feeds. Affix values are added straight into that stat. */
export const GEAR_AFFIX_STATS = {
  gear_life: 'life',
  gear_armor: 'armor',
  gear_move: 'moveSpeed',
  gear_force: 'heatMax',
  gear_cooling: 'heatCooling',
  gear_spirit: 'spirit',
  gear_damage: 'damage',
  gear_cast: 'castSpeed',
  gear_attack: 'attackSpeed',
  gear_regen: 'lifeRegen',
  gear_minion_damage: 'minionDamage',
  gear_minion_life: 'minionLife',
} as const satisfies Record<string, StatId>;

export type GearAffixId = keyof typeof GEAR_AFFIX_STATS;
