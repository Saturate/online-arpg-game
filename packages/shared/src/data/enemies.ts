import { AFFIXES, type AffixId } from './affixes.js';
import type { ElementId } from './runes.js';

/**
 * Monster definitions. The three originals (chaser, shooter, spinner) keep their bespoke AI; every
 * newer monster is a `monster`: a movement style plus a list of abilities and passive traits, run
 * by one generic AI in sim/enemies.ts. Adding a monster is then mostly data.
 */

export type EnemyBehaviour = 'chaser' | 'shooter' | 'spinner' | 'monster';

export type MonsterFamily =
  | 'fallen'
  | 'swarm'
  | 'brute'
  | 'archer'
  | 'caster'
  | 'summoner'
  | 'charger'
  | 'exploder'
  | 'shielder'
  | 'shaman'
  | 'leaper'
  | 'burrower'
  | 'totem'
  | 'ghost'
  | 'poisoner'
  | 'splitter'
  | 'beast'
  | 'elemental'
  | 'golem'
  | 'flyer'
  | 'lurker'
  | 'boss';

/**
 * - melee: walks straight at the target (flow field around obstacles).
 * - flank: melee, but approaches from the side so a swarm surrounds instead of queueing.
 * - ranged: holds `preferredRange`, strafing.
 * - kite: holds range and backs off harder when approached, stops to shoot.
 * - stationary: never moves (totems).
 * - ghost: drifts straight through obstacles.
 * - erratic: melee with a zig-zag weave (bats).
 * - burrow: travels hidden underground, surfaces near the target.
 * - fly: weaves toward the target over water; rocks and walls still stop it. Holds `preferredRange` if set.
 */
export type Movement = 'melee' | 'flank' | 'ranged' | 'kite' | 'stationary' | 'ghost' | 'erratic' | 'burrow' | 'fly';

export type HazardKind = 'poison' | 'fire' | 'frost';

interface AbilityBase {
  cooldown: number;
  /** Only usable when the target is within this distance. */
  range: number;
  /** Seconds of telegraph before it resolves; the monster stands still meanwhile. 0 resolves at once. */
  windup: number;
  /** Boss phase two only. */
  enragedOnly?: boolean;
}

export type Ability =
  /** Ground slam in a circle at the target's position when the wind-up began. */
  | (AbilityBase & { kind: 'slam'; radius: number; damage: number; element?: ElementId; atSelf?: boolean })
  /** Aimed volley; the aim locks at the start of the wind-up so a telegraphed shot can be sidestepped. */
  | (AbilityBase & { kind: 'shoot'; bullets: number; spread: number; speed: number; damage: number; radius: number; element?: ElementId; homing?: number })
  /** Bullets in every direction. */
  | (AbilityBase & { kind: 'ring'; bullets: number; speed: number; damage: number; radius: number; element?: ElementId })
  /** Delayed ground explosions: one on the target plus `extra` scattered around it. */
  | (AbilityBase & { kind: 'blast'; radius: number; damage: number; extra: number; element?: ElementId })
  | (AbilityBase & { kind: 'summon'; type: EnemyTypeId; count: number; cap: number })
  /** Dash in a straight line locked at wind-up start, hitting everything it runs through once. */
  | (AbilityBase & { kind: 'charge'; speed: number; duration: number; damage: number; width: number })
  /** Jump onto the target's position and hit around the landing point. */
  | (AbilityBase & { kind: 'leap'; minRange: number; radius: number; damage: number; duration: number })
  /** Suicide: detonates around itself and dies. `range` is the trigger distance. */
  | (AbilityBase & { kind: 'explode'; radius: number; damage: number; element?: ElementId; hazard?: HazardKind })
  /** Heals nearby hurt allies by a share of their max life. */
  | (AbilityBase & { kind: 'heal'; radius: number; percent: number })
  /** Raises recently fallen monsters nearby, like a D2 fallen shaman. */
  | (AbilityBase & { kind: 'raise'; radius: number; count: number })
  /** Leaves a damaging puddle: lobbed at the target, or dropped where the monster stands. */
  | (AbilityBase & { kind: 'pool'; radius: number; dps: number; duration: number; hazard: HazardKind; atSelf?: boolean })
  /** Teleports to a spot `distance` from the target; the arrival point is telegraphed. */
  | (AbilityBase & { kind: 'blink'; distance: number });

export type AbilityKind = Ability['kind'];

export interface MonsterTraits {
  /** Projectiles arriving within this arc of its facing are blocked (radians, full width). */
  frontalBlock?: number;
  splitInto?: { type: EnemyTypeId; count: number };
  /** Explodes when killed. */
  deathBurst?: { radius: number; damage: number; element?: ElementId; hazard?: HazardKind };
  /** Below this share of life the monster enrages: faster, quicker abilities, phase-two abilities unlock. */
  enrage?: { at: number; speed: number; cooldown: number };
  /** Burrowers resurface within this distance and stay up this long before diving again. */
  burrow?: { surfaceRange: number; surfacedSeconds: number };
  knockbackImmune?: boolean;
  /** Element of its melee hits, so a frost wraith's touch chills. */
  contactElement?: ElementId;
  /** Statues and mimics: perfectly still until a target comes this close (or it is hit). */
  dormant?: { wakeRange: number };
  /** Players within this radius are cursed and deal less damage while they stay near. */
  curse?: { radius: number };
}

interface EnemyBase {
  id: EnemyTypeId;
  name: string;
  life: number;
  moveSpeed: number;
  radius: number;
  contactDamage: number;
  contactCooldown: number;
  color: number;
  /** Multiplier on the level-based kill XP; 1 when absent. */
  xp?: number;
}

export type EnemyDef =
  | (EnemyBase & { behaviour: 'chaser' })
  | (EnemyBase & {
      behaviour: 'shooter';
      preferredRange: number;
      fireCooldown: number;
      bullets: number;
      spread: number;
      bulletSpeed: number;
      bulletDamage: number;
      bulletRadius: number;
      bulletRange: number;
    })
  | (EnemyBase & {
      behaviour: 'spinner';
      preferredRange: number;
      fireCooldown: number;
      bullets: number;
      rotationPerVolley: number;
      bulletSpeed: number;
      bulletDamage: number;
      bulletRadius: number;
      bulletRange: number;
    })
  | MonsterDef;

export interface MonsterDef extends EnemyBase {
  behaviour: 'monster';
  family: MonsterFamily;
  movement: Movement;
  /** Ranged and kiting monsters hold this distance. */
  preferredRange: number;
  abilities: readonly Ability[];
  traits: MonsterTraits;
}

export const ENEMY_TYPE_IDS = [
  'chaser',
  'shooter',
  'spinner',
  // Swarms
  'plague_rat',
  'blood_bat',
  'spiderling',
  // Brutes
  'grave_brute',
  'ogre',
  // Archers
  'bandit_archer',
  'bone_archer',
  // Casters
  'frost_adept',
  'pyromancer',
  'storm_caller',
  // Summoner
  'necromancer',
  // Chargers
  'tusked_boar',
  'horned_charger',
  // Exploders
  'bloated_corpse',
  'volatile',
  // Shielder
  'tomb_guard',
  // Shamans
  'fallen_shaman',
  'grave_priest',
  // Leaper
  'ghoul',
  // Burrower
  'sand_burrower',
  // Totems
  'bone_spire',
  'flame_totem',
  // Ghosts
  'wraith',
  'banshee',
  // Poisoners
  'bog_spitter',
  'venom_spider',
  // Splitters
  'ooze',
  'oozeling',
  // Beasts
  'dire_wolf',
  'hellhound',
  'giant_scorpion',
  'thorn_beast',
  'cave_spider',
  'lizardman',
  // Insects
  'scarab',
  'carrion_beetle',
  // Flyers
  'vulture',
  'harpy',
  // Slimes
  'fire_slime',
  'frost_slime',
  // Elementals
  'fire_elemental',
  'frost_elemental',
  'storm_elemental',
  'will_o_wisp',
  // Golems
  'earth_golem',
  'bone_golem',
  'iron_golem',
  // Forest
  'treant',
  'spore_man',
  // Lurkers and statues
  'bog_lurker',
  'gargoyle',
  'mimic',
  'sand_worm',
  // Desert and crypt dwellers
  'mummy',
  'ice_wraith',
  // Demons and their servants
  'imp',
  'cultist',
  'hellspawn',
  // Bosses
  'butcher',
  'lich',
  'broodmother',
  'infernal',
  'sand_wyrm',
  'treant_king',
  'frost_giant',
] as const;
export type EnemyTypeId = (typeof ENEMY_TYPE_IDS)[number];

export function isEnemyTypeId(v: unknown): v is EnemyTypeId {
  return typeof v === 'string' && ENEMY_TYPE_IDS.some((t) => t === v);
}

function monster(
  id: EnemyTypeId,
  name: string,
  family: MonsterFamily,
  movement: Movement,
  base: { life: number; speed: number; radius: number; contact: number; contactCooldown?: number; color: number; range?: number; xp?: number },
  abilities: readonly Ability[] = [],
  traits: MonsterTraits = {},
): MonsterDef {
  return {
    id,
    name,
    behaviour: 'monster',
    family,
    movement,
    life: base.life,
    moveSpeed: base.speed,
    radius: base.radius,
    contactDamage: base.contact,
    contactCooldown: base.contactCooldown ?? 1,
    color: base.color,
    ...(base.xp !== undefined ? { xp: base.xp } : {}),
    preferredRange: base.range ?? 0,
    abilities,
    traits,
  };
}

export const ENEMIES: Record<EnemyTypeId, EnemyDef> = {
  chaser: {
    id: 'chaser',
    name: 'Chaser',
    behaviour: 'chaser',
    life: 40,
    moveSpeed: 125,
    radius: 13,
    contactDamage: 10,
    contactCooldown: 0.8,
    color: 0xd9534f,
  },
  shooter: {
    id: 'shooter',
    name: 'Shooter',
    behaviour: 'shooter',
    life: 55,
    moveSpeed: 95,
    radius: 14,
    contactDamage: 6,
    contactCooldown: 1,
    color: 0xe0913a,
    preferredRange: 300,
    fireCooldown: 1.5,
    bullets: 3,
    spread: 0.22,
    bulletSpeed: 270,
    bulletDamage: 9,
    bulletRadius: 6,
    bulletRange: 620,
  },
  spinner: {
    id: 'spinner',
    name: 'Spinner',
    behaviour: 'spinner',
    life: 90,
    moveSpeed: 55,
    radius: 18,
    contactDamage: 8,
    contactCooldown: 1,
    color: 0xb04fd0,
    preferredRange: 340,
    fireCooldown: 1,
    bullets: 8,
    rotationPerVolley: 0.3,
    bulletSpeed: 190,
    bulletDamage: 8,
    bulletRadius: 7,
    bulletRange: 560,
  },

  // Swarms: weak alone, dangerous in the numbers they come in.
  plague_rat: monster('plague_rat', 'Plague Rat', 'swarm', 'flank', { life: 16, speed: 165, radius: 9, contact: 5, contactCooldown: 0.6, color: 0x6e6252 }),
  blood_bat: monster('blood_bat', 'Blood Bat', 'swarm', 'erratic', { life: 14, speed: 190, radius: 9, contact: 4, contactCooldown: 0.5, color: 0x7a1e2e }),
  spiderling: monster('spiderling', 'Spiderling', 'swarm', 'flank', { life: 12, speed: 175, radius: 8, contact: 4, contactCooldown: 0.6, color: 0x3a3a2a }),

  // Brutes: slow, telegraphed, hit very hard.
  grave_brute: monster(
    'grave_brute',
    'Grave Brute',
    'brute',
    'melee',
    { life: 210, speed: 70, radius: 20, contact: 12, contactCooldown: 1.4, color: 0xc8c0a8 },
    [{ kind: 'slam', cooldown: 3.2, range: 90, windup: 0.9, radius: 70, damage: 34 }],
    { knockbackImmune: true },
  ),
  ogre: monster(
    'ogre',
    'Swamp Ogre',
    'brute',
    'melee',
    { life: 300, speed: 62, radius: 24, contact: 14, contactCooldown: 1.5, color: 0x6a8a4a },
    [
      { kind: 'slam', cooldown: 3.6, range: 100, windup: 1.0, radius: 85, damage: 40 },
      { kind: 'slam', cooldown: 7, range: 130, windup: 1.2, radius: 130, damage: 26, atSelf: true },
    ],
    { knockbackImmune: true },
  ),

  // Archers: keep their distance and shoot telegraphed volleys.
  bandit_archer: monster(
    'bandit_archer',
    'Bandit Archer',
    'archer',
    'kite',
    { life: 48, speed: 110, radius: 13, contact: 5, color: 0x8a6a3a, range: 360 },
    [{ kind: 'shoot', cooldown: 1.8, range: 620, windup: 0.45, bullets: 1, spread: 0, speed: 460, damage: 15, radius: 5 }],
  ),
  bone_archer: monster(
    'bone_archer',
    'Bone Archer',
    'archer',
    'ranged',
    { life: 42, speed: 90, radius: 13, contact: 5, color: 0xd8d0b8, range: 330 },
    [{ kind: 'shoot', cooldown: 2.2, range: 600, windup: 0.35, bullets: 3, spread: 0.16, speed: 360, damage: 8, radius: 5 }],
  ),

  // Casters: slow magic that rewards moving.
  frost_adept: monster(
    'frost_adept',
    'Frost Adept',
    'caster',
    'kite',
    { life: 60, speed: 80, radius: 14, contact: 5, color: 0x7ab8ff, range: 380 },
    [{ kind: 'shoot', cooldown: 2.4, range: 640, windup: 0.3, bullets: 1, spread: 0, speed: 160, damage: 18, radius: 10, element: 'cold', homing: 1.6 }],
  ),
  pyromancer: monster(
    'pyromancer',
    'Pyromancer',
    'caster',
    'ranged',
    { life: 64, speed: 80, radius: 14, contact: 5, color: 0xff7a3a, range: 400 },
    [{ kind: 'blast', cooldown: 3.2, range: 620, windup: 1.1, radius: 60, damage: 30, extra: 0, element: 'fire' }],
  ),
  storm_caller: monster(
    'storm_caller',
    'Storm Caller',
    'caster',
    'ranged',
    { life: 58, speed: 85, radius: 14, contact: 5, color: 0xf0e060, range: 420 },
    [{ kind: 'blast', cooldown: 3.6, range: 640, windup: 0.8, radius: 38, damage: 20, extra: 3, element: 'lightning' }],
  ),

  // Summoner: keep away, raise a wall of skeletons.
  necromancer: monster(
    'necromancer',
    'Necromancer',
    'summoner',
    'kite',
    { life: 80, speed: 80, radius: 15, contact: 5, color: 0x6aff9a, range: 420 },
    [
      { kind: 'summon', cooldown: 6, range: 700, windup: 1.0, type: 'chaser', count: 2, cap: 5 },
      { kind: 'shoot', cooldown: 2.6, range: 560, windup: 0.3, bullets: 1, spread: 0, speed: 240, damage: 12, radius: 8, homing: 0.8 },
    ],
  ),

  // Chargers: line up, then run you over.
  tusked_boar: monster(
    'tusked_boar',
    'Tusked Boar',
    'charger',
    'melee',
    { life: 90, speed: 105, radius: 16, contact: 8, color: 0x7a5238 },
    [{ kind: 'charge', cooldown: 4.5, range: 380, windup: 0.8, speed: 560, duration: 0.6, damage: 24, width: 22 }],
    { knockbackImmune: true },
  ),
  horned_charger: monster(
    'horned_charger',
    'Horned Charger',
    'charger',
    'melee',
    { life: 150, speed: 95, radius: 19, contact: 10, color: 0x9a3a2a },
    [{ kind: 'charge', cooldown: 5, range: 460, windup: 0.9, speed: 640, duration: 0.7, damage: 32, width: 26 }],
    { knockbackImmune: true },
  ),

  // Exploders: kill them at range, or pay for it.
  bloated_corpse: monster(
    'bloated_corpse',
    'Bloated Corpse',
    'exploder',
    'melee',
    { life: 70, speed: 60, radius: 17, contact: 6, color: 0x8a9a5a },
    [],
    { deathBurst: { radius: 90, damage: 22, hazard: 'poison' } },
  ),
  volatile: monster(
    'volatile',
    'Volatile',
    'exploder',
    'melee',
    { life: 24, speed: 175, radius: 11, contact: 0, color: 0xffa040 },
    [{ kind: 'explode', cooldown: 0, range: 55, windup: 0.6, radius: 85, damage: 36, element: 'fire' }],
    { deathBurst: { radius: 55, damage: 12, element: 'fire' } },
  ),

  // Shielder: blocks shots from the front; get behind it.
  tomb_guard: monster(
    'tomb_guard',
    'Tomb Guard',
    'shielder',
    'melee',
    { life: 150, speed: 80, radius: 17, contact: 14, contactCooldown: 1.1, color: 0xa0a8b8 },
    [],
    { frontalBlock: 2.0, knockbackImmune: true },
  ),

  // Shamans: kill these first.
  fallen_shaman: monster(
    'fallen_shaman',
    'Fallen Shaman',
    'shaman',
    'kite',
    { life: 55, speed: 95, radius: 13, contact: 5, color: 0xe05a3a, range: 320 },
    [
      { kind: 'raise', cooldown: 5, range: 900, windup: 0.9, radius: 420, count: 2 },
      { kind: 'blast', cooldown: 3, range: 520, windup: 0.9, radius: 45, damage: 16, extra: 0, element: 'fire' },
    ],
  ),
  grave_priest: monster(
    'grave_priest',
    'Grave Priest',
    'shaman',
    'kite',
    { life: 70, speed: 85, radius: 14, contact: 5, color: 0xb08ad8, range: 340 },
    [
      { kind: 'heal', cooldown: 4, range: 900, windup: 0.6, radius: 320, percent: 30 },
      { kind: 'shoot', cooldown: 2.4, range: 560, windup: 0.25, bullets: 2, spread: 0.2, speed: 280, damage: 9, radius: 6 },
    ],
  ),

  // Leaper: closes gaps by jumping; the landing is telegraphed.
  ghoul: monster(
    'ghoul',
    'Ghoul',
    'leaper',
    'melee',
    { life: 85, speed: 130, radius: 14, contact: 9, contactCooldown: 0.8, color: 0xa8b098 },
    [{ kind: 'leap', cooldown: 4, range: 420, windup: 0.5, minRange: 140, radius: 60, damage: 20, duration: 0.55 }],
  ),

  // Burrower: invisible and untouchable underground, erupts under you.
  sand_burrower: monster(
    'sand_burrower',
    'Sand Burrower',
    'burrower',
    'burrow',
    { life: 120, speed: 120, radius: 17, contact: 10, color: 0xc8a060 },
    [{ kind: 'slam', cooldown: 4, range: 80, windup: 0.8, radius: 75, damage: 28, atSelf: true }],
    { burrow: { surfaceRange: 70, surfacedSeconds: 4 }, knockbackImmune: true },
  ),

  // Totems: stationary turrets; worth killing first.
  bone_spire: monster(
    'bone_spire',
    'Bone Spire',
    'totem',
    'stationary',
    { life: 140, speed: 0, radius: 16, contact: 0, color: 0xe8e0c8 },
    [{ kind: 'ring', cooldown: 1.8, range: 520, windup: 0.4, bullets: 10, speed: 200, damage: 8, radius: 6 }],
    { knockbackImmune: true },
  ),
  flame_totem: monster(
    'flame_totem',
    'Flame Totem',
    'totem',
    'stationary',
    { life: 120, speed: 0, radius: 15, contact: 0, color: 0xff5a2a },
    [{ kind: 'shoot', cooldown: 1.4, range: 560, windup: 0.3, bullets: 1, spread: 0, speed: 220, damage: 12, radius: 8, element: 'fire', homing: 1.2 }],
    { knockbackImmune: true },
  ),

  // Ghosts: slow, pass through walls, chilling touch.
  wraith: monster(
    'wraith',
    'Wraith',
    'ghost',
    'ghost',
    { life: 75, speed: 70, radius: 15, contact: 12, contactCooldown: 1, color: 0x9fb8e0 },
    [],
    { contactElement: 'cold' },
  ),
  banshee: monster(
    'banshee',
    'Banshee',
    'ghost',
    'ghost',
    { life: 65, speed: 80, radius: 14, contact: 8, color: 0xd0e8ff, range: 260 },
    [{ kind: 'ring', cooldown: 3.5, range: 260, windup: 0.7, bullets: 14, speed: 170, damage: 7, radius: 6, element: 'cold' }],
    { contactElement: 'cold' },
  ),

  // Poisoners: turn the ground against you.
  bog_spitter: monster(
    'bog_spitter',
    'Bog Spitter',
    'poisoner',
    'ranged',
    { life: 60, speed: 85, radius: 15, contact: 5, color: 0x7aa83a, range: 360 },
    [{ kind: 'pool', cooldown: 3.4, range: 560, windup: 0.9, radius: 62, dps: 14, duration: 4.5, hazard: 'poison' }],
  ),
  venom_spider: monster(
    'venom_spider',
    'Venom Spider',
    'poisoner',
    'flank',
    { life: 55, speed: 150, radius: 14, contact: 8, contactCooldown: 0.8, color: 0x4a6a2a },
    [{ kind: 'pool', cooldown: 2.6, range: 400, windup: 0, radius: 34, dps: 10, duration: 3.5, hazard: 'poison', atSelf: true }],
  ),

  // Splitters: every kill makes more of them, but smaller.
  ooze: monster(
    'ooze',
    'Ooze',
    'splitter',
    'melee',
    { life: 110, speed: 70, radius: 19, contact: 9, color: 0x5ac8a0 },
    [],
    { splitInto: { type: 'oozeling', count: 3 } },
  ),
  oozeling: monster('oozeling', 'Oozeling', 'splitter', 'flank', { life: 26, speed: 120, radius: 10, contact: 5, contactCooldown: 0.7, color: 0x7ae0b8 }),

  // Bosses: two phases each, with a special that defines the fight.
  butcher: monster(
    'butcher',
    'The Butcher',
    'boss',
    'melee',
    { life: 1400, speed: 95, radius: 26, contact: 22, contactCooldown: 1.1, color: 0xb03030 },
    [
      { kind: 'slam', cooldown: 3.4, range: 110, windup: 0.8, radius: 95, damage: 42 },
      { kind: 'charge', cooldown: 6, range: 520, windup: 0.9, speed: 620, duration: 0.8, damage: 38, width: 30 },
      { kind: 'slam', cooldown: 8, range: 160, windup: 1.2, radius: 170, damage: 30, atSelf: true, enragedOnly: true },
    ],
    { enrage: { at: 0.5, speed: 1.5, cooldown: 0.6 }, knockbackImmune: true },
  ),
  lich: monster(
    'lich',
    'The Pale Lich',
    'boss',
    'kite',
    { life: 1100, speed: 80, radius: 22, contact: 10, color: 0x9a7aff, range: 360 },
    [
      { kind: 'summon', cooldown: 7, range: 900, windup: 1.2, type: 'bone_archer', count: 3, cap: 6 },
      { kind: 'ring', cooldown: 3, range: 520, windup: 0.6, bullets: 18, speed: 190, damage: 10, radius: 7, element: 'cold' },
      { kind: 'blast', cooldown: 4.5, range: 700, windup: 1.1, radius: 70, damage: 34, extra: 2, element: 'cold' },
      { kind: 'summon', cooldown: 9, range: 900, windup: 1.2, type: 'wraith', count: 2, cap: 4, enragedOnly: true },
    ],
    { enrage: { at: 0.5, speed: 1.2, cooldown: 0.7 }, knockbackImmune: true },
  ),
  broodmother: monster(
    'broodmother',
    'The Broodmother',
    'boss',
    'flank',
    { life: 1200, speed: 110, radius: 28, contact: 16, contactCooldown: 1, color: 0x3a4a2a },
    [
      { kind: 'summon', cooldown: 5, range: 900, windup: 0.8, type: 'spiderling', count: 5, cap: 12 },
      { kind: 'leap', cooldown: 5.5, range: 520, windup: 0.6, minRange: 160, radius: 90, damage: 34, duration: 0.7 },
      { kind: 'pool', cooldown: 4, range: 600, windup: 0.8, radius: 80, dps: 18, duration: 5, hazard: 'poison' },
      { kind: 'summon', cooldown: 8, range: 900, windup: 1, type: 'venom_spider', count: 2, cap: 4, enragedOnly: true },
    ],
    { enrage: { at: 0.4, speed: 1.3, cooldown: 0.7 }, knockbackImmune: true },
  ),
  infernal: monster(
    'infernal',
    'The Infernal',
    'boss',
    'ranged',
    { life: 1300, speed: 85, radius: 26, contact: 18, color: 0xff4a1a, range: 300 },
    [
      { kind: 'blast', cooldown: 3.2, range: 700, windup: 1.0, radius: 65, damage: 34, extra: 4, element: 'fire' },
      { kind: 'ring', cooldown: 2.6, range: 520, windup: 0.5, bullets: 16, speed: 210, damage: 11, radius: 7, element: 'fire' },
      { kind: 'pool', cooldown: 6, range: 500, windup: 0, radius: 70, dps: 20, duration: 4, hazard: 'fire', atSelf: true, enragedOnly: true },
      { kind: 'summon', cooldown: 10, range: 900, windup: 1, type: 'volatile', count: 3, cap: 6, enragedOnly: true },
    ],
    { enrage: { at: 0.4, speed: 1.3, cooldown: 0.6 }, knockbackImmune: true, deathBurst: { radius: 160, damage: 30, element: 'fire' } },
  ),

  // Beasts: pack hunters that come at you from the sides.
  dire_wolf: monster('dire_wolf', 'Dire Wolf', 'beast', 'flank', { life: 60, speed: 170, radius: 14, contact: 9, contactCooldown: 0.7, color: 0x6a6a72 }),
  hellhound: monster(
    'hellhound',
    'Hellhound',
    'beast',
    'flank',
    { life: 80, speed: 180, radius: 15, contact: 11, contactCooldown: 0.8, color: 0x8a2a1a },
    [{ kind: 'shoot', cooldown: 3, range: 260, windup: 0.4, bullets: 3, spread: 0.25, speed: 300, damage: 10, radius: 7, element: 'fire' }],
    { contactElement: 'fire', deathBurst: { radius: 60, damage: 14, element: 'fire' } },
  ),
  giant_scorpion: monster(
    'giant_scorpion',
    'Giant Scorpion',
    'beast',
    'melee',
    { life: 160, speed: 95, radius: 18, contact: 10, color: 0xa8783a },
    [{ kind: 'slam', cooldown: 2.8, range: 90, windup: 0.55, radius: 55, damage: 26 }],
    { knockbackImmune: true },
  ),
  thorn_beast: monster(
    'thorn_beast',
    'Thorn Beast',
    'charger',
    'melee',
    { life: 130, speed: 110, radius: 18, contact: 10, color: 0x4a6a2a },
    [{ kind: 'charge', cooldown: 4.5, range: 400, windup: 0.8, speed: 580, duration: 0.6, damage: 26, width: 24 }],
    { knockbackImmune: true },
  ),
  cave_spider: monster('cave_spider', 'Cave Spider', 'swarm', 'flank', { life: 30, speed: 165, radius: 11, contact: 6, contactCooldown: 0.6, color: 0x5a4a6a }),
  lizardman: monster(
    'lizardman',
    'Lizardman',
    'beast',
    'flank',
    { life: 75, speed: 135, radius: 14, contact: 9, color: 0x4a8a5a },
    [{ kind: 'shoot', cooldown: 3, range: 420, windup: 0.4, bullets: 1, spread: 0, speed: 420, damage: 14, radius: 5 }],
  ),

  // Insects: armoured, and the big ones burst into little ones.
  scarab: monster('scarab', 'Scarab', 'swarm', 'flank', { life: 22, speed: 150, radius: 9, contact: 5, contactCooldown: 0.6, color: 0x2a6a8a }, [], { knockbackImmune: true }),
  carrion_beetle: monster(
    'carrion_beetle',
    'Carrion Beetle',
    'splitter',
    'melee',
    { life: 140, speed: 75, radius: 19, contact: 10, color: 0x3a4a2a },
    [],
    { splitInto: { type: 'scarab', count: 4 }, knockbackImmune: true },
  ),

  // Flyers: cross rivers the rest of the pack has to walk around.
  vulture: monster('vulture', 'Vulture', 'flyer', 'fly', { life: 38, speed: 170, radius: 12, contact: 7, contactCooldown: 0.8, color: 0x4a3a30 }),
  harpy: monster(
    'harpy',
    'Harpy',
    'flyer',
    'fly',
    { life: 50, speed: 150, radius: 13, contact: 6, color: 0x9a7aa8, range: 240 },
    [{ kind: 'shoot', cooldown: 2.2, range: 480, windup: 0.35, bullets: 3, spread: 0.3, speed: 330, damage: 8, radius: 5 }],
  ),

  // Elemental slimes: pop them at range, they leave their element behind.
  fire_slime: monster('fire_slime', 'Fire Slime', 'splitter', 'melee', { life: 70, speed: 80, radius: 15, contact: 8, color: 0xff7a3a }, [], {
    deathBurst: { radius: 70, damage: 16, element: 'fire', hazard: 'fire' },
  }),
  frost_slime: monster('frost_slime', 'Frost Slime', 'splitter', 'melee', { life: 70, speed: 80, radius: 15, contact: 8, color: 0x8ac8ff }, [], {
    deathBurst: { radius: 70, damage: 14, element: 'cold', hazard: 'frost' },
    contactElement: 'cold',
  }),

  // Elementals.
  fire_elemental: monster(
    'fire_elemental',
    'Fire Elemental',
    'elemental',
    'ranged',
    { life: 110, speed: 90, radius: 17, contact: 10, color: 0xff6a20, range: 300 },
    [{ kind: 'ring', cooldown: 2.8, range: 420, windup: 0.5, bullets: 12, speed: 200, damage: 9, radius: 7, element: 'fire' }],
    { contactElement: 'fire', deathBurst: { radius: 80, damage: 18, element: 'fire' } },
  ),
  frost_elemental: monster(
    'frost_elemental',
    'Frost Elemental',
    'elemental',
    'kite',
    { life: 100, speed: 85, radius: 17, contact: 8, color: 0x9ad8ff, range: 340 },
    [{ kind: 'blast', cooldown: 3.4, range: 600, windup: 1.0, radius: 60, damage: 26, extra: 1, element: 'cold' }],
    { contactElement: 'cold' },
  ),
  storm_elemental: monster(
    'storm_elemental',
    'Storm Elemental',
    'elemental',
    'erratic',
    { life: 90, speed: 140, radius: 16, contact: 9, color: 0xe8e070 },
    [{ kind: 'blast', cooldown: 3, range: 520, windup: 0.7, radius: 34, damage: 18, extra: 2, element: 'lightning' }],
    { contactElement: 'lightning' },
  ),
  will_o_wisp: monster(
    'will_o_wisp',
    'Will-o-Wisp',
    'elemental',
    'ghost',
    { life: 40, speed: 110, radius: 10, contact: 0, color: 0x9affd8, range: 320 },
    [{ kind: 'shoot', cooldown: 1.8, range: 560, windup: 0.25, bullets: 1, spread: 0, speed: 200, damage: 11, radius: 7, element: 'lightning', homing: 2 }],
  ),

  // Golems: slow walls of stone, bone and iron.
  earth_golem: monster(
    'earth_golem',
    'Earth Golem',
    'golem',
    'melee',
    { life: 380, speed: 55, radius: 25, contact: 16, contactCooldown: 1.6, color: 0x8a7a5a },
    [{ kind: 'slam', cooldown: 3.8, range: 110, windup: 1.1, radius: 100, damage: 44 }],
    { knockbackImmune: true },
  ),
  bone_golem: monster(
    'bone_golem',
    'Bone Golem',
    'golem',
    'melee',
    { life: 300, speed: 70, radius: 22, contact: 14, contactCooldown: 1.4, color: 0xe0d8c0 },
    [
      { kind: 'slam', cooldown: 3.4, range: 100, windup: 0.9, radius: 80, damage: 34 },
      { kind: 'ring', cooldown: 5, range: 300, windup: 0.6, bullets: 12, speed: 220, damage: 8, radius: 6 },
    ],
    { knockbackImmune: true },
  ),
  iron_golem: monster(
    'iron_golem',
    'Iron Golem',
    'golem',
    'melee',
    { life: 340, speed: 65, radius: 23, contact: 15, contactCooldown: 1.4, color: 0x7a8290 },
    [{ kind: 'charge', cooldown: 5, range: 480, windup: 1.0, speed: 520, duration: 0.7, damage: 36, width: 30 }],
    { frontalBlock: 1.6, knockbackImmune: true },
  ),

  // Forest.
  treant: monster(
    'treant',
    'Treant',
    'brute',
    'melee',
    { life: 320, speed: 55, radius: 24, contact: 14, contactCooldown: 1.5, color: 0x5a7a3a },
    [
      { kind: 'slam', cooldown: 3.6, range: 110, windup: 1.0, radius: 90, damage: 36 },
      { kind: 'blast', cooldown: 5, range: 460, windup: 1.2, radius: 45, damage: 22, extra: 2 },
    ],
    { knockbackImmune: true },
  ),
  spore_man: monster('spore_man', 'Spore Man', 'exploder', 'melee', { life: 60, speed: 75, radius: 14, contact: 7, color: 0xb05ac0 }, [], {
    deathBurst: { radius: 90, damage: 10, hazard: 'poison' },
  }),

  // Lurkers: ambushers that wait under water, as statues, or as treasure.
  bog_lurker: monster(
    'bog_lurker',
    'Bog Lurker',
    'lurker',
    'burrow',
    { life: 150, speed: 110, radius: 19, contact: 12, color: 0x3a5a3a },
    [{ kind: 'slam', cooldown: 3.5, range: 80, windup: 0.7, radius: 70, damage: 30, atSelf: true }],
    { burrow: { surfaceRange: 80, surfacedSeconds: 5 }, knockbackImmune: true },
  ),
  gargoyle: monster(
    'gargoyle',
    'Gargoyle',
    'lurker',
    'melee',
    { life: 140, speed: 120, radius: 16, contact: 11, color: 0x7a7a80 },
    [{ kind: 'leap', cooldown: 4, range: 420, windup: 0.5, minRange: 120, radius: 60, damage: 24, duration: 0.55 }],
    { dormant: { wakeRange: 170 }, knockbackImmune: true },
  ),
  mimic: monster('mimic', 'Mimic', 'lurker', 'melee', { life: 160, speed: 140, radius: 16, contact: 16, contactCooldown: 0.8, color: 0x8a5a2a }, [], {
    dormant: { wakeRange: 90 },
    knockbackImmune: true,
  }),
  sand_worm: monster(
    'sand_worm',
    'Sand Worm',
    'burrower',
    'burrow',
    { life: 260, speed: 130, radius: 24, contact: 14, color: 0xb8905a },
    [{ kind: 'slam', cooldown: 3.2, range: 90, windup: 0.8, radius: 100, damage: 38, atSelf: true }],
    { burrow: { surfaceRange: 90, surfacedSeconds: 3.5 }, knockbackImmune: true },
  ),

  // Desert and crypt.
  mummy: monster('mummy', 'Mummy', 'brute', 'melee', { life: 170, speed: 65, radius: 16, contact: 13, contactCooldown: 1.2, color: 0xc8b890 }, [], { curse: { radius: 220 } }),
  ice_wraith: monster(
    'ice_wraith',
    'Ice Wraith',
    'ghost',
    'ghost',
    { life: 80, speed: 85, radius: 15, contact: 10, color: 0xb8e8ff, range: 240 },
    [{ kind: 'ring', cooldown: 3, range: 260, windup: 0.6, bullets: 12, speed: 180, damage: 8, radius: 6, element: 'cold' }],
    { contactElement: 'cold' },
  ),

  // Demons and their servants.
  imp: monster(
    'imp',
    'Imp',
    'caster',
    'kite',
    { life: 45, speed: 130, radius: 11, contact: 5, color: 0xd04a2a, range: 320 },
    [
      { kind: 'blink', cooldown: 4, range: 700, windup: 0.3, distance: 260 },
      { kind: 'shoot', cooldown: 1.6, range: 560, windup: 0.2, bullets: 1, spread: 0, speed: 320, damage: 12, radius: 6, element: 'fire' },
    ],
  ),
  cultist: monster(
    'cultist',
    'Cultist',
    'summoner',
    'kite',
    { life: 70, speed: 85, radius: 14, contact: 5, color: 0x6a1a2a, range: 380 },
    [
      { kind: 'summon', cooldown: 7, range: 800, windup: 1.0, type: 'volatile', count: 2, cap: 3 },
      { kind: 'blast', cooldown: 3, range: 560, windup: 0.9, radius: 45, damage: 20, extra: 0, element: 'fire' },
    ],
  ),
  hellspawn: monster(
    'hellspawn',
    'Hellspawn',
    'charger',
    'melee',
    { life: 170, speed: 120, radius: 19, contact: 14, color: 0xa0201a },
    [{ kind: 'charge', cooldown: 4, range: 460, windup: 0.7, speed: 640, duration: 0.6, damage: 30, width: 26 }],
    { contactElement: 'fire', knockbackImmune: true },
  ),

  // Bosses for the desert, forest and caves.
  sand_wyrm: monster(
    'sand_wyrm',
    'The Sand Wyrm',
    'boss',
    'burrow',
    { life: 1500, speed: 120, radius: 30, contact: 20, color: 0xc8a060 },
    [
      { kind: 'slam', cooldown: 3, range: 110, windup: 0.9, radius: 130, damage: 40, atSelf: true },
      { kind: 'charge', cooldown: 5, range: 520, windup: 1.0, speed: 700, duration: 0.8, damage: 40, width: 36 },
      { kind: 'blast', cooldown: 6, range: 700, windup: 1.1, radius: 70, damage: 30, extra: 4, enragedOnly: true },
      { kind: 'summon', cooldown: 9, range: 900, windup: 1.0, type: 'sand_worm', count: 2, cap: 3, enragedOnly: true },
    ],
    { burrow: { surfaceRange: 100, surfacedSeconds: 5 }, enrage: { at: 0.5, speed: 1.3, cooldown: 0.7 }, knockbackImmune: true },
  ),
  treant_king: monster(
    'treant_king',
    'The Treant King',
    'boss',
    'melee',
    { life: 1600, speed: 60, radius: 32, contact: 20, contactCooldown: 1.4, color: 0x3a5a2a },
    [
      { kind: 'slam', cooldown: 3.6, range: 130, windup: 1.0, radius: 110, damage: 44 },
      { kind: 'blast', cooldown: 4.5, range: 700, windup: 1.2, radius: 55, damage: 28, extra: 3 },
      { kind: 'summon', cooldown: 8, range: 900, windup: 1.0, type: 'thorn_beast', count: 2, cap: 4 },
      { kind: 'pool', cooldown: 6, range: 600, windup: 0.9, radius: 90, dps: 16, duration: 5, hazard: 'poison', enragedOnly: true },
    ],
    { enrage: { at: 0.5, speed: 1.2, cooldown: 0.7 }, knockbackImmune: true },
  ),
  frost_giant: monster(
    'frost_giant',
    'The Frost Giant',
    'boss',
    'melee',
    { life: 1700, speed: 75, radius: 30, contact: 22, contactCooldown: 1.2, color: 0x9ac8e8 },
    [
      { kind: 'slam', cooldown: 3.2, range: 120, windup: 0.9, radius: 100, damage: 46, element: 'cold' },
      { kind: 'ring', cooldown: 4, range: 520, windup: 0.7, bullets: 18, speed: 200, damage: 11, radius: 7, element: 'cold' },
      { kind: 'blast', cooldown: 5, range: 700, windup: 1.1, radius: 70, damage: 32, extra: 2, element: 'cold' },
      { kind: 'summon', cooldown: 9, range: 900, windup: 1.2, type: 'ice_wraith', count: 2, cap: 4, enragedOnly: true },
      { kind: 'slam', cooldown: 7, range: 180, windup: 1.3, radius: 180, damage: 34, element: 'cold', atSelf: true, enragedOnly: true },
    ],
    { enrage: { at: 0.5, speed: 1.3, cooldown: 0.6 }, knockbackImmune: true, contactElement: 'cold' },
  ),
};

export function monsterDef(typeId: EnemyTypeId): MonsterDef | null {
  const d = ENEMIES[typeId];
  return d.behaviour === 'monster' ? d : null;
}

export function familyOf(typeId: EnemyTypeId): MonsterFamily {
  const d = ENEMIES[typeId];
  return d.behaviour === 'monster' ? d.family : d.behaviour === 'chaser' ? 'fallen' : 'archer';
}

/**
 * D2-style monster names: prefix words, the monster, then suffix words ("Hasted Chaser of Mirrors").
 * Built on the client from the affix ids in the snapshot, so names cost no bandwidth.
 */
export function enemyDisplayName(typeId: EnemyTypeId, affixes: readonly AffixId[]): string {
  const defs = affixes.map((id) => AFFIXES[id]);
  const prefix = defs.filter((d) => d.slot === 'prefix').map((d) => d.nameWord);
  const suffix = defs.filter((d) => d.slot === 'suffix').map((d) => d.nameWord);
  return [...prefix, ENEMIES[typeId].name, ...suffix].join(' ');
}

/** Short monster affix tags for the target frame, like D2's "Extra Fast" or "Cursed". */
export const ENEMY_AFFIX_TAGS: Partial<Record<AffixId, string>> = {
  hasted: 'Extra Fast',
  extra_projectiles: 'Multishot',
  reflects_projectiles: 'Reflects Projectiles',
  armored: 'Extra Strong',
  regenerating: 'Regenerates',
};
