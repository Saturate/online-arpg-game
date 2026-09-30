import type { Lighting } from './accounts.js';
import type { ArenaResult, ArenaStatus } from './arena.js';
import type { AffixId } from '../data/affixes.js';
import type { ClassId } from '../data/classes.js';
import type { ZoneId } from '../data/zones.js';
import type { EnemyTypeId } from '../data/enemies.js';
import type { MinionTypeId, Stance } from '../data/minions.js';
import type { ElementId } from '../sim/program.js';
import type { RuneId } from '../runes/v2/runes.js';
import type { RuleId } from '../runes/v2/rules.js';
import type { Item, ItemTier, ItemUid } from '../items/items.js';
import type { EntityId, Team } from '../sim/ecs.js';
import type { DashState } from '../sim/movement.js';
import type { PlayerStats } from '../sim/stats.js';
import type { GearSlot } from '../data/gear.js';
import type { DevCommand } from '../sim/dev.js';
import type { TownLayout } from '../world/town.js';
import type { MapDescriptor } from '../world/types.js';
import type { ModelOverrides } from '../data/tuning.js';
import type { StashColorId } from '../config/stash.js';
import type { StashLayout, StashSortKey, StashTabRef } from '../items/stash.js';

/**
 * One slot of a sigil in an inscribe request, left to right.
 * - `keep`: the rune now in slot `index` of this sigil, maybe moved; free, each index at most once.
 * - `plain`: one plain rune of that id, from the bag first (bound stacks first), then the stash.
 * - `rolled`: that rolled rune item, from the bag or the stash; each uid at most once.
 * Every current slot not kept is refunded to the bag, else pending.
 */
export type RuneRef = { from: 'keep'; index: number } | { from: 'plain'; rune: RuneId } | { from: 'rolled'; uid: ItemUid };

/** A cell of the bag or of a general stash tab, for an item's top-left corner. */
export type GridDest = { at: 'bag'; x: number; y: number } | { at: 'tab'; tab: number; x: number; y: number };

/** Where a moved item goes: a cell, or the rune or sigil tab (which place it themselves). */
export type ItemDest = GridDest | { at: 'runes' } | { at: 'sigils' };

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

export type ClientMessage =
  /** Enter the world as one of the account's characters. The token comes from the HTTP login. */
  | { t: 'join'; token: string; characterId: number }
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
  /** Start the channel that takes you to a party member (by character name); the server checks everything. */
  | { t: 'partyTeleport'; name: string }
  | ({ t: 'input' } & InputFrame)
  | { t: 'ping'; clientTime: number }
  /**
   * `base`: the uids of the sigil's slots the draft was made from. `keep` indices only mean what the
   * player saw while the sigil still holds exactly these, so the server refuses a save made against
   * an older sigil. `attempt` is echoed in the reply, so the client can ignore answers to older tries.
   */
  | { t: 'inscribe'; uid: ItemUid; base: ItemUid[]; slots: RuneRef[]; attempt: number }
  | { t: 'equipSigil'; uid: ItemUid; slot: number }
  | { t: 'unequipSigil'; slot: number }
  /** Reorders the skill bar: the skills in slots a and b trade places. */
  | { t: 'swapSigils'; a: number; b: number }
  | { t: 'equipVessel'; uid: ItemUid; slot: number }
  | { t: 'unequipVessel'; slot: number }
  | { t: 'discard'; uid: ItemUid }
  /** Pick up the items in a ground bag; the server checks reach and bag room. */
  | { t: 'pickup'; id: EntityId }
  /** Standing at the trader: send the shared stock. */
  | { t: 'traderList' }
  | { t: 'sell'; uid: ItemUid }
  | { t: 'buy'; id: number }
  /** Move a bag or stash item: to a cell of the bag or a general tab, or into the rune or sigil tab. */
  | { t: 'moveItem'; uid: ItemUid; to: ItemDest }
  /**
   * Ctrl+click at the stash. From the bag the item goes to the tab that takes it (runes to the rune
   * tab, sigils to the sigil tab, the rest to general tab `tab` if it has room, else the first that
   * does); from the stash it goes to the bag.
   */
  | { t: 'quickMove'; uid: ItemUid; tab: number | null }
  /** Take `count` runes off a plain stack in the stash: to a cell, or null for anywhere in the bag. */
  | { t: 'takeRunes'; uid: ItemUid; count: number; to: GridDest | null }
  /**
   * General tabs pack in bag sort order (key null); the rune and sigil tabs sort their lists by
   * `key`. `affix` names the rune affix when the rune tab sorts by 'affix', and is null otherwise.
   */
  | { t: 'sortStash'; tab: StashTabRef; key: StashSortKey | null; affix: AffixId | null }
  /** Buy the next general tab with this character's gold. */
  | { t: 'buyStashTab' }
  | { t: 'editStashTab'; tab: number; name: string; color: StashColorId }
  | { t: 'sortInventory' }
  | { t: 'cycleStance' }
  /** Antechamber ready check (a dungeon's or the Arena gate). */
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
  /** Poisoned by a bite: stacking damage over time. */
  poison: 256,
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
      /** A Hound pack dog's role; the Leader is drawn bigger and darker, packmates smaller. */
      pack?: 'leader' | 'mate';
      life: number;
      maxLife: number;
      st: number;
      a: number;
    })
  | (EntitySnapBase & {
      k: 'projectile';
      team: Team;
      owner: EntityId;
      el: ElementId | null;
      fx: SpellFx;
      /** An Orb rune's projectile, drawn as a slow rolling orb rather than a bolt. Absent otherwise. */
      orb?: true;
    })
  | (EntitySnapBase & { k: 'nova'; maxR: number; el: ElementId | null; fx: SpellFx })
  | (EntitySnapBase & { k: 'zone'; el: ElementId | null; fx: SpellFx; left: number })
  | (EntitySnapBase & { k: 'loot'; tier: ItemTier; count: number; names: { n: string; tier: ItemTier; u?: true }[]; gold: number });

/**
 * A spell entity as sent once, when it becomes visible or its motion changes: enough for the client
 * to move a projectile, grow a nova or fade a zone by itself until it is listed as gone.
 */
export type SpellSnap =
  | (Extract<EntitySnap, { k: 'projectile' }> & { vx: number; vy: number })
  | (Extract<EntitySnap, { k: 'nova' }> & { age: number; dur: number })
  | (Extract<EntitySnap, { k: 'zone' }> & { age: number; dur: number });

export type GameEvent =
  | { e: 'dmg'; id: EntityId; amt: number; x: number; y: number; el: ElementId | null }
  | { e: 'heal'; id: EntityId; amt: number; x: number; y: number }
  | { e: 'death'; id: EntityId; x: number; y: number; k: 'enemy' | 'player' | 'minion'; color: number; big: boolean }
  | { e: 'fizzle'; id: EntityId; x: number; y: number; why: 'dud' | 'misfire'; reason: RuleId | null }
  | { e: 'explode'; x: number; y: number; r: number }
  | { e: 'pickup'; id: EntityId; x: number; y: number; count: number; gold?: number }
  | { e: 'cast'; id: EntityId; x: number; y: number; el: ElementId | null }
  /** A monster or minion attacking, so clients can play the attack animation. */
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
  | { e: 'hazard'; x: number; y: number; r: number; t: number; kind: 'poison' | 'fire' | 'frost' }
  /** A Hound pack Leader howled: its pack runs and bites harder for a while. */
  | { e: 'howl'; id: EntityId; x: number; y: number; r: number }
  /** A Hound pack Leader landed its pounce: enemies within `r` are bitten and pinned. */
  | { e: 'pounce'; id: EntityId; x: number; y: number; r: number };

export interface SelfState {
  respawnIn: number | null;
  castCooldown: number;
  /** Full length of the cooldown the last cast set, for sweeping every skill slot against it. */
  castCooldownFull: number;
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
  /** Everything but spell entities, in full every tick. */
  entities: EntitySnap[];
  /** Spell entities that are new to this client or changed their motion since last sent. */
  spells: SpellSnap[];
  /** Spell entities this client knew that ended or left its view. */
  gone: EntityId[];
  events: GameEvent[];
  /** Total entities in the room, for the debug overlay; differs from entities.length with interest management. */
  roomEntityCount: number;
  wave: number;
  players: { id: EntityId; name: string; cls: ClassId; level: number; life: number; maxLife: number; dead: boolean }[];
  /** The room is frozen: only possible when a player is alone in a non-shared room. */
  paused: boolean;
  /** A dungeon's boss is dead, so its sealed exit is open; absent until then and everywhere else. */
  exitOpen?: true;
}

/** The copy of the world the player is in: a shared public one, or their party's own. */
export interface WorldInfo {
  kind: 'public' | 'party';
  name: string;
  players: number;
  capacity: number;
}

export interface TraderEntry {
  id: number;
  item: Item;
  price: number;
}

export interface PartyInfo {
  leader: string;
  members: { name: string; online: boolean }[];
  /** The party has its own world running (someone is in it). */
  hasWorld: boolean;
}

/** What kind of place a party member is in, for the party frames. */
export type PartyPlace = 'town' | 'wilds' | 'dungeon' | 'arena' | 'sandbox' | 'offline';

/** One other party member, as the party frames show them. */
export interface PartyMemberStatus {
  name: string;
  /** Null for an offline member the server has not seen since it started. */
  cls: ClassId | null;
  level: number;
  life: number;
  maxLife: number;
  dead: boolean;
  place: PartyPlace;
  /** The room's name, empty when offline. */
  zone: string;
  /** Map position, only when the member is in the receiver's room, for the minimap. */
  x?: number;
  y?: number;
  /** Why a teleport to this member would be refused right now; absent when it would go. */
  no?: string;
}

/** About once a second to each online party member: everyone else in the party, wherever they are. */
export interface PartyStatusMessage {
  t: 'partyStatus';
  members: PartyMemberStatus[];
}

/** The teleport channel started (`to` a member, for `seconds`), or ended: `reason` says why it broke, null when it went through. */
export type TeleportChannelMessage = { t: 'teleportChannel'; to: string; seconds: number } | { t: 'teleportChannel'; to: null; reason: string | null };

export interface InventoryMessage {
  t: 'inventory';
  items: Item[];
  /** Bag grid cells (BAG); see items/grid.ts. */
  inventory: (ItemUid | null)[];
  /** The account stash: general tabs, the rune tab's counts and rolled runes, the sigil list. */
  stash: StashLayout;
  /** Gold for the next general tab, or null once the account owns every one. */
  stashTabPrice: number | null;
  gold: number;
  sigils: (ItemUid | null)[];
  warband: (ItemUid | null)[];
  gear: Record<GearSlot, ItemUid | null>;
}

/** Antechamber state, sent to everyone inside it whenever it changes. */
export interface StagingMessage {
  t: 'staging';
  /** A dungeon's antechamber, or the Arena gate. */
  kind: 'dungeon' | 'arena';
  members: { name: string; cls: ClassId; ready: boolean }[];
  /** Seconds until the party is sent in, or null when not everyone is ready. */
  countdown: number | null;
  /** A dungeon run is live: the gate lets latecomers straight in. Arena runs never take latecomers. */
  open: boolean;
  /** Players in the live dungeon run, or in every Arena run started from this gate. */
  inside: number;
  /** The dungeon's monster level, or the level the Arena's first wave would be for this party. */
  level: number;
  /** The current or last run's boss is dead. */
  cleared: boolean;
}

/**
 * The answer to one inscribe, so the forge can tell its own refusal from any other notice. An
 * accepted one is sent after the inventory that shows the new sigil, so the forge never frees its
 * button while the old slots are still on screen.
 */
export type InscribeReply = { t: 'inscribed'; uid: ItemUid; attempt: number; ok: true } | { t: 'inscribed'; uid: ItemUid; attempt: number; ok: false; error: string };

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
  | PartyStatusMessage
  | TeleportChannelMessage
  | { t: 'lighting'; lighting: Lighting }
  /** Admin model and height overrides; sent on entering the game and again whenever they change. */
  | { t: 'models'; models: ModelOverrides }
  /** The trader's shared stock, oldest first. */
  | { t: 'trader'; stock: TraderEntry[] }
  /** `game` reaches everyone in your world; `party` your party anywhere; `whisper` one player; `system` is the server. */
  | { t: 'chat'; kind: 'game' | 'party' | 'whisper' | 'system'; from: string; to: string | null; text: string }
  /** Opens the waypoint menu: the zone of the waypoint underfoot and every one this character has found. */
  | { t: 'waypoints'; current: ZoneId; unlocked: ZoneId[] }
  | StagingMessage
  | ArenaStatus
  | ArenaResult
  | Snapshot
  | InventoryMessage
  | { t: 'notice'; text: string }
  | InscribeReply
  /** A big centre-screen announcement, like a cleared dungeon. */
  | { t: 'banner'; title: string; text: string }
  /** The server refused or ended the session; the socket closes right after. */
  | { t: 'sessionEnded'; reason: string }
  | { t: 'pong'; clientTime: number };
