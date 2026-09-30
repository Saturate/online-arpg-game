import type { AffixId, ItemTier, RuneId, RuneKind, RuneSortKey, SigilSortKey, StashTabRef } from '@rune/shared';
import { create } from 'zustand';

export type SigilContents = 'all' | 'blank' | 'runes' | 'starter';

/**
 * What the stash window shows: the open tab and each list tab's sort and filters. Kept outside the
 * component so a filter survives switching tabs, and so a quick move from the bag knows which
 * general tab is on screen.
 */
export interface StashView {
  tab: StashTabRef;
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
  tab: 1,
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
