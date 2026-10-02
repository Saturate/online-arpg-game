import { describe, expect, it } from 'vitest';
import type { GuildInfo, GuildLogEntry, GuildMemberView, GuildRank } from '@rune/shared';
import { EMPTY_GUILD_LOG, foundProblem, logRequest, memberActions, receiveGuild, sortRoster, taggedName, type GuildSlice } from '../src/ui/guildView.js';
import { chatWho } from '../src/ui/chatLine.js';
import { chatPartner, playerMenuItems } from '../src/ui/playerActions.js';

function member(id: number, name: string, rank: GuildRank, online = true): GuildMemberView {
  return { id, name, rank, cls: 'mage', level: 10, online, zone: online ? 'Town' : '', joinedAt: 0 };
}

function guild(rank: GuildRank, id = 1): GuildInfo {
  return { id, name: 'Ashen Watch', tag: 'ASH', motd: '', rank, members: [member(1, 'Lead', 'leader'), member(2, 'Off', 'officer'), member(3, 'Mem', 'member', false)], maxMembers: 50, createdAt: 0 };
}

const empty: GuildSlice = { guild: null, guildFoundPrice: 0, guildInvite: null, guildLog: EMPTY_GUILD_LOG, guildStash: null };

function entry(id: number): GuildLogEntry {
  return { id, at: id * 1000, kind: 'deposit', actor: 'Lead', text: `line ${id}` };
}

describe('guild messages in the store', () => {
  it('keeps the guild and its founding price, and clears everything on leaving', () => {
    const joined = { ...empty, ...receiveGuild(empty, { t: 'guild', guild: guild('member'), foundPrice: 1000 }) };
    expect(joined.guild?.tag).toBe('ASH');
    expect(joined.guildFoundPrice).toBe(1000);
    const withLog = { ...joined, guildLog: { entries: [entry(1)], more: false, append: false, loaded: true } };
    const left = { ...withLog, ...receiveGuild(withLog, { t: 'guild', guild: null, foundPrice: 1200 }) };
    expect(left.guild).toBeNull();
    expect(left.guildLog.entries).toEqual([]);
    expect(left.guildStash).toBeNull();
    expect(left.guildFoundPrice).toBe(1200);
  });

  it('drops the old log when the guild changes, keeps it on a refresh of the same one', () => {
    const s = { ...empty, guild: guild('member', 1), guildLog: { entries: [entry(1)], more: false, append: false, loaded: true } };
    expect(receiveGuild(s, { t: 'guild', guild: guild('member', 1), foundPrice: 1000 }).guildLog).toBeUndefined();
    expect(receiveGuild(s, { t: 'guild', guild: guild('member', 2), foundPrice: 1000 }).guildLog).toEqual(EMPTY_GUILD_LOG);
  });

  it('holds an invite until the guild arrives', () => {
    const invited = { ...empty, ...receiveGuild(empty, { t: 'guildInvite', from: 'Lead', guild: 'Ashen Watch', tag: 'ASH' }) };
    expect(invited.guildInvite).toEqual({ from: 'Lead', guild: 'Ashen Watch', tag: 'ASH' });
    expect(receiveGuild(invited, { t: 'guild', guild: guild('member'), foundPrice: 1000 }).guildInvite).toBeNull();
  });

  it('replaces the log with the newest page and appends an older one without repeats', () => {
    const first = receiveGuild(empty, { t: 'guildLog', entries: [entry(9), entry(8)], more: true }).guildLog;
    if (!first) throw new Error('no log');
    const req = logRequest(first, true);
    expect(req).toEqual({ before: 8, append: true });
    const asking = { ...empty, guildLog: { ...first, append: true } };
    const both = receiveGuild(asking, { t: 'guildLog', entries: [entry(8), entry(7)], more: false }).guildLog;
    expect(both?.entries.map((e) => e.id)).toEqual([9, 8, 7]);
    expect(both?.more).toBe(false);
    expect(logRequest(EMPTY_GUILD_LOG, true)).toEqual({ before: null, append: false });
  });

  it('stores the guild stash view and closes it on null', () => {
    const view = { tabs: [], items: [], tabPrice: null, unplaced: 0 };
    expect(receiveGuild(empty, { t: 'guildStash', stash: view }).guildStash).toBe(view);
    expect(receiveGuild(empty, { t: 'guildStash', stash: null }).guildStash).toBeNull();
  });
});

describe('roster buttons per rank', () => {
  const off = member(2, 'Off', 'officer');
  const mem = member(3, 'Mem', 'member');
  const lead = member(1, 'Lead', 'leader');

  it('gives the Leader every action on others', () => {
    expect(memberActions('leader', mem, false)).toEqual({ promote: true, demote: false, kick: true, transfer: true });
    expect(memberActions('leader', off, false)).toEqual({ promote: false, demote: true, kick: true, transfer: true });
  });

  it('lets an Officer kick Members only, and nothing else', () => {
    expect(memberActions('officer', mem, false)).toEqual({ promote: false, demote: false, kick: true, transfer: false });
    expect(memberActions('officer', off, false)).toEqual({ promote: false, demote: false, kick: false, transfer: false });
    expect(memberActions('officer', lead, false)).toEqual({ promote: false, demote: false, kick: false, transfer: false });
  });

  it('gives a Member no buttons, and nobody buttons on their own row', () => {
    for (const m of [lead, off, mem]) expect(Object.values(memberActions('member', m, false)).some(Boolean)).toBe(false);
    expect(Object.values(memberActions('leader', mem, true)).some(Boolean)).toBe(false);
  });

  it('lists the Leader first, then Officers, online before offline', () => {
    const rows = sortRoster([member(5, 'Zed', 'member', true), member(4, 'Abe', 'member', false), off, lead]);
    expect(rows.map((m) => m.name)).toEqual(['Lead', 'Off', 'Zed', 'Abe']);
  });
});

describe('founding form', () => {
  it('checks the name, then the tag, then the gold, with the shared rules', () => {
    expect(foundProblem('', '', 0, 1000)).toBeNull();
    expect(foundProblem('A', 'ASH', 5000, 1000)).toMatch(/Guild names are/);
    expect(foundProblem('Ashen Watch', 'A', 5000, 1000)).toMatch(/Tags are/);
    expect(foundProblem('Ashen Watch', 'GM', 5000, 1000)).toBe('That tag is reserved');
    expect(foundProblem('Ashen Watch', 'ASH', 200, 1000)).toBe('Founding costs 1000 gold; you have 200');
    expect(foundProblem('Ashen Watch', 'ASH', 1000, 1000)).toBeNull();
  });
});

describe('tags in names and chat', () => {
  it('puts the tag in brackets before the name', () => {
    expect(taggedName('Lead', 'ASH')).toBe('[ASH] Lead');
    expect(taggedName('Lead', undefined)).toBe('Lead');
  });

  it('splits a chat sender into tag and name, never tagging the server', () => {
    expect(chatWho({ kind: 'guild', from: 'Lead', to: null, tag: 'ASH' })).toEqual({ tag: 'ASH', name: 'Lead' });
    expect(chatWho({ kind: 'game', from: 'Lead', to: null })).toEqual({ tag: null, name: 'Lead' });
    expect(chatWho({ kind: 'whisper', from: 'Lead', to: 'Off', tag: 'ASH' })).toEqual({ tag: 'ASH', name: 'Lead to Off' });
    expect(chatWho({ kind: 'system', from: '', to: null, tag: 'ASH' }).tag).toBeNull();
  });
});

describe('player menu', () => {
  it('offers a guild invite only to ranks that invite, for someone not on the roster', () => {
    expect(playerMenuItems('Stranger', 'Lead', null, guild('leader'))).toEqual(['whisper', 'party', 'guild']);
    expect(playerMenuItems('Stranger', 'Mem', null, guild('member'))).toEqual(['whisper', 'party']);
    expect(playerMenuItems('off', 'Lead', null, guild('officer'))).toEqual(['whisper', 'party']);
    expect(playerMenuItems('Lead', 'lead', null, null)).toEqual([]);
    expect(playerMenuItems('Pal', 'Me', { leader: 'Me', members: [{ name: 'Pal', online: true }], hasWorld: false }, null)).toEqual(['whisper']);
  });

  it('names the other side of a whisper', () => {
    expect(chatPartner({ kind: 'whisper', from: 'Me', to: 'Pal' }, 'me')).toBe('Pal');
    expect(chatPartner({ kind: 'guild', from: 'Pal', to: null }, 'Me')).toBe('Pal');
    expect(chatPartner({ kind: 'system', from: '', to: null }, 'Me')).toBeNull();
  });
});
