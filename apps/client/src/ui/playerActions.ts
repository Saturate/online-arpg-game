import { guildCan, type GuildInfo, type PartyInfo } from '@rune/shared';
import { create } from 'zustand';

/**
 * The small menu a right-click on another player opens (their name in chat, or their model in
 * town): whisper, invite to the party, invite to the guild. Screen coordinates, outside the UI
 * scale layer like the tooltips.
 */
export interface PlayerMenuState {
  name: string | null;
  /** Their guild tag, when known (nameplate or chat line): a tagged player is in a guild already. */
  tag: string | null;
  x: number;
  y: number;
}

export const usePlayerMenu = create<PlayerMenuState>(() => ({ name: null, tag: null, x: 0, y: 0 }));

export function openPlayerMenu(name: string, x: number, y: number, tag: string | null = null): void {
  usePlayerMenu.setState({ name, x, y, tag });
}

export function closePlayerMenu(): void {
  if (usePlayerMenu.getState().name !== null) usePlayerMenu.setState({ name: null });
}

export type PlayerMenuItem = 'whisper' | 'party' | 'guild';

/**
 * What the menu offers for `name`. Nothing for yourself. The party invite hides for someone already
 * in your party; the guild invite shows only to ranks that invite, and not for a member already on
 * the roster or anyone wearing a tag (in a guild already, which the server would refuse).
 */
export function playerMenuItems(name: string, me: string, party: PartyInfo | null, guild: GuildInfo | null, tag: string | null = null): PlayerMenuItem[] {
  const lower = name.toLowerCase();
  if (lower === me.toLowerCase() || name === '') return [];
  const out: PlayerMenuItem[] = ['whisper'];
  if (!party?.members.some((m) => m.name.toLowerCase() === lower)) out.push('party');
  if (!tag && guild && guildCan(guild.rank, 'invite') && !guild.members.some((m) => m.name.toLowerCase() === lower)) out.push('guild');
  return out;
}

/**
 * Who a right-click on a chat line is about, with their tag when the line carries it: the other
 * side of a whisper, else the speaker. Null for system lines and your own lines.
 */
export function chatPartner(line: { kind: string; from: string; to: string | null; tag?: string | undefined }, me: string): { name: string; tag: string | null } | null {
  if (line.kind === 'system' || line.from === '') return null;
  const mine = line.from.toLowerCase() === me.toLowerCase();
  if (line.kind === 'whisper' && mine) return line.to && line.to.toLowerCase() !== me.toLowerCase() ? { name: line.to, tag: null } : null;
  if (mine) return null;
  return { name: line.from, tag: line.tag ?? null };
}
