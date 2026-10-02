import { MINIONS } from '../config/sim.js';
import { RUNE_STACK, SIGIL_MAX_SLOTS } from '../items/items.js';
import { BAG, STASH } from '../items/grid.js';
import { isStashColorId, isStashTabName, STASH_TABS } from '../config/stash.js';
import { isRuneAffixId, isRuneSortKey, isSigilSortKey, type StashSortKey, type StashTabRef } from '../items/stash.js';
import type { AffixId } from '../data/affixes.js';
import { isRuneId } from '../runes/v2/runes.js';
import { GEAR_SLOTS, type GearSlot } from '../data/gear.js';

function isGearSlot(v: unknown): v is GearSlot {
  return typeof v === 'string' && GEAR_SLOTS.some((s) => s === v);
}
import { parseDevCommand } from '../sim/dev.js';
import { validateLayout } from '../world/town.js';
import { isCastCooldown, isSessionToken, isZoomSettings } from './accounts.js';
import { CHAT_LINKS, isLinkedItem, parseChatLinkUids } from './chatLinks.js';
import { INSTANCE_CAPACITY } from '../data/zones.js';
import { isWaypointId } from '../world/worldPlan.js';
import { isClassId } from '../data/classes.js';
import { isTunableValues } from '../tuning/values.js';
import { GUILD_LIMITS } from '../config/guild.js';
import { GUILD_RANKS, isManagedRank } from '../guild/guild.js';
import { BUTTON_MASK, type ChatMessage, type ClientMessage, type GridDest, type InscribeReply, type ItemDest, type PartyMemberStatus, type PartyPlace, type PartyStatusMessage, type RuneRef, type ServerMessage, type TeleportChannelMessage } from './messages.js';
const SLOT_COUNT = 4;

function isWarbandSlot(value: unknown): value is number {
  return isNonNegativeInt(value) && value < MINIONS.warbandSlots;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSlot(value: unknown): value is number {
  return isNonNegativeInt(value) && value < SLOT_COUNT;
}

function parseRuneRef(value: unknown): RuneRef | null {
  if (!isRecord(value)) return null;
  switch (value.from) {
    case 'keep':
      return isNonNegativeInt(value.index) && value.index < SIGIL_MAX_SLOTS ? { from: 'keep', index: value.index } : null;
    case 'plain':
      return typeof value.rune === 'string' && isRuneId(value.rune) ? { from: 'plain', rune: value.rune } : null;
    case 'rolled':
      return isNonNegativeInt(value.uid) ? { from: 'rolled', uid: value.uid } : null;
    default:
      return null;
  }
}

/**
 * A sigil's new slot list. No sigil holds more than SIGIL_MAX_SLOTS; the simulation checks the
 * sigil's real capacity and ownership. A slot kept twice or a rolled rune named twice would put one
 * rune in two slots, so the whole request is refused here already.
 */
function parseRuneRefs(value: unknown): RuneRef[] | null {
  if (!Array.isArray(value) || value.length > SIGIL_MAX_SLOTS) return null;
  const out: RuneRef[] = [];
  const kept = new Set<number>();
  const rolled = new Set<number>();
  for (const v of value) {
    const ref = parseRuneRef(v);
    if (!ref) return null;
    if (ref.from === 'keep') {
      if (kept.has(ref.index)) return null;
      kept.add(ref.index);
    }
    if (ref.from === 'rolled') {
      if (rolled.has(ref.uid)) return null;
      rolled.add(ref.uid);
    }
    out.push(ref);
  }
  return out;
}

/** The slot uids a draft was made from: at most a full sigil, each uid once. */
function parseBase(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > SIGIL_MAX_SLOTS) return null;
  const out: number[] = [];
  for (const v of value) {
    if (!isNonNegativeInt(v) || out.includes(v)) return null;
    out.push(v);
  }
  return out;
}

/** General tab ids run from 1 and one more per tab bought, so none is ever above the cap. */
function isGeneralTabId(v: unknown): v is number {
  return isNonNegativeInt(v) && v >= 1 && v <= STASH_TABS.maxGeneral;
}

function parseGridDest(v: unknown): GridDest | null {
  if (!isRecord(v) || !isNonNegativeInt(v.x) || !isNonNegativeInt(v.y)) return null;
  if (v.at === 'bag') return v.x < BAG.w && v.y < BAG.h ? { at: 'bag', x: v.x, y: v.y } : null;
  if (v.at === 'tab') return isGeneralTabId(v.tab) && v.x < STASH.w && v.y < STASH.h ? { at: 'tab', tab: v.tab, x: v.x, y: v.y } : null;
  return null;
}

function parseItemDest(v: unknown): ItemDest | null {
  if (isRecord(v) && (v.at === 'runes' || v.at === 'sigils')) return { at: v.at };
  return parseGridDest(v);
}

function parseTabRef(v: unknown): StashTabRef | null {
  return v === 'runes' || v === 'sigils' ? v : isGeneralTabId(v) ? v : null;
}

/**
 * A list tab sorts by one of its own keys; a general tab has one order and takes none. Sorting the
 * rune tab by affix names a rune affix; every other sort names none.
 */
function parseSort(tab: StashTabRef, key: unknown, affix: unknown): { key: StashSortKey | null; affix: AffixId | null } | null {
  if (tab === 'runes' && isRuneSortKey(key)) {
    if (key === 'affix') return isRuneAffixId(affix) ? { key, affix } : null;
    return affix === null ? { key, affix: null } : null;
  }
  if (tab === 'sigils') return isSigilSortKey(key) && affix === null ? { key, affix: null } : null;
  return typeof tab === 'number' && key === null && affix === null ? { key: null, affix: null } : null;
}

export const CHAT_MAX_LENGTH = 200;

/**
 * Chat text is shown to other players, so control and zero-width characters are stripped (they can
 * break layout or disguise text) and length is capped. Rendering never parses it as HTML anyway.
 */
export function cleanChat(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Whitespace first: newlines are control characters too, and should become spaces, not vanish.
  const text = value.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, CHAT_MAX_LENGTH);
  return text.length > 0 ? text : null;
}

function isGuildTabId(v: unknown): v is number {
  return isNonNegativeInt(v) && v >= 1 && v <= GUILD_LIMITS.tabIdMax;
}

/** A member id is an account id, so any whole number; the server checks it is in the guild. */
function isMemberId(v: unknown): v is number {
  return isNonNegativeInt(v);
}

function parseCell(v: unknown, size: { w: number; h: number }): { x: number; y: number } | null {
  return isRecord(v) && isNonNegativeInt(v.x) && isNonNegativeInt(v.y) && v.x < size.w && v.y < size.h ? { x: v.x, y: v.y } : null;
}

function parseOptionalCell(v: unknown, size: { w: number; h: number }): { x: number; y: number } | null | undefined {
  if (v === null) return null;
  return parseCell(v, size) ?? undefined;
}

/** Strings a player types for a guild: refused past a generous cap here, checked properly by the server. */
function isShortString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max;
}

/** Structural check only. Gameplay limits (speed, cooldowns, heat, ownership) are enforced by the simulation. */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value)) return null;
  switch (value.t) {
    case 'join':
      return isSessionToken(value.token) && isNonNegativeInt(value.characterId)
        ? { t: 'join', token: value.token, characterId: value.characterId }
        : null;
    case 'pause':
      return typeof value.paused === 'boolean' ? { t: 'pause', paused: value.paused } : null;
    case 'townPortal':
      return { t: 'townPortal' };
    case 'partyInvite':
      return typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 24 ? { t: 'partyInvite', name: value.name } : null;
    case 'partyAnswer':
      return typeof value.accept === 'boolean' ? { t: 'partyAnswer', accept: value.accept } : null;
    case 'partyLeave':
      return { t: 'partyLeave' };
    case 'partyWorld':
      return { t: 'partyWorld' };
    case 'publicWorld':
      return { t: 'publicWorld' };
    case 'chat': {
      const text = cleanChat(value.text);
      const links = parseChatLinkUids(value.links);
      if (!text || !links) return null;
      return links.length > 0 ? { t: 'chat', text, links } : { t: 'chat', text };
    }
    case 'useWaypoint':
      return isWaypointId(value.waypoint) ? { t: 'useWaypoint', waypoint: value.waypoint } : null;
    case 'partyTeleport':
      return typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 24 ? { t: 'partyTeleport', name: value.name } : null;
    case 'input': {
      const { seq, moveDir, aimAngle, buttons } = value;
      if (!isNonNegativeInt(seq)) return null;
      if (!isRecord(moveDir) || !isFiniteNumber(moveDir.x) || !isFiniteNumber(moveDir.y)) return null;
      if (!isFiniteNumber(aimAngle)) return null;
      if (!Number.isInteger(buttons) || !isFiniteNumber(buttons)) return null;
      return {
        t: 'input',
        seq,
        moveDir: { x: moveDir.x, y: moveDir.y },
        aimAngle,
        buttons: buttons & BUTTON_MASK,
      };
    }
    case 'ping':
      return isFiniteNumber(value.clientTime) ? { t: 'ping', clientTime: value.clientTime } : null;
    case 'inscribe': {
      const slots = parseRuneRefs(value.slots);
      const base = parseBase(value.base);
      return isNonNegativeInt(value.uid) && isNonNegativeInt(value.attempt) && base && slots ? { t: 'inscribe', uid: value.uid, base, slots, attempt: value.attempt } : null;
    }
    case 'equipSigil':
      return isNonNegativeInt(value.uid) && isSlot(value.slot) ? { t: 'equipSigil', uid: value.uid, slot: value.slot } : null;
    case 'unequipSigil':
      return isSlot(value.slot) ? { t: 'unequipSigil', slot: value.slot } : null;
    case 'swapSigils':
      return isSlot(value.a) && isSlot(value.b) ? { t: 'swapSigils', a: value.a, b: value.b } : null;
    case 'equipVessel':
      return isNonNegativeInt(value.uid) && isWarbandSlot(value.slot) ? { t: 'equipVessel', uid: value.uid, slot: value.slot } : null;
    case 'unequipVessel':
      return isWarbandSlot(value.slot) ? { t: 'unequipVessel', slot: value.slot } : null;
    case 'sortInventory':
      return { t: 'sortInventory' };
    case 'traderList':
      return { t: 'traderList' };
    case 'sell':
      return isNonNegativeInt(value.uid) ? { t: 'sell', uid: value.uid } : null;
    case 'buy':
      return isNonNegativeInt(value.id) ? { t: 'buy', id: value.id } : null;
    case 'pickup':
      if (!isNonNegativeInt(value.id)) return null;
      if (value.uid === undefined) return { t: 'pickup', id: value.id };
      return isNonNegativeInt(value.uid) ? { t: 'pickup', id: value.id, uid: value.uid } : null;
    case 'lootOpen':
      return isNonNegativeInt(value.id) ? { t: 'lootOpen', id: value.id } : null;
    case 'lootClose':
      return { t: 'lootClose' };
    case 'moveItem': {
      const to = parseItemDest(value.to);
      return isNonNegativeInt(value.uid) && to ? { t: 'moveItem', uid: value.uid, to } : null;
    }
    case 'quickMove':
      return isNonNegativeInt(value.uid) && (value.tab === null || isGeneralTabId(value.tab)) ? { t: 'quickMove', uid: value.uid, tab: value.tab } : null;
    case 'takeRunes': {
      const { uid, count } = value;
      const to = value.to === null ? null : parseGridDest(value.to);
      if (!isNonNegativeInt(uid) || !isNonNegativeInt(count) || count < 1 || count > RUNE_STACK) return null;
      return to !== null || value.to === null ? { t: 'takeRunes', uid, count, to } : null;
    }
    case 'sortStash': {
      const tab = parseTabRef(value.tab);
      const sort = tab === null ? null : parseSort(tab, value.key, value.affix);
      return tab !== null && sort ? { t: 'sortStash', tab, key: sort.key, affix: sort.affix } : null;
    }
    case 'buyStashTab':
      return { t: 'buyStashTab' };
    case 'editStashTab':
      return isGeneralTabId(value.tab) && isStashTabName(value.name) && isStashColorId(value.color) ? { t: 'editStashTab', tab: value.tab, name: value.name, color: value.color } : null;
    case 'discard':
      return isNonNegativeInt(value.uid) ? { t: 'discard', uid: value.uid } : null;
    case 'cycleStance':
      return { t: 'cycleStance' };
    case 'ready':
      return typeof value.ready === 'boolean' ? { t: 'ready', ready: value.ready } : null;
    case 'planMismatch':
      return isPlanHash(value.server) && isPlanHash(value.client) && typeof value.roomId === 'string' && /^[a-z0-9-]{1,64}$/.test(value.roomId)
        ? { t: 'planMismatch', roomId: value.roomId, server: value.server, client: value.client }
        : null;
    case 'equipGear':
      return isNonNegativeInt(value.uid) ? { t: 'equipGear', uid: value.uid, slot: isGearSlot(value.slot) ? value.slot : null } : null;
    case 'unequipGear':
      return isGearSlot(value.slot) ? { t: 'unequipGear', slot: value.slot } : null;
    case 'dev': {
      const cmd = parseDevCommand(value.cmd);
      return cmd ? { t: 'dev', cmd } : null;
    }
    case 'saveTown': {
      const layout = validateLayout(value.layout);
      return layout ? { t: 'saveTown', layout } : null;
    }
    case 'guildCreate':
      return isShortString(value.name, GUILD_LIMITS.nameMax) && isShortString(value.tag, GUILD_LIMITS.tagMax) ? { t: 'guildCreate', name: value.name, tag: value.tag } : null;
    case 'guildInvite':
      return typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 24 ? { t: 'guildInvite', name: value.name } : null;
    case 'guildAnswer':
      return typeof value.accept === 'boolean' ? { t: 'guildAnswer', accept: value.accept } : null;
    case 'guildLeave':
      return { t: 'guildLeave' };
    case 'guildKick':
    case 'guildPromote':
    case 'guildDemote':
    case 'guildTransfer':
      return isMemberId(value.member) ? { t: value.t, member: value.member } : null;
    case 'guildDisband':
      return { t: 'guildDisband' };
    case 'guildMotd':
      // Longer than the cap is cut by the server, not refused: a pasted line should still land.
      return isShortString(value.text, 1000) ? { t: 'guildMotd', text: value.text } : null;
    case 'guildRefresh':
      return { t: 'guildRefresh' };
    case 'guildLog':
      return value.before === null || isNonNegativeInt(value.before) ? { t: 'guildLog', before: value.before } : null;
    case 'guildStashOpen':
      return { t: 'guildStashOpen' };
    case 'guildStashClose':
      return { t: 'guildStashClose' };
    case 'guildDeposit': {
      const at = parseOptionalCell(value.at, STASH);
      return isNonNegativeInt(value.uid) && isGuildTabId(value.tab) && at !== undefined ? { t: 'guildDeposit', uid: value.uid, tab: value.tab, at } : null;
    }
    case 'guildWithdraw': {
      const at = parseOptionalCell(value.at, BAG);
      return isNonNegativeInt(value.uid) && at !== undefined ? { t: 'guildWithdraw', uid: value.uid, at } : null;
    }
    case 'guildMove': {
      const at = parseCell(value.at, STASH);
      return isNonNegativeInt(value.uid) && isGuildTabId(value.tab) && at ? { t: 'guildMove', uid: value.uid, tab: value.tab, at } : null;
    }
    case 'guildBuyTab':
      return { t: 'guildBuyTab' };
    case 'guildEditTab':
      return isGuildTabId(value.tab) && isStashTabName(value.name) && isStashColorId(value.color) ? { t: 'guildEditTab', tab: value.tab, name: value.name, color: value.color } : null;
    case 'guildTabPerms': {
      const p = value.perms;
      if (!isGuildTabId(value.tab) || !isManagedRank(value.rank) || !isRecord(p) || typeof p.view !== 'boolean' || typeof p.deposit !== 'boolean' || typeof p.withdraw !== 'boolean') return null;
      return { t: 'guildTabPerms', tab: value.tab, rank: value.rank, perms: { view: p.view, deposit: p.deposit, withdraw: p.withdraw } };
    }
    default:
      return null;
  }
}

/** `planChecksum`'s output: 8 hex digits, so a report cannot carry anything else into the log. */
function isPlanHash(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}$/.test(v);
}

const SERVER_TAGS = new Set(['welcome', 'snapshot', 'inventory', 'notice', 'inscribed', 'pong', 'world', 'party', 'partyInvite', 'trader', 'lighting', 'models', 'sessionEnded', 'staging', 'banner', 'waypoints', 'chat', 'arena', 'arenaResult', 'partyStatus', 'teleportChannel', 'zoom', 'castCooldown', 'tunables', 'lootPile', 'restart', 'guild', 'guildInvite', 'guildLog', 'guildStash']);

/**
 * The server is trusted, so this only discriminates on the tag. The payload shape is guaranteed by
 * the shared types on the sending side.
 */
export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || typeof value.t !== 'string' || !SERVER_TAGS.has(value.t)) return false;
  if (value.t === 'partyStatus') return isPartyStatus(value);
  if (value.t === 'teleportChannel') return isTeleportChannel(value);
  if (value.t === 'chat') return isChatMessage(value);
  if (value.t === 'zoom') return isZoomSettings(value.zoom);
  if (value.t === 'castCooldown') return isCastCooldown(value.seconds);
  if (value.t === 'tunables') return isTunableValues(value.values);
  if (value.t === 'restart') return isFiniteNumber(value.seconds) && value.seconds >= 0;
  if (value.t === 'guild') return isFiniteNumber(value.foundPrice) && (value.guild === null || isGuildInfo(value.guild));
  if (value.t === 'guildInvite') return typeof value.from === 'string' && typeof value.guild === 'string' && typeof value.tag === 'string';
  if (value.t === 'guildLog') return Array.isArray(value.entries) && typeof value.more === 'boolean';
  if (value.t === 'guildStash') return value.stash === null || (isRecord(value.stash) && Array.isArray(value.stash.tabs) && Array.isArray(value.stash.items));
  return value.t !== 'inscribed' || isInscribeReply(value);
}

/**
 * The guild window acts on this (its buttons send member ids back), so the roster is checked
 * field by field. A guild holds at most GUILD_LIMITS.maxMembers.
 */
function isGuildInfo(v: unknown): boolean {
  if (!isRecord(v) || !isNonNegativeInt(v.id) || typeof v.name !== 'string' || typeof v.tag !== 'string' || typeof v.motd !== 'string') return false;
  if (!GUILD_RANKS.some((r) => r === v.rank) || !Array.isArray(v.members) || v.members.length > GUILD_LIMITS.maxMembers) return false;
  return v.members.every((m: unknown) => isRecord(m) && isNonNegativeInt(m.id) && typeof m.name === 'string' && GUILD_RANKS.some((r) => r === m.rank) && (m.cls === null || isClassId(m.cls)) && isNonNegativeInt(m.level) && typeof m.online === 'boolean' && typeof m.zone === 'string');
}

const CHAT_KINDS: readonly ChatMessage['kind'][] = ['game', 'party', 'whisper', 'guild', 'system'];

/**
 * Chat carries another player's text and item copies straight into the tooltip, so it is checked
 * field by field. Names are character names (16) or empty for system lines. The text cap is loose:
 * server lines such as /who or /help run past the 200 a player may send.
 */
export function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value) || value.t !== 'chat' || !CHAT_KINDS.some((k) => k === value.kind)) return false;
  if (typeof value.from !== 'string' || value.from.length > 32 || !(value.to === null || (typeof value.to === 'string' && value.to.length <= 32))) return false;
  if (typeof value.text !== 'string' || value.text.length > 2000) return false;
  if (value.tag !== undefined && !(typeof value.tag === 'string' && value.tag.length <= GUILD_LIMITS.tagMax)) return false;
  return value.items === undefined || (Array.isArray(value.items) && value.items.length <= CHAT_LINKS.max && value.items.every(isLinkedItem));
}

const PARTY_PLACES: readonly PartyPlace[] = ['town', 'wilds', 'dungeon', 'arena', 'sandbox', 'offline'];

function isPartyMemberStatus(v: unknown): v is PartyMemberStatus {
  if (!isRecord(v) || typeof v.name !== 'string' || !(v.cls === null || isClassId(v.cls))) return false;
  if (!isNonNegativeInt(v.level) || !isFiniteNumber(v.life) || !isFiniteNumber(v.maxLife) || typeof v.dead !== 'boolean') return false;
  if (!PARTY_PLACES.some((p) => p === v.place) || typeof v.zone !== 'string') return false;
  // A position comes as a pair or not at all; the minimap draws it as is.
  if (v.x === undefined ? v.y !== undefined : !isFiniteNumber(v.x) || !isFiniteNumber(v.y)) return false;
  return v.no === undefined || typeof v.no === 'string';
}

/**
 * The party frames act on this (a click asks to teleport to a name, markers go on the minimap), so
 * it is checked field by field rather than trusted to the tag. A party holds at most a world's worth.
 */
export function isPartyStatus(value: unknown): value is PartyStatusMessage {
  return isRecord(value) && value.t === 'partyStatus' && Array.isArray(value.members) && value.members.length < INSTANCE_CAPACITY && value.members.every(isPartyMemberStatus);
}

export function isTeleportChannel(value: unknown): value is TeleportChannelMessage {
  if (!isRecord(value) || value.t !== 'teleportChannel') return false;
  if (typeof value.to === 'string') return isFiniteNumber(value.seconds) && value.seconds > 0;
  return value.to === null && (value.reason === null || typeof value.reason === 'string');
}

/**
 * The forge acts on this one directly (it clears or shows the refusal for the sigil being edited),
 * so its fields are checked rather than trusted to the tag.
 */
export function isInscribeReply(value: unknown): value is InscribeReply {
  if (!isRecord(value) || value.t !== 'inscribed' || !isNonNegativeInt(value.uid) || !isNonNegativeInt(value.attempt)) return false;
  if (value.ok === true) return value.error === undefined;
  return value.ok === false && typeof value.error === 'string' && value.error.length > 0;
}
