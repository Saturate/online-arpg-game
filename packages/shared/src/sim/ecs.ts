import type { ZoneId } from '../data/zones.js';
import type { BehaviourAffixId } from '../data/affixes.js';
import type { ClassId } from '../data/classes.js';
import type { EnemyTypeId } from '../data/enemies.js';
import type { MinionTypeId, Stance } from '../data/minions.js';
import type { ElementId } from '../data/runes.js';
import type { AffixRoll, Item, ItemUid } from '../items/items.js';
import type { CompileResult, SpellNode } from '../runes/compiler.js';
import type { GearSlot } from '../data/gear.js';
import type { DashState } from './movement.js';
import type { PlayerStats } from './stats.js';

export type EntityId = number;
export type Team = 'players' | 'enemies';
export type EntityKind = 'player' | 'enemy' | 'minion' | 'projectile' | 'swing' | 'nova' | 'zone' | 'loot';

export interface Position {
  x: number;
  y: number;
}

export interface Velocity {
  x: number;
  y: number;
}

export interface Health {
  life: number;
  maxLife: number;
}

/** A live spell instance: which node of the program it is, who cast it, and trigger bookkeeping. */
export interface SpellInst {
  node: SpellNode;
  casterId: EntityId;
  age: number;
  timerFired: boolean;
  angle: number;
  pulseTimer: number;
  pulseCount: number;
}

export interface LinkState {
  targetId: EntityId | null;
  connected: boolean;
}

export interface EquippedSigil {
  uid: ItemUid;
  compiled: CompileResult;
  misfireMultiplier: number;
}

export interface PlayerComp {
  clientId: string;
  name: string;
  classId: ClassId;
  aimAngle: number;
  primaryCooldown: number;
  castCooldown: number;
  respawnIn: number | null;
  lastProcessedInputSeq: number;
  prevButtons: number;
  heat: number;
  heatPause: number;
  dash: DashState | null;
  /** Server-only data for the dash spell in flight; the movement part lives in `dash`. */
  dashSpell: { inst: SpellInst; hitIds: Set<EntityId>; hitFired: boolean } | null;
  items: Map<ItemUid, Item>;
  /** Bag grid (BAG), one entry per cell; see items/grid.ts. */
  inventory: (ItemUid | null)[];
  /** The account's shared stash grid (STASH), loaded with the character and saved per account. */
  stash: (ItemUid | null)[];
  sigils: (EquippedSigil | null)[];
  warband: (ItemUid | null)[];
  gear: Record<GearSlot, ItemUid | null>;
  /** Recomputed whenever equipment changes; see `sim/stats.ts`. */
  stats: PlayerStats;
  minions: (EntityId | null)[];
  minionRespawn: number[];
  stance: Stance;
  links: (LinkState | null)[];
  /** Bumped whenever items or equipment change, so the server knows to resend the inventory. */
  inventoryVersion: number;
  /** Seconds before portals react to this player again, so arriving next to one does not bounce them back. */
  portalCooldown: number;
  /** Recent positions, newest last. Minions without line of sight walk back along it. */
  trail: { x: number; y: number }[];
  /** Direction the player last moved, for minion formation. */
  heading: number;
  /** The enemy this player most recently damaged, and when; minions focus it. */
  focusTarget: EntityId | null;
  focusTick: number;
  /** Dev tools: takes no damage. */
  god: boolean;
  /** Zones whose waypoint this character has touched; the waypoint menu offers these. */
  waypoints: ZoneId[];
  level: number;
  /** Progress into the current level, not lifetime total. */
  xp: number;
  gold: number;
}

export interface EnemyComp {
  typeId: EnemyTypeId;
  rare: boolean;
  boss: boolean;
  level: number;
  damageMult: number;
  /** Pack enemies idle at home until a target comes close or they are hit. */
  aggro: boolean;
  homeX: number;
  homeY: number;
  affixes: AffixRoll[];
  contactCooldown: number;
  fireCooldown: number;
  patternAngle: number;
  facing: number;
  speedMult: number;
  extraProjectiles: number;
  reflectChance: number;
  /** Percent of max life regenerated per second. */
  regenPercent: number;
  tauntTarget: EntityId | null;
  tauntTimer: number;
  knockX: number;
  knockY: number;
  // Generic monster AI (sim/enemies.ts). The three original behaviours leave these at rest.
  /** Seconds until each ability in the definition is ready again. */
  cooldowns: number[];
  cast: EnemyCast | null;
  dash: { vx: number; vy: number; t: number; damage: number; width: number; hitIds: Set<EntityId> } | null;
  leap: { fromX: number; fromY: number; toX: number; toY: number; t: number; duration: number; radius: number; damage: number } | null;
  /** Underground: invisible and untouchable. */
  burrowed: boolean;
  /** Seconds spent above ground since the last dive. */
  burrowTimer: number;
  /** The monster that summoned this one, for summon caps. */
  summonerId: EntityId | null;
  enraged: boolean;
  /** Already raised once by a shaman; raised monsters stay dead the second time. */
  raised: boolean;
  /** Killed by its own suicide blast, so the death burst does not fire on top. */
  detonated: boolean;
}

/** An ability winding up. Aim and target points lock at the start, which is what makes it dodgeable. */
export interface EnemyCast {
  index: number;
  t: number;
  x: number;
  y: number;
  angle: number;
  points: { x: number; y: number }[];
}

export type MinionState = 'follow' | 'engage' | 'retreat';

export interface MinionComp {
  ownerId: EntityId;
  slot: number;
  typeId: MinionTypeId;
  affixes: AffixRoll[];
  behaviour: BehaviourAffixId | null;
  state: MinionState;
  targetId: EntityId | null;
  attackCooldown: number;
  attackCooldownBase: number;
  damage: number;
  moveSpeed: number;
  tauntTimer: number;
  /** Ticks the current target has been out of sight; the minion gives up after a while. */
  lostSightTicks: number;
}

export interface ProjectileComp {
  ownerId: EntityId;
  damage: number;
  elements: ElementId[];
  lifetime: number;
  pierceLeft: number;
  hitIds: Set<EntityId>;
  knockback: number;
  heal: number;
  shield: number;
  offensive: boolean;
  spell: SpellInst | null;
}

/** Short-lived visual marker for a melee swing; the hit itself resolves on the tick it is created. */
export interface SwingComp {
  ownerId: EntityId;
  angle: number;
  arc: number;
  range: number;
  lifetime: number;
}

export interface NovaComp {
  spell: SpellInst;
  maxRadius: number;
  duration: number;
  hitIds: Set<EntityId>;
}

export interface ZoneComp {
  spell: SpellInst;
  duration: number;
  tickInterval: number;
  tickTimer: number;
}

export interface LootComp {
  items: Item[];
  /** Gold on the ground; picked up by walking over it, unlike items which need a click. */
  gold: number;
  lifetime: number;
  /** A dropped item is not picked back up by the same player until they walk away. */
  ignoreFor: EntityId | null;
}

export interface StatusComp {
  burn: { dps: number; t: number; sourceId: EntityId } | null;
  chill: number;
  shock: number;
  shield: { amount: number; t: number; burning: boolean } | null;
  /** Seconds left on a mummy's curse; a cursed player deals less damage. */
  curse: number;
}

/** Recomputed every tick from auras and links. */
export interface BuffComp {
  damageReduction: number;
  regenPerSecond: number;
  elementDamageBonus: number;
}

/** A typed component store. Registered with its World so entity destruction clears it automatically. */
export class ComponentStore<T> extends Map<EntityId, T> {
  constructor(readonly name: string) {
    super();
  }
}

interface Clearable {
  delete(id: EntityId): boolean;
}

export class World {
  private nextId: EntityId = 1;
  private pendingDestroy = new Set<EntityId>();
  private readonly stores: Clearable[] = [];

  readonly kind = this.define<EntityKind>('kind');
  readonly position = this.define<Position>('position');
  readonly velocity = this.define<Velocity>('velocity');
  readonly radius = this.define<number>('radius');
  readonly health = this.define<Health>('health');
  readonly team = this.define<Team>('team');
  readonly status = this.define<StatusComp>('status');
  readonly buffs = this.define<BuffComp>('buffs');
  readonly player = this.define<PlayerComp>('player');
  readonly enemy = this.define<EnemyComp>('enemy');
  readonly minion = this.define<MinionComp>('minion');
  readonly projectile = this.define<ProjectileComp>('projectile');
  readonly swing = this.define<SwingComp>('swing');
  readonly nova = this.define<NovaComp>('nova');
  readonly zone = this.define<ZoneComp>('zone');
  readonly loot = this.define<LootComp>('loot');

  /** New component types are added here; nothing else needs to know about them. */
  private define<T>(name: string): ComponentStore<T> {
    const store = new ComponentStore<T>(name);
    this.stores.push(store);
    return store;
  }

  create(kind: EntityKind): EntityId {
    const id = this.nextId++;
    this.kind.set(id, kind);
    return id;
  }

  /** Deferred so systems can destroy while iterating. */
  destroy(id: EntityId): void {
    this.pendingDestroy.add(id);
  }

  isAlive(id: EntityId): boolean {
    return this.kind.has(id) && !this.pendingDestroy.has(id);
  }

  flushDestroyed(): void {
    for (const id of this.pendingDestroy) for (const store of this.stores) store.delete(id);
    this.pendingDestroy.clear();
  }

  get entityCount(): number {
    return this.kind.size;
  }

  /**
   * Iterates live entities that have every listed component, driven by the first store, so pass
   * the rarest component first.
   */
  query<A>(a: ComponentStore<A>): Generator<[EntityId, A]>;
  query<A, B>(a: ComponentStore<A>, b: ComponentStore<B>): Generator<[EntityId, A, B]>;
  query<A, B, C>(a: ComponentStore<A>, b: ComponentStore<B>, c: ComponentStore<C>): Generator<[EntityId, A, B, C]>;
  *query(...stores: ComponentStore<unknown>[]): Generator<[EntityId, ...unknown[]]> {
    const [first, ...rest] = stores;
    if (!first) return;
    for (const [id, value] of first) {
      if (this.pendingDestroy.has(id)) continue;
      const row: unknown[] = [value];
      let complete = true;
      for (const store of rest) {
        const v = store.get(id);
        if (v === undefined) {
          complete = false;
          break;
        }
        row.push(v);
      }
      if (complete) yield [id, ...row];
    }
  }
}

export function emptyStatus(): StatusComp {
  return { burn: null, chill: 0, shock: 0, shield: null, curse: 0 };
}

export function emptyBuffs(): BuffComp {
  return { damageReduction: 0, regenPerSecond: 0, elementDamageBonus: 0 };
}
