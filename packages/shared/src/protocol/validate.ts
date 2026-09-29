import { MINIONS } from '../config/sim.js';
import { SIGIL_MAX_SLOTS } from '../items/items.js';
import { isRuneId } from '../runes/v2/runes.js';
import { GEAR_SLOTS, type GearSlot } from '../data/gear.js';

function isGearSlot(v: unknown): v is GearSlot {
  return typeof v === 'string' && GEAR_SLOTS.some((s) => s === v);
}
import { parseDevCommand } from '../sim/dev.js';
import { validateLayout } from '../world/town.js';
import { isSessionToken } from './accounts.js';
import { isZoneId } from '../data/zones.js';
import { BUTTON_MASK, type ClientMessage, type InscribeReply, type RuneRef, type ServerMessage } from './messages.js';
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
      const slots = parseRuneRefs(value.slots);
      return isNonNegativeInt(value.uid) && slots ? { t: 'inscribe', uid: value.uid, slots } : null;
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

const SERVER_TAGS = new Set(['welcome', 'snapshot', 'inventory', 'notice', 'inscribed', 'pong', 'world', 'party', 'partyInvite', 'trader', 'lighting', 'models', 'sessionEnded', 'staging', 'banner', 'waypoints', 'chat', 'arena', 'arenaResult']);

/**
 * The server is trusted, so this only discriminates on the tag. The payload shape is guaranteed by
 * the shared types on the sending side.
 */
export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || typeof value.t !== 'string' || !SERVER_TAGS.has(value.t)) return false;
  return value.t !== 'inscribed' || isInscribeReply(value);
}

/**
 * The forge acts on this one directly (it clears or shows the refusal for the sigil being edited),
 * so its fields are checked rather than trusted to the tag.
 */
export function isInscribeReply(value: unknown): value is InscribeReply {
  if (!isRecord(value) || value.t !== 'inscribed' || !isNonNegativeInt(value.uid)) return false;
  if (value.ok === true) return value.error === undefined;
  return value.ok === false && typeof value.error === 'string' && value.error.length > 0;
}
