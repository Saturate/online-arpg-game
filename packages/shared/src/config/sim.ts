export const SIM = {
  tickRate: 20,
  tickMs: 50,
  dt: 0.05,
  arena: { width: 2800, height: 2000 },
  /** Extra radius added to enemy hitboxes when tested against player projectiles. */
  enemyHitLeniency: 6,
  /** Server consumes at most this many buffered inputs per player per tick, so jitter can catch up without allowing speed hacks. */
  inputCreditCap: 3,
  /** Inputs beyond this are dropped oldest-first, bounding the latency a client can build up. */
  inputQueueMax: 10,
  playerRespawnSeconds: 3,
  playerRadius: 14,
  /** Players (re)spawn at whichever of this many random points is farthest from enemies, so a camped corpse is not a death loop. */
  playerSpawnCandidates: 12,
  playerSpawnMargin: 120,
  /** Melee hits resolve instantly; this only controls how long the arc stays visible. */
  swingVisualSeconds: 0.15,
} as const;

export const ARMOR = {
  /** Damage taken = raw * scale / (scale + armor). */
  scale: 100,
  values: { heavy: 60, light: 25, robe: 10 },
} as const;

/**
 * The casting resource, shown to players as "Force". Internally it keeps the spec's name, heat.
 * The cap is set very high for now so it never gets in the way while skills are being tuned.
 */
export const HEAT = {
  displayName: 'Force',
  max: 1000,
  overheatMax: 1300,
  coolPerSecond: 25,
  coolPauseSeconds: 0.5,
  /** Misfire chance grows linearly from 0 at `max` to this value at `overheatMax`. */
  misfireChanceAtCap: 0.5,
  misfireLifeFraction: 0.1,
  dudHeatFraction: 0.5,
  affinityMultiplier: 0.8,
  offAffinityMultiplier: 1.2,
  depthHeatFactor: 0.5,
  /** Minimum time between any two sigil casts, so holding a key at 20 Hz input is not 20 casts per second. */
  castCooldownSeconds: 0.3,
} as const;

export const SPELL = {
  maxDepth: 3,
  maxEntities: 24,
  splitDefaultCount: 3,
  splitEfficiency: 1.2,
  /** Angle between split copies of a directional form. */
  splitSpreadRadians: 0.26,
  /** Distance from the split point for copies of a non-directional form. */
  splitRingOffset: 70,
  timerSeconds: 0.5,
  /** Pulse fires this often while its form lives. */
  pulseSeconds: 0.18,
  /** Pulse splits spray outward, rotating this much between pulses. */
  pulseRotation: 0.7,
  bolt: { damage: 16, speed: 520, range: 560, radius: 8 },
  nova: { damage: 14, radius: 130, durationSeconds: 0.3, heal: 25, shield: 30 },
  zone: { damage: 6, radius: 95, durationSeconds: 3, tickSeconds: 0.5, heal: 5, shield: 8 },
  dash: { damage: 12, distance: 190, ticks: 4, hitRadius: 26 },
  modifiers: {
    swiftSpeed: 1.5,
    swiftDash: 1.3,
    largeRadius: 1.5,
    lingerDuration: 1.75,
    pierceHits: 2,
  },
  forceKnockback: 320,
  shieldSeconds: 4,
  comboDamageBonus: 0.25,
  /** Burning Ward: enemies touching a burning shield take this much fire damage per touch. */
  burningWardDamage: 8,
} as const;

export const AILMENTS = {
  burn: { seconds: 3, dpsFractionOfHit: 0.2 },
  chill: { seconds: 2, slow: 0.35 },
  shock: { seconds: 3, damageTakenBonus: 0.2 },
} as const;

export const AURA = {
  radius: 170,
  restoreRegenPerSecond: 4,
  wardReduction: 0.15,
  elementDps: 5,
  /** Knockback velocity added per tick; enemy knockback decays each tick, so this settles at a steady outward drift. */
  forcePushPerTick: 9,
  /** Hard cap on regeneration per second from auras and links combined. */
  regenCapPerSecond: 8,
} as const;

export const LINK = {
  acquireRange: 380,
  acquireConeRadians: Math.PI / 4,
  breakRange: 480,
  restoreRegenPerSecond: 6,
  wardReduction: 0.3,
  elementDamageBonus: 0.15,
} as const;

export const WAVES = {
  firstWaveDelaySeconds: 2,
  betweenWavesSeconds: 4,
  baseCount: 5,
  perWave: 2,
  maxCount: 36,
  perExtraPlayer: 0.5,
  /** Enemies spawn at least this far from every player... */
  minSpawnDistance: 380,
  /** ...and within this distance of some player, so a wave is never off in a far corner. */
  maxSpawnDistance: 900,
  spawnMargin: 60,
  spawnAttempts: 30,
  rareChanceBase: 0.08,
  rareChancePerWave: 0.02,
  rareChanceMax: 0.35,
  rareScale: 1.45,
  rareLifeMultiplier: 3,
  shooterFromWave: 2,
  spinnerFromWave: 3,
} as const;

export const LOOT = {
  bagLifetimeSeconds: 90,
  bagRadius: 16,
  normalDropChance: 0.14,
  gearShareOfDrops: 0.5,
  vesselShareOfDrops: 0.15,
  rareDropCount: { min: 1, max: 2 },
  corruptChance: 0.08,
  corruptMisfireMultiplier: 1.5,
  inventorySize: 20,
} as const;

export const SPIRIT = {
  vesselBaseByTier: { common: 15, magic: 20, rare: 25, relic: 30 },
  vesselPerAffix: 5,
} as const;

export const MINIONS = {
  warbandSlots: 4,
  armyCap: 6,
  respawnSeconds: 10,
  followDistance: 70,
  defensiveEngageRadius: 260,
  defensiveLeash: 320,
  aggressiveEngageRadius: 520,
  aggressiveLeash: 900,
  hunterEngageMultiplier: 1.6,
  bodyguardDistance: 60,
  bodyguardInterceptBonus: 14,
  cowardRetreatAt: 0.3,
  cowardResumeAt: 0.8,
  cowardRegenFraction: 0.05,
  explodeRadius: 95,
  explodeDamage: 40,
  tauntRadius: 170,
  tauntSeconds: 1.5,
  leechFraction: 0.1,
  levelScaling: 0.1,
  /** Wraiths default to hunting, which widens their engage radius a little even without the Hunter affix. */
  defaultHuntEngageMultiplier: 1.25,
  spawnOffset: 40,
  arrowRadius: 5,
  arrowRangeMultiplier: 1.3,
  volleySpreadRadians: 0.15,
  catchUpDistance: 400,
  catchUpSpeedMultiplier: 1.6,
  trailSpacing: 40,
  trailLength: 40,
  /** Minions chase what their master hit within this many ticks. */
  focusTicks: 60,
  /** Out of sight for this many ticks and a minion drops its target. */
  lostSightTicks: 40,
  separation: 1.1,
  interceptRange: 260,
  formationSpacing: 34,
} as const;

export const NET = {
  interpolationDelayMs: 100,
  pingIntervalMs: 1000,
  defaultPort: 8080,
  /** Entities farther than this from a player are not sent to that player. */
  interestRadius: 1100,
} as const;

export const NAV = {
  cellSize: 40,
  /** Cells are walkable when a circle this size fits at their centre. */
  agentRadius: 14,
  rebuildEveryTicks: 5,
  /** Flow field search stops this many cells out; enemies further away than this are idle anyway. */
  maxSearchSteps: 90,
  /** Minions stuck this far from their master are pulled back to them, as most ARPGs do. */
  minionTeleportDistance: 700,
} as const;

/** Skills are prebaked per class for now; free rune editing is a testing tool. */
export const SANDBOX = {
  /** The sigil editor only works in the test arena until skills open up for players. */
  editorMaps: ['arena'],
  testSigilTier: 'relic',
} as const;

export const WILDS = {
  width: 5600,
  height: 4200,
  ridges: 5,
  forests: 6,
  ruins: 3,
  looseRocks: 70,
  packs: 30,
  packSpacing: 420,
  /** No packs within this distance of the camp, so arriving is never an ambush. */
  safeRadius: 750,
  levelDistance: 900,
  rareLeaderChance: 0.3,
  aggroRadius: 460,
  /** Pack members within this distance of a hit enemy join the fight too. */
  alertRadius: 320,
  leashDistance: 1300,
  packSpread: 110,
  /** Empty instances are closed after this long. */
  idleCloseSeconds: 300,
} as const;

export const PROGRESSION = {
  maxLevel: 50,
  /** XP from level L to L+1 is xpBase * L^xpExponent: 60 for the first level, ~3.4k at 10, ~52k at 40. */
  xpBase: 60,
  xpExponent: 1.75,
  /** Per level: a share of the class's base life, flat Force and spirit, and increased damage. */
  lifePerLevel: 0.06,
  forcePerLevel: 12,
  spiritPerLevel: 1,
  damagePerLevel: 0.015,
  /** A level-m monster is worth monsterXpBase * m^monsterXpExponent before rare and boss multipliers. */
  monsterXpBase: 6,
  monsterXpExponent: 1.35,
  rareXpMultiplier: 4,
  summonedXpMultiplier: 0.25,
  bossXpMultiplier: 18,
  /** D2-style: farming far below your level pays almost nothing. */
  grayGap: 5,
  grayPenaltyPerLevel: 0.15,
  grayFloor: 0.05,
  /** Players this close to a kill share its XP, with a bonus per extra member so grouping pays. */
  partyRange: 1500,
  partyBonusPerMember: 0.35,
  /** Items need this many levels less than their item level, so drops are usable a little early. */
  requirementSlack: 2,
} as const;

/** Overworld zones east of the town (the home zone adds the town's width on top). */
export const ZONE_SIZE = {
  width: 5200,
  height: 3600,
} as const;

export const DUNGEON = {
  /** Room slots across and down; one room per slot. */
  slotsX: 4,
  slotsY: 3,
  /** Slot size in nav cells (40 units), so a slot is 880 units square. */
  slotCells: 22,
  roomMin: 9,
  roomMax: 17,
  corridorCells: 3,
  /** Corridors beyond the spanning tree, so some rooms can be reached two ways. */
  extraLinks: 3,
  wallHeight: 70,
  /** Monster levels climb by up to this much from the entrance to the boss room. */
  levelSpread: 2,
  rareLeaderChance: 0.45,
  /** Entrances per Wilds map, and how far from the camp they must be. */
  entrances: 2,
  entranceMinDistance: 1400,
  /** Ready check countdown before the party is sent in together. */
  countdownSeconds: 3,
  /** Killing the boss opens a cache on top of its own drops: this many items, rare or better, one level up. */
  cacheItems: 3,
  // Richer per item than a boss drop (30% vs 18% relic), since clearing the whole run earns it.
  cacheTierWeights: { common: 0, magic: 0, rare: 70, relic: 30 },
  names: ['The Sunken Crypt', 'Hollow Vaults', 'The Bone Cellar', 'Drowned Catacombs', 'The Ember Pit', 'Wormwood Tunnels'],
} as const;

/** Per monster level above 1. */
export const ENEMY_LEVEL = {
  lifePerLevel: 0.28,
  damagePerLevel: 0.14,
  bossLifeMultiplier: 3,
} as const;

export const GROUND = {
  /** Roads and paths: walking on them is this much faster, for players, minions and monsters alike. */
  roadSpeedBonus: 0.1,
} as const;
