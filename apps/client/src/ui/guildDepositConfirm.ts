import type { ClientMessage, Item } from '@rune/shared';
import { create } from 'zustand';

/** A guild deposit waiting for a yes (guildStashView.ts, depositPrompt), shown in the guild stash pane. */
export interface PendingGuildDeposit {
  msg: Extract<ClientMessage, { t: 'guildDeposit' }>;
  item: Item;
  text: string;
}

export const usePendingGuildDeposit = create<{ pending: PendingGuildDeposit | null }>(() => ({ pending: null }));
