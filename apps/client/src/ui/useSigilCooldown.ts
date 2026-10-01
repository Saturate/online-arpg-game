import type { SigilItem } from '@rune/shared';
import { sigilCooldown, useCastTiming } from '../game/castTiming.js';
import { useUi } from './store.js';

/** Seconds between casts of this sigil for the current character, following admin changes live. */
export function useSigilCooldown(item: SigilItem): number;
export function useSigilCooldown(item: SigilItem | null): number | null;
export function useSigilCooldown(item: SigilItem | null): number | null {
  const globalSeconds = useCastTiming((s) => s.globalSeconds);
  const castSpeed = useUi((s) => s.stats?.castSpeedMult ?? 1);
  return item ? sigilCooldown(item, globalSeconds, castSpeed) : null;
}
