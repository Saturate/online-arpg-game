import type { ClassId } from '../data/classes.js';
import type { GuildRank } from '../guild/guild.js';
import type { GuildLogEntry } from './messages.js';

/** The admin page's Guilds tab (docs/features/admin-ui.md, "Guilds"). Read with `viewAdmin`. */
export interface AdminGuildSummary {
  id: number;
  name: string;
  tag: string;
  createdAt: number;
  members: number;
  /** Null when no member holds the rank (the Leader's account was removed and nobody was left to take it). */
  leader: { accountId: number; username: string; character: string | null } | null;
  tabs: number;
  items: number;
  /** False when the stored stash could not be read; the guild's stash is then refused and the row kept. */
  stashReadable: boolean;
}

export interface AdminGuildMember {
  accountId: number;
  username: string;
  rank: GuildRank;
  joinedAt: number;
  character: string | null;
  classId: ClassId | null;
  level: number;
  /** The account's last save (about its last login). */
  lastActive: number;
  online: boolean;
}

export interface AdminGuildDetail extends AdminGuildSummary {
  motd: string;
  roster: AdminGuildMember[];
  tabList: { id: number; name: string; items: number }[];
  log: GuildLogEntry[];
  moreLog: boolean;
}
