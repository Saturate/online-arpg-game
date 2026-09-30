import { SIM } from '@rune/shared';

/** Long enough that it cannot be used to escape a fight, short enough not to feel like a chore. */
export const TELEPORT_CHANNEL_SECONDS = 3;

/** How often the party frames are refreshed: slow enough to cost nothing, quick enough to read life. */
export const PARTY_STATUS_TICKS = SIM.tickRate;

/**
 * Standing still still drifts a little (minions and other players push, the ground snaps), so only
 * more than this counts as moving.
 */
const MOVE_SLACK = 6;

/** Regeneration only ever raises life, so any drop beyond rounding is a hit. */
const LIFE_SLACK = 0.01;

/** What the channel watches on the channelling player, read once per tick. */
export interface ChannelWatch {
  roomId: string;
  x: number;
  y: number;
  life: number;
  castCooldown: number;
  dashing: boolean;
  dead: boolean;
}

/** Why the channel broke between two ticks, or null when it holds. */
export function channelBreak(start: ChannelWatch, last: ChannelWatch, now: ChannelWatch | null): string | null {
  if (!now || now.roomId !== start.roomId) return 'Teleport cancelled: you left the area';
  if (now.dead) return 'Teleport cancelled: you died';
  if (now.life < last.life - LIFE_SLACK) return 'Teleport interrupted: you took damage';
  if (now.dashing || Math.hypot(now.x - start.x, now.y - start.y) > MOVE_SLACK) return 'Teleport cancelled: you moved';
  // A cast restarts the cooldown, so it only ever goes up by casting.
  if (now.castCooldown > last.castCooldown) return 'Teleport cancelled: you cast a spell';
  return null;
}

/** One player channelling a teleport to a party member. */
export interface TeleportChannel {
  /** The party member's account, so a rename or reconnect still finds them. */
  targetAccount: number;
  targetName: string;
  ticksLeft: number;
  start: ChannelWatch;
  last: ChannelWatch;
}
