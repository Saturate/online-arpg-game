import type { AffixId } from '../data/affixes.js';
import type { ClassId } from '../data/classes.js';
import type { ZoneId } from '../data/zones.js';
import type { EnemyTypeId } from '../data/enemies.js';
import type { MinionTypeId, Stance } from '../data/minions.js';
import type { ElementId, RuneId } from '../data/runes.js';
import type { Item, ItemTier, ItemUid } from '../items/items.js';
import type { DudReason } from '../runes/compiler.js';
import type { EntityId, Team } from '../sim/ecs.js';
import type { DashState } from '../sim/movement.js';
import type { PlayerStats } from '../sim/stats.js';
import type { GearSlot } from '../data/gear.js';
import type { DevCommand } from '../sim/dev.js';
import type { TownLayout } from '../world/town.js';
import type { MapDescriptor } from '../world/types.js';

export const BUTTON = {
  primary: 1 << 0,
  skill1: 1 << 1,
  skill2: 1 << 2,
  skill3: 1 << 3,
  skill4: 1 << 4,
} as const;

export const BUTTON_MASK = 0b11111;
export const SKILL_BUTTONS = [BUTTON.skill1, BUTTON.skill2, BUTTON.skill3, BUTTON.skill4] as const;

export interface InputFrame {
  seq: number;
  moveDir: { x: number; y: number };
  aimAngle: number;
  buttons: number;
}

export type GameMode = 'world' | 'arena';

export type ClientMessage =
  /** Enter the world as one of the account's characters. The token comes from the HTTP login. */
  | { t: 'join'; token: string; characterId: number; mode: GameMode }
  | { t: 'pause'; paused: boolean }
  /** Leave the current room for town, like a D2 town portal. */
  | { t: 'townPortal' }
  /** Invite an online player (by character name) to your party; creates the party if needed. */
  | { t: 'partyInvite'; name: string }
  | { t: 'partyAnswer'; accept: boolean }
  | { t: 'partyLeave' }
  /** Go to the party's own world (the leader takes everyone online along), or back to the public one. */
  | { t: 'partyWorld' }
  | { t: 'publicWorld' }
  /** Chat to your game, or a command such as `/w name message`. */
  | { t: 'chat'; text: string }
  /** Travel from the waypoint the player stands on to another unlocked one. */
  | { t: 'useWaypoint'; zone: ZoneId }
  | ({ t: 'input' } & InputFrame)
  | { t: 'ping'; clientTime: number }
  | { t: 'inscribe'; uid: ItemUid; runes: RuneId[] }
  | { t: 'equipSigil'; uid: ItemUid; slot: number }
  | { t: 'unequipSigil'; slot: number }
  | { t: 'equipVessel'; uid: ItemUid; slot: number }
  | { t: 'unequipVessel'; slot: number }
  | { t: 'discard'; uid: ItemUid }
  | { t: 'sortInventory' }
  | { t: 'cycleStance' }
  /** Dungeon antechamber ready check. */
  | { t: 'ready'; ready: boolean }
  /** `slot` picks a ring slot when dragging onto one; null lets the server choose. */
  | { t: 'equipGear'; uid: ItemUid; slot: GearSlot | null }
  | { t: 'unequipGear'; slot: GearSlot }
  /** Town editor: replace the town layout. Only honoured when the server enables the editor. */
  | { t: 'saveTown'; layout: TownLayout }
  /** Encounter sandbox. Only honoured for roles with the devTools permission (builder and up). */
  | { t: 'dev'; cmd: DevCommand };

/** Status flags packed into one number per entity. */
export const STATUS = {
  burn: 1,
  chill: 2,
  shock: 4,
  shield: 8,
  burningShield: 16,
  /** Burrowed monster: drawn as a moving mound, not targetable. */
  hidden: 32,
  /** Boss in its second phase. */
  enraged: 64,
  /** Player under a mummy's curse: deals less damage. */
  cursed: 128,
} as const;

/** What a spell area does, for picking its colour. */
export type SpellFx = 'damage' | 'heal' | 'ward' | 'mixed';

export interface AuraSnap {
  r: number;
  fx: SpellFx;
  el: ElementId | null;
}

interface EntitySnapBase {
  id: EntityId;
  x: number;
  y: number;
  r: number;
}

export type EntitySnap =
  | (EntitySnapBase & {
      k: 'player';
      cls: ClassId;
      name: string;
      a: number;
      life: number;
      maxLife: number;
      dead: boolean;
      dashing: boolean;
      st: number;
      auras: AuraSnap[];
      links: EntityId[];
    })
  | (EntitySnapBase & {
      k: 'enemy';
      et: EnemyTypeId;
      rare: boolean;
      /** Idle pack member that has not noticed anyone yet. */
      dormant: boolean;
      boss: boolean;
      lvl: number;
      /** Affix ids, for the target frame. Empty for normal monsters, so they cost nothing extra. */
      ax: AffixId[];
      life: number;
      maxLife: number;
      st: number;
      a: number;
    })
  | (EntitySnapBase & {
      k: 'minion';
      mt: MinionTypeId;
      owner: EntityId;
      life: number;
      maxLife: number;
      st: number;
      a: number;
    })
  | (EntitySnapBase & { k: 'projectile'; team: Team; owner: EntityId; el: ElementId | null; fx: SpellFx })
  | (EntitySnapBase & { k: 'swing'; a: number; arc: number; owner: EntityId })
  | (EntitySnapBase & { k: 'nova'; maxR: number; el: ElementId | null; fx: SpellFx })
  | (EntitySnapBase & { k: 'zone'; el: ElementId | null; fx: SpellFx; left: number })
  | (EntitySnapBase & { k: 'loot'; tier: ItemTier; count: number; names: { n: string; tier: ItemTier }[] });

export type GameEvent =
  | { e: 'dmg'; id: EntityId; amt: number; x: number; y: number; el: ElementId | null }
  | { e: 'heal'; id: EntityId; amt: number; x: number; y: number }
  | { e: 'death'; id: EntityId; x: number; y: number; k: 'enemy' | 'player' | 'minion'; color: number; big: boolean }
  | { e: 'fizzle'; id: EntityId; x: number; y: number; why: 'dud' | 'misfire'; reason: DudReason | null }
  | { e: 'explode'; x: number; y: number; r: number }
  | { e: 'pickup'; id: EntityId; x: number; y: number; count: number }
  | { e: 'cast'; id: EntityId; x: number; y: number; el: ElementId | null }
  /** Any melee swing or shot, so clients can play the attack animation. */
  | { e: 'attack'; id: EntityId }
  /** A character touched a waypoint for the first time. */
  | { e: 'waypoint'; id: EntityId; zone: ZoneId }
  | { e: 'levelUp'; id: EntityId; level: number; x: number; y: number }
  /**
   * A monster winding up an attack: where it will land and when. Circles are areas, lines are
   * charges and aimed shots. Sent once; the client draws it for `t` seconds or until `id` dies.
   */
  | { e: 'tele'; id: EntityId; shape: 'circle'; x: number; y: number; r: number; t: number; el: ElementId | null }
  | { e: 'tele'; id: EntityId; shape: 'line'; x: number; y: number; x2: number; y2: number; w: number; t: number; el: ElementId | null }
  /** A corpse at (x, y) was raised, so clients remove the body there. */
  | { e: 'raise'; x: number; y: number }
  /** A damaging ground puddle that lasts `t` seconds. */
  | { e: 'hazard'; x: number; y: number; r: number; t: number; kind: 'poison' | 'fire' | 'frost' };

export interface SelfState {
  respawnIn: number | null;
  primaryCooldown: number;
  castCooldown: number;
  heat: number;
  heatMax: number;
  /** Effective speed with gear; the client predicts with it so gear never causes corrections. */
  moveSpeed: number;
  stats: PlayerStats;
  spiritMax: number;
  spiritReserved: number;
  dash: DashState | null;
  stance: Stance;
  minionRespawn: number[];
  links: ({ targetId: EntityId | null; connected: boolean } | null)[];
  level: number;
  xp: number;
  xpNext: number;
}

export interface Snapshot {
  t: 'snapshot';
  tick: number;
  lastProcessedInputSeq: number;
  self: SelfState | null;
  entities: EntitySnap[];
  events: GameEvent[];
  /** Total entities in the room, for the debug overlay; differs from entities.length with interest management. */
  roomEntityCount: number;
  wave: number;
  players: { id: EntityId; name: string; cls: ClassId; level: number; life: number; maxLife: number; dead: boolean }[];
  /** The room is frozen: only possible when a player is alone in a non-shared room. */
  paused: boolean;
}

/** The copy of the world the player is in: a shared public one, or their party's own. */
export interface WorldInfo {
  kind: 'public' | 'party';
  name: string;
  players: number;
  capacity: number;
}

export interface PartyInfo {
  leader: string;
  members: { name: string; online: boolean }[];
  /** The party has its own world running (someone is in it). */
  hasWorld: boolean;
}

export interface InventoryMessage {
  t: 'inventory';
  items: Item[];
  inventory: (ItemUid | null)[];
  sigils: (ItemUid | null)[];
  warband: (ItemUid | null)[];
  gear: Record<GearSlot, ItemUid | null>;
}

/** Antechamber state, sent to everyone inside it whenever it changes. */
export interface StagingMessage {
  t: 'staging';
  members: { name: string; cls: ClassId; ready: boolean }[];
  /** Seconds until the party is sent in, or null when not everyone is ready. */
  countdown: number | null;
  /** A run is live: the gate lets latecomers straight in. */
  open: boolean;
  inside: number;
  level: number;
  /** The current or last run's boss is dead. */
  cleared: boolean;
}

export type ServerMessage =
  | {
      t: 'welcome';
      playerId: EntityId;
      tick: number;
      tickMs: number;
      roomId: string;
      map: MapDescriptor;
      canPause: boolean;
      editor: boolean;
      townEditor: boolean;
      devTools: boolean;
      /** Server build; a client from another build reloads itself. 'dev' disables the check. */
      build: string;
    }
  | { t: 'world'; world: WorldInfo }
  | { t: 'party'; party: PartyInfo | null }
  | { t: 'partyInvite'; from: string }
  /** `game` reaches everyone in your world; `party` your party anywhere; `whisper` one player; `system` is the server. */
  | { t: 'chat'; kind: 'game' | 'party' | 'whisper' | 'system'; from: string; to: string | null; text: string }
  /** Opens the waypoint menu: the zone of the waypoint underfoot and every one this character has found. */
  | { t: 'waypoints'; current: ZoneId; unlocked: ZoneId[] }
  | StagingMessage
  | Snapshot
  | InventoryMessage
  | { t: 'notice'; text: string }
  /** A big centre-screen announcement, like a cleared dungeon. */
  | { t: 'banner'; title: string; text: string }
  /** The server refused or ended the session; the socket closes right after. */
  | { t: 'sessionEnded'; reason: string }
  | { t: 'pong'; clientTime: number };
