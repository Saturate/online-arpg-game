import { canKick, guildCan, guildNameProblem, guildTagProblem, rankOrder, type GuildInfo, type GuildLogEntry, type GuildMemberView, type GuildRank, type GuildStashView, type ServerMessage } from '@rune/shared';

/**
 * The guild window's rules, kept free of React so they can be tested: which roster buttons a rank
 * sees (the same checks the server makes, so a button never leads to a refusal), the founding form's
 * checks, how guild messages land in the UI store, and how a tag reads before a name.
 */

export interface GuildInvite {
  from: string;
  guild: string;
  tag: string;
}

/** The log as the window holds it. `append` is set while a request for an older page is out. */
export interface GuildLogState {
  entries: GuildLogEntry[];
  more: boolean;
  append: boolean;
  loaded: boolean;
}

export const EMPTY_GUILD_LOG: GuildLogState = { entries: [], more: false, append: false, loaded: false };

/** The slice of the UI store guild messages write to. */
export interface GuildSlice {
  guild: GuildInfo | null;
  guildFoundPrice: number;
  guildInvite: GuildInvite | null;
  guildLog: GuildLogState;
  guildStash: GuildStashView | null;
}

type GuildMessage = Extract<ServerMessage, { t: 'guild' | 'guildInvite' | 'guildLog' | 'guildStash' }>;

/** What one guild message changes in the store. */
export function receiveGuild(s: GuildSlice, msg: GuildMessage): Partial<GuildSlice> {
  switch (msg.t) {
    case 'guild': {
      if (msg.guild === null) return { guild: null, guildFoundPrice: msg.foundPrice, guildLog: EMPTY_GUILD_LOG, guildStash: null };
      // Another guild's log (left one, joined another) must not show under the new name.
      const same = s.guild?.id === msg.guild.id;
      return { guild: msg.guild, guildFoundPrice: msg.foundPrice, ...(same ? {} : { guildLog: EMPTY_GUILD_LOG }), ...(s.guildInvite ? { guildInvite: null } : {}) };
    }
    case 'guildInvite':
      return { guildInvite: { from: msg.from, guild: msg.guild, tag: msg.tag } };
    case 'guildLog': {
      if (!s.guildLog.append) return { guildLog: { entries: msg.entries, more: msg.more, append: false, loaded: true } };
      // An older page joins below what is shown; ids are unique, so a line never shows twice.
      const seen = new Set(s.guildLog.entries.map((e) => e.id));
      const entries = [...s.guildLog.entries, ...msg.entries.filter((e) => !seen.has(e.id))].sort((a, b) => b.id - a.id);
      return { guildLog: { entries, more: msg.more, append: false, loaded: true } };
    }
    case 'guildStash':
      return { guildStash: msg.stash };
  }
}

/** The log page to ask for: the newest, or the one before the oldest line shown. */
export function logRequest(log: GuildLogState, older: boolean): { before: number | null; append: boolean } {
  const last = log.entries[log.entries.length - 1];
  return older && last ? { before: last.id, append: true } : { before: null, append: false };
}

// Roster -----------------------------------------------------------------------------------------

export interface MemberActions {
  promote: boolean;
  demote: boolean;
  kick: boolean;
  /** Make Leader. */
  transfer: boolean;
}

const NONE: MemberActions = { promote: false, demote: false, kick: false, transfer: false };

/**
 * The buttons a viewer of `rank` sees on another member's row. Only the Leader promotes, demotes
 * and hands leadership on; kicks go to ranks below the kicker. Nobody acts on their own row.
 */
export function memberActions(rank: GuildRank, member: GuildMemberView, self: boolean): MemberActions {
  if (self || member.rank === 'leader') return NONE;
  return {
    promote: guildCan(rank, 'promote') && member.rank === 'member',
    demote: guildCan(rank, 'demote') && member.rank === 'officer',
    kick: canKick(rank, member.rank),
    transfer: guildCan(rank, 'transfer'),
  };
}

/** Leader first, then Officers, then Members; online before offline; then by name. */
export function sortRoster(members: readonly GuildMemberView[]): GuildMemberView[] {
  return [...members].sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** The viewer's own row: the account's current character is the name the roster shows for it. */
export function isSelf(member: GuildMemberView, myName: string): boolean {
  return member.name.toLowerCase() === myName.toLowerCase();
}

export function onlineCount(g: GuildInfo): number {
  return g.members.filter((m) => m.online).length;
}

// Founding ---------------------------------------------------------------------------------------

/** Why the founding form cannot be sent yet, or null. Name first, as the form reads. */
export function foundProblem(name: string, tag: string, gold: number, price: number): string | null {
  if (name === '' && tag === '') return null;
  return guildNameProblem(name) ?? guildTagProblem(tag) ?? (gold < price ? `Founding costs ${price} gold; you have ${gold}` : null);
}

/** The founding form tidies spaces the way the server wants them; the tag keeps its letters as typed. */
export function cleanGuildName(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

// Tags ---------------------------------------------------------------------------------------------

/** A name with its guild tag in front, as nameplates and chat show it. */
export function taggedName(name: string, tag: string | undefined): string {
  return tag ? `[${tag}] ${name}` : name;
}

/** Message of the day as it will be stored: the server collapses whitespace and caps it. */
export function motdDraftChanged(draft: string, current: string): boolean {
  return draft.replace(/\s+/g, ' ').trim() !== current;
}

export const LOG_KIND_LABELS: Record<GuildLogEntry['kind'], string> = {
  found: 'Founded',
  join: 'Joined',
  leave: 'Left',
  kick: 'Removed',
  rank: 'Rank',
  leader: 'Leader',
  deposit: 'Deposit',
  withdraw: 'Withdrawal',
  move: 'Moved',
  tab: 'Tab',
  motd: 'Message',
};
