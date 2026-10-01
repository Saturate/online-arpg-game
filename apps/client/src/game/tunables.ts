import { applyTunables, parseTunableValues, tunablesVersion } from '@rune/shared';
import { create } from 'zustand';

interface LiveTunables {
  /** Bumped on every apply, so memoised compiles (skill bar, forge) rebuild with the new numbers. */
  version: number;
}

export const useTunables = create<LiveTunables>(() => ({ version: tunablesVersion() }));

/**
 * Takes the server's live tuning from a welcome or a `tunables` message and applies it to the
 * shared config, as the server did, so tooltips, the forge and local previews match the server.
 * Unknown paths and values outside their range are dropped; a welcome without any (an old replay)
 * means code defaults.
 */
export function receiveTunables(values: unknown): void {
  applyTunables(parseTunableValues(values));
  useTunables.setState({ version: tunablesVersion() });
}
