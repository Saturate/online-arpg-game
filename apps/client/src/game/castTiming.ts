import { castCooldownSeconds, DEFAULT_SERVER_SETTINGS, isCastCooldown, sigilCastDelayShare, type SigilItem } from '@rune/shared';
import { create } from 'zustand';

interface CastTiming {
  /** The admin's global cast cooldown as the server last sent it; the default until it does. */
  globalSeconds: number;
}

export const useCastTiming = create<CastTiming>(() => ({ globalSeconds: DEFAULT_SERVER_SETTINGS.castCooldownSeconds }));

/**
 * Takes the server's value from a welcome or a `castCooldown` message. An old replay's welcome has
 * none and a bad value is ignored, so the last good number stays.
 */
export function receiveCastCooldown(value: unknown): void {
  if (isCastCooldown(value) && value !== useCastTiming.getState().globalSeconds) useCastTiming.setState({ globalSeconds: value });
}

/** What this sigil waits between casts for this character, by the same formula the server uses. */
export function sigilCooldown(item: SigilItem, globalSeconds: number, castSpeedMult: number): number {
  return castCooldownSeconds(globalSeconds, sigilCastDelayShare(item), castSpeedMult > 0 ? castSpeedMult : 1);
}

/** "0.45 s"; two decimals because a cast delay roll moves it by a few hundredths. */
export function formatCooldown(seconds: number): string {
  return `${seconds.toFixed(2)} s`;
}
