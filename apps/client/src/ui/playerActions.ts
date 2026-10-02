import { guildCan, type GuildInfo, type PartyInfo } from '@rune/shared';
import { create } from 'zustand';

/**
 * The small menu a right-click on another player opens (their name in chat, or their model in
 * town): whisper, invite to the party, invite to the guild. Screen coordinates, outside the UI
 * scale layer like the tooltips.
 */
export interface PlayerMenuState {
  name: string | null;
  x: number;
  y: number;
}

export const usePlayerMenu = create<PlayerMenuState>(() => ({ name: null, x: 0, y: 0 }));

export function openPlayerMenu(name: string, x: number, y: number): void {
  usePlayerMenu.setState({ name, x, y });
}

export function closePlayerMenu(): void {
  if (usePlayerMenu.getState().name !== null) usePlayerMenu.setState({ name: null });
}

export type PlayerMenuItem = 'whisper' | 'party' | 'guild';

/**
 * What the menu offers for `name`. Nothing for yourself. The party invite hides for someone already
 * in your party; the guild invite shows only to ranks that invite, and not for a member already on
 * the roster.
 */
export function playerMenuItems(name: string, me: string, party: PartyInfo | null, guild: GuildInfo | null): PlayerMenuItem[] {
  const lower = name.toLowerCase();
  if (lower === me.toLowerCase() || name === '') return [];
  const out: PlayerMenuItem[] = ['whisper'];
  if (!party?.members.some((m) => m.name.toLowerCase() === lower)) out.push('party');
  if (guild && guildCan(guild.rank, 'invite') && !guild.members.some((m) => m.name.toLowerCase() === lower)) out.push('guild');
  return out;
}

/** The chat sender a right-click on a line names: the other side of a whisper, else the speaker. */
export function chatPartner(line: { kind: string; from: string; to: string | null }, me: string): string | null {
  if (line.kind === 'system') return null;
  if (line.kind === 'whisper' && line.from.toLowerCase() === me.toLowerCase()) return line.to;
  return line.from;
}
