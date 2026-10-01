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
  coolPerSecond: 30,
  coolPauseSeconds: 0.5,
  /**
   * Cooling speeds up the longer you go without casting: +100% of the base rate per second, up to
   * six times, so a full bar clears in about eight seconds instead of making you wait it out.
   */
  coolRampPerSecond: 1,
  coolRampMax: 6,
  /** Every skill costs this share of its listed Force. */
  costMultiplier: 0.75,
  /** Misfire chance grows linearly from 0 at `max` to this value at `overheatMax`. */
  misfireChanceAtCap: 0.5,
  misfireLifeFraction: 0.1,
  dudHeatFraction: 0.5,
  affinityMultiplier: 0.8,
  offAffinityMultiplier: 1.2,
  /**
   * A rune inside a payload costs this share of its listed Force. The v1 skills were priced by hand
   * far below what a depth surcharge gave (Exploding Arrow 16 against 47 by formula), and this share
   * reproduces those prices: a payload only goes off when the cast lands, and the entity cap and
   * depth limit already bound how far a chain can go. Split is exempt, since copies multiply the cast.
   */
  payloadForceFactor: 0.15,
  /**
   * Every spawn of a payload after its first costs its full listed Force times the damage one spawn
   * can land (runes/v2/compile.ts, releaseWeight), or this share of it when a flying shape released
   * it. An interval release or a piercing on-hit shape spawns its payload many times per cast; at the
   * first-spawn share alone a Zone releasing a Nova every 0.2 s dealt about 8x a starter's damage per
   * Force, and at this share a Zone releasing a Bolt every 0.2 s still dealt over 2x to one target.
   */
  payloadRepeatShare: 0.6,
  /**
   * A payload's number affixes and the runes that only change it (elements, effects, Swift, Large)
   * cost at least this share of their listed Force, above the payload's own first-spawn share: at
   * 0.15 a Bolt releasing a Nova[+50% size, +55% damage] dealt over twice a starter's pack damage per
   * Force, since the rolls hit as hard as they would on the cast.
   */
  payloadAffixShare: 0.5,
  /**
   * No cast costs less than this, whatever the sigil waives: the cheapest plain cast (a Ranger's
   * Bolt) costs 4.8, and a free first rune took single-rune spells to 0.
   */
  minForcePerCast: 4,
  /**
   * A sigil that waives its first rune's base cost still charges this share of the cast's full
   * price. Waiving a whole Nova or Zone left a stationary root with a payload at the 4 floor, about
   * 6x a starter's pack damage per Force. The most efficient plain spells (a Ranger's
   * bolt[+55% damage]) already sit at 2x without the roll, so any share much below this pushes them
   * past it: at 0.5 a random search found 3.9x.
   */
  minWaivedForceShare: 0.95,
  /**
   * A number affix costs this much Force per step of the plain rune it replaces (Swift, Large, the
   * old Linger and Pierce runes each cost 3), measured on a log scale so two Swift steps cost twice
   * one: `affixStepForce x ln(1 + v / 100) / ln(step)`.
   */
  affixStepForce: 3,
  /** A negative roll gives back this share of what the same positive roll would cost. */
  affixRefundShare: 0.5,
  /**
   * Minimum time between any two sigil casts, so holding a key at 20 Hz input is not 20 casts per
   * second. 0.35 s is what the old 0.3 s actually waited (a float remainder cost a seventh tick),
   * so every skill kept the cadence it was balanced at when the remainder was fixed.
   */
  castCooldownSeconds: 0.35,
} as const;

export const SPELL = {
  splitEfficiency: 1.2,
  /** Angle between split copies of a directional form. */
  splitSpreadRadians: 0.26,
  /** Distance from the split point for copies of a non-directional form. */
  splitRingOffset: 70,
  /** Seconds a Timer rune waits when it carries no seconds of its own. */
  timerSeconds: 0.5,
  /** Split payloads released every X s spray outward, rotating this much between releases. */
  pulseRotation: 0.7,
  bolt: { damage: 16, speed: 520, range: 560, radius: 8 },
  /** Slow and big, and it rolls through enemies unless it bursts on hit. */
  orb: { damage: 16, speed: 286, range: 728, radius: 16 },
  nova: { damage: 14, radius: 130, durationSeconds: 0.3, heal: 25, shield: 30 },
  /**
   * Live spell entities, weighted by what they cost the server each tick: a projectile or a nova
   * checks every enemy, player and minion each tick, a zone only on its damage tick. `max` is per
   * caster (the oldest goes first); `roomMax` bounds a whole room, so 8 players at their cap fit and
   * a later raise of `max` cannot let them flood it. Measured with 8 players into 120 enemies: at 40
   * a room stays near 2 Mbit/s per client and ten busy rooms fit the tick with room to spare.
   */
  liveCap: { max: 40, roomMax: 320, projectile: 1, nova: 1, zone: 0.35 },
  // One caster's zones do not stack on a target, so a single zone carries the damage by itself.
  zone: { damage: 14, radius: 95, durationSeconds: 3, tickSeconds: 0.5, heal: 5, shield: 8 },
  dash: { damage: 12, distance: 190, ticks: 4, hitRadius: 26 },
  /**
   * What one plain-rune step of each number affix is worth, for pricing affixes (HEAT.affixStepForce).
   * Speed is x1.5 on a projectile and x1.3 on a dash (the v1 Swift rune), size x1.5 (Large),
   * duration x1.75 (Linger), damage x2 (no v1 rune; set so tuned starters keep their v1 price),
   * and pierce 2 extra hits (the v1 Pierce rune).
   */
  affixSteps: { speed: 1.5, dashSpeed: 1.3, size: 1.5, duration: 1.75, damage: 2, pierce: 2 },
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
  /**
   * Stacking damage over time from bites. Each bite adds a stack worth 12% of the hit per second and
   * resets every stack to 4 s; at 3 stacks a new bite replaces the weakest. A Grave Hound biting 10
   * every 0.9 s holds 3 stacks, 3.6 poison DPS on top of 11.1 from the bites: 14.7, between the
   * Dire Wolf (12.9) and the Hellhound's bite plus burn (16). Three stacks for a few seconds keeps
   * poison a pressure that builds while you stand in a pack, not a second life bar.
   */
  poison: { seconds: 4, maxStacks: 3, dpsFractionOfHit: 0.12 },
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

/** Arena runs: scored waves from the Arena gate. Separate from WAVES, which the sandbox-style maps keep. */
export const ARENA = {
  firstWaveDelaySeconds: 3,
  /** Breather after a wave is cleared, long enough to reposition but not to rest fully. */
  breatherSeconds: 5,
  baseCount: 6,
  perWave: 2,
  maxCount: 40,
  /** Each extra living player adds this share of the base count. */
  perExtraPlayer: 0.6,
  rareChanceBase: 0.05,
  rareChancePerWave: 0.025,
  rareChanceMax: 0.45,
  /** Chance that a spawn slot brings a whole pack from the biome pool instead of one monster. */
  packChancePerWave: 0.04,
  packChanceMax: 0.4,
  packSize: { min: 3, max: 5 },
  /** Monster level starts at the party's average level and climbs half a level per wave. */
  levelPerWave: 0.5,
  bossEvery: 5,
  /** A wave still alive after this long is joined by the next one (no clear bonus for it). */
  waveTimeLimitSeconds: 90,
  /** Clearing wave n adds n times this to the score, so surviving longer pays beyond the kills. */
  waveClearBonus: 40,
  /** Share of normal XP. Arena kills come fast and in bulk, so full XP would outpace the world. */
  xpMultiplier: 0.5,
  /** How long the score screen shows before everyone is sent back to the gate. */
  resultSeconds: 10,
  leaderboardSize: 10,
} as const;

export const LOOT = {
  bagLifetimeSeconds: 90,
  bagRadius: 16,
  /** How far a dropper walks from where they dropped a bag before they can take it back: about two strides. */
  dropStepAway: 70,
  /** Slowed on purpose (was 0.14): drops should feel like an event, and gear should last a while. */
  normalDropChance: 0.08,
  gearShareOfDrops: 0.5,
  vesselShareOfDrops: 0.15,
  /** Runes are the forge's currency, so a good share of drops are runes. */
  runeShareOfDrops: 0.25,
  rareDropCount: { min: 1, max: 2 },
  /** Chance a normal monster drops gold; rares and bosses always do. */
  goldChance: 0.35,
  /** Gold per monster level, rolled between these, then times 4 for rares and 15 for bosses. */
  goldPerLevel: { min: 2, max: 6 },
  /** Slack on top of the bag and player radii for a click pickup, so it is not pixel-precise. */
  pickupReach: 50,
  /** Extra server-side reach: two input frames of walking, for a request that overtakes its inputs. */
  pickupLagSlack: 20,
  corruptChance: 0.08,
  /** Share of sigil drops that come inscribed with a starter sigil's runes; the rest are blank. */
  sigilSpellShare: 0.3,
  corruptMisfireMultiplier: 1.5,
  inventorySize: 20,
} as const;

export const SPIRIT = {
  vesselBaseByTier: { common: 15, magic: 20, rare: 25, relic: 30 },
  vesselPerAffix: 5,
} as const;

/**
 * The Hound pack: one vessel binds a Leader and 1 to 6 packmates for one vessel's spirit.
 *
 * Packmate strength: each packmate has `mateShare / sqrt(n)` of the Leader's base life and damage
 * (n packmates), so the packmates together are worth 0.55 of a hound with one (0.55), 0.78 with
 * two, 1.1 with four and 1.35 with six. The whole pack is 1.55 to 2.35 hounds' worth rather than
 * up to 7: a relic pack is clearly the better find but pays for its bodies with fragile ones, and
 * area damage hits every dog in it.
 */
export const HOUND_PACK = {
  /** Every dog of every pack counts, Leaders included; packmates are trimmed to fit, in warband order. */
  maxDogs: 12,
  packmatesByTier: { common: { min: 1, max: 2 }, magic: { min: 1, max: 3 }, rare: { min: 2, max: 4 }, relic: { min: 3, max: 6 } },
  leader: { lifeMult: 1.35, damageMult: 1.15, radiusScale: 1.25 },
  mate: { share: 0.55, radiusScale: 0.78, speedMult: 1.15, attackSpeedMult: 1.15 },
  /** Without its Leader the pack keeps fighting, softer and without the howl. */
  leaderlessDamageMult: 0.7,
  /** The Leader howls while fighting; the whole pack runs and bites harder for a while. */
  howl: { cooldown: 14, seconds: 6, speedBonus: 0.25, damageBonus: 0.2, radius: 140 },
  /** Enemies under the Leader's landing pounce are held in place (not bosses or knockback-immune ones). */
  pinSeconds: 1,
  /** Packmates circle the target at these angles from the Leader's side, so they flank it. */
  flankAngles: [1.25, -1.25, 2.2, -2.2, Math.PI, 0.6],
} as const;

export const MINIONS = {
  /** On top of each minion's own numbers: they died too fast and hit too softly to be worth their spirit. */
  damageMultiplier: 1.5,
  lifeMultiplier: 1.4,
  /**
   * Spirit is the real limit on how many minions a Binder keeps; this is only a ceiling far above
   * what any build can pay for, so saves and the protocol keep a fixed size.
   */
  warbandSlots: 24,
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

/**
 * World streaming, step 1: monsters far from every player sleep (see docs/features/world-streaming.md).
 * A chunk is awake when a player or minion is within `awakeChunks * chunkSize` of it, so a sleeping
 * monster is always at least 2000 units from every player: 900 beyond the interest radius, which
 * covers anything a player can travel between two recomputes.
 */
export const STREAMING = {
  chunkSize: 1000,
  awakeChunks: 2,
  /** 4 Hz: a player at 220 units per second covers 55 units between recomputes. */
  recomputeEveryTicks: 5,
  /** A player or minion that moved this far since the last recompute (a portal, a teleport) forces one at once. */
  jumpDistance: 250,
  /**
   * Defaults of the admin settings for respawn by inactivity: a chunk's packs (and chests) refill once
   * nobody has been in its wake range this long, its bosses after the longer time.
   */
  respawnMinutes: 10,
  bossRespawnMinutes: 20,
  /** A refill held up by a monster of the chunk standing near someone tries again this often. */
  respawnRetryTicks: 200,
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
  /**
   * A monster that broke its leash walks home and cannot take a target for this long, so it cannot
   * turn back at the leash edge for a target standing just beyond it and hover there. After this
   * long a target in sight within aggroRadius, or a hit, turns it round again.
   */
  leashReturnSeconds: 3,
  packSpread: 110,
  /** Empty instances are closed after this long. */
  idleCloseSeconds: 300,
} as const;

/** Mummy curse: refreshed every tick a player stands in the aura, fades shortly after leaving it. */
export const CURSE = {
  damageReduction: 0.3,
  lingerSeconds: 0.6,
} as const;

export const PROGRESSION = {
  maxLevel: 50,
  /** XP from level L to L+1 is xpBase * L^xpExponent: 90 for the first level, ~7.1k at 10, ~99k at 40. Slowed from 60 * L^1.75 so level requirements on gear gate longer. */
  xpBase: 90,
  xpExponent: 1.9,
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

/**
 * The seamless world (`world/worldPlan.ts`): one map per world copy with the town in the middle.
 * 13000 square is 9 times a zone of before (5200 by 3600), which the streaming numbers carry with room
 * to spare (world-streaming.md, step 4).
 */
export const WORLD = {
  width: 13000,
  height: 13000,
  /** The home region around the town; the roads leave it into their own regions. */
  hubRadius: 2400,
  /** Roads and branches keep this far inside the map edge. */
  edgeMargin: 650,
  trunkStep: 450,
  branchStep: 420,
  /** Half the angle of each road's sector, and how far inside its edges branches stay. */
  sectorHalf: Math.PI / 3,
  sectorInset: 0.11,
  /** Unrelated roads stay this far apart, so branches read as separate valleys. */
  roadGap: 760,
  /** Monster levels from the town gate to the farthest branch end, on a curve that starts slow. */
  levels: [1, 25] as readonly [number, number],
  levelCurve: 1.3,
  /** Off-road distance counts this much toward a spot's distance from town. */
  offRoad: 0.6,
  /** Road half widths: the trunk out of each gate, and the branches. */
  trunkWidth: 52,
  branchWidth: 40,
} as const;

/** Gate bosses: each road's pass past its first region, sealed per character until its boss falls. */
export const GATES = {
  /** It spawns once a living player comes this close to its gate, so an empty road holds none. */
  spawnRange: 2400,
  /** Above the ground round the gate, so it is the hardest fight of the road so far. */
  levelBonus: 2,
  /** Where it stands: this far back along the road from the gate, on the side everyone can reach. */
  standBack: 170,
  /**
   * Where the server puts someone a placement would leave behind a gate sealed to them: this far back
   * along the road from the gate, a trunk step and a bit, so they land on the town side clear of the
   * boss standing 170 back rather than on top of it.
   */
  returnBack: 520,
  /** Longest a due gate boss waits for the players it is sealed to to look away before it returns anyway. */
  maxRespawnDelaySeconds: 120,
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
  /**
   * Below this level spread shots fire one projectile and rares cannot roll Multishot: a fan of
   * bullets from the first monsters a new character meets felt unfair and like a later-game threat.
   */
  multishotFromLevel: 5,
} as const;

export const GROUND = {
  /** Roads and paths: walking on them is this much faster, for players, minions and monsters alike. */
  roadSpeedBonus: 0.1,
} as const;
