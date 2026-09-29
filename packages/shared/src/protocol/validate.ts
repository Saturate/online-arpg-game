import { MINIONS } from '../config/sim.js';
import { isRuneId, type RuneId } from '../data/runes.js';
import { GEAR_SLOTS, type GearSlot } from '../data/gear.js';

function isGearSlot(v: unknown): v is GearSlot {
  return typeof v === 'string' && GEAR_SLOTS.some((s) => s === v);
}
import { parseDevCommand } from '../sim/dev.js';
import { validateLayout } from '../world/town.js';
import { isSessionToken } from './accounts.js';
import { isZoneId } from '../data/zones.js';
import { BUTTON_MASK, type ClientMessage, type ServerMessage } from './messages.js';

/** Longer than any sigil can hold; the simulation enforces the real capacity. */
const MAX_RUNES = 12;
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

function parseRunes(value: unknown): RuneId[] | null {
  if (!Array.isArray(value) || value.length > MAX_RUNES) return null;
  const out: RuneId[] = [];
  for (const r of value) {
    if (!isRuneId(r)) return null;
    out.push(r);
  }
  return out;
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
      return text ? { t: 'chat', text } : null;
    }
    case 'useWaypoint':
      return isZoneId(value.zone) ? { t: 'useWaypoint', zone: value.zone } : null;
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
      const runes = parseRunes(value.runes);
      return isNonNegativeInt(value.uid) && runes ? { t: 'inscribe', uid: value.uid, runes } : null;
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
      return isNonNegativeInt(value.id) ? { t: 'pickup', id: value.id } : null;
    case 'moveItem':
      return isNonNegativeInt(value.uid) && (value.to === 'bag' || value.to === 'stash') && isNonNegativeInt(value.x) && isNonNegativeInt(value.y) && value.x < 64 && value.y < 64
        ? { t: 'moveItem', uid: value.uid, to: value.to, x: value.x, y: value.y }
        : null;
    case 'discard':
      return isNonNegativeInt(value.uid) ? { t: 'discard', uid: value.uid } : null;
    case 'cycleStance':
      return { t: 'cycleStance' };
    case 'ready':
      return typeof value.ready === 'boolean' ? { t: 'ready', ready: value.ready } : null;
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
    default:
      return null;
  }
}

const SERVER_TAGS = new Set(['welcome', 'snapshot', 'inventory', 'notice', 'pong', 'world', 'party', 'partyInvite', 'trader', 'lighting', 'models', 'sessionEnded', 'staging', 'banner', 'waypoints', 'chat', 'arena', 'arenaResult']);

/**
 * The server is trusted, so this only discriminates on the tag. The payload shape is guaranteed by
 * the shared types on the sending side.
 */
export function isServerMessage(value: unknown): value is ServerMessage {
  return isRecord(value) && typeof value.t === 'string' && SERVER_TAGS.has(value.t);
}
