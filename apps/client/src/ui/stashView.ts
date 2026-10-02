import type { AffixId, ItemTier, RuneId, RuneKind, RuneSortKey, SigilSortKey, StashTabRef } from '@rune/shared';
import { create } from 'zustand';
import { useUi } from './store.js';

export type SigilContents = 'all' | 'blank' | 'runes' | 'starter';

/**
 * What the stash window shows: the open tab and each list tab's sort and filters. Kept outside the
 * component so a filter survives switching tabs, and so a quick move from the bag knows which
 * general tab is on screen.
 */
export interface StashView {
  /** Which stash the window shows: the account's own, or the guild's (docs/features/guilds.md). */
  source: 'account' | 'guild';
  tab: StashTabRef;
  /** The guild tab on screen while the guild stash is shown. */
  guildTab: number;
  runeSort: RuneSortKey;
  runeSortAffix: AffixId;
  runeFilter: RuneId | 'all';
  kindFilter: RuneKind | 'all';
  runeTierFilter: ItemTier | 'all';
  affixSearch: string;
  sigilSort: SigilSortKey;
  sigilTierFilter: ItemTier | 'all';
  sigilContents: SigilContents;
}

export const useStashView = create<StashView>(() => ({
  source: 'account',
  tab: 1,
  guildTab: 1,
  runeSort: 'rune',
  runeSortAffix: 'rune_damage',
  runeFilter: 'all',
  kindFilter: 'all',
  runeTierFilter: 'all',
  affixSearch: '',
  sigilSort: 'tier',
  sigilTierFilter: 'all',
  sigilContents: 'all',
}));

/** The general tab on screen, which a quick move from the bag tries first; null on the rune or sigil tab. */
export function openGeneralTab(): number | null {
  const { tab } = useStashView.getState();
  return typeof tab === 'number' ? tab : null;
}

/** The guild tab a quick move from the bag goes to, or null while the window shows the account stash. */
export function openGuildTab(): number | null {
  const { source, guildTab } = useStashView.getState();
  return source === 'guild' && useUi.getState().guild !== null ? guildTab : null;
}

// Out of a guild (left, kicked, disbanded, or out of the game), the window shows the account stash
// again, so a later guild never opens on its side by surprise.
useUi.subscribe((s, prev) => {
  if (prev.guild !== null && s.guild === null) useStashView.setState({ source: 'account' });
});
