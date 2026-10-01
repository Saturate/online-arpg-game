import { isStarterDamage, NO_STARTER_DAMAGE, type StarterDamage } from '@rune/shared';
import { create } from 'zustand';

interface StarterTuning {
  /** The admin's starter damage multipliers as the server last sent them; none until it does. */
  damage: StarterDamage;
}

export const useStarterTuning = create<StarterTuning>(() => ({ damage: NO_STARTER_DAMAGE }));

/**
 * Takes the server's table from a welcome or a `starterDamage` message. A welcome from an older
 * server has none and a bad table is ignored, so the last good one stays.
 */
export function receiveStarterDamage(value: unknown): void {
  if (isStarterDamage(value)) useStarterTuning.setState({ damage: value });
}
