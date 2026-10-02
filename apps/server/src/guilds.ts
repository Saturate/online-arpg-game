import {
  addItem,
  anchorOf,
  STASH,
  BAG,
  canPlace,
  canKick,
  changed,
  cleanMotd,
  cloneGuildStash,
  emptyGuildStash,
  GUILD,
  GUILD_LIMITS,
  GUILD_RANK_NAMES,
  guildCan,
  guildNameProblem,
  guildPlace,
  guildStashView,
  guildTab,
  guildTabPrice,
  guildTagProblem,
  guildTake,
  intoGuild,
  itemSize,
  locateGuildItem,
  nearStash,
  newGuildTab,
  normalisePerms,
  parseGuildStash,
  place,
  placeUnplaced,
  rankOrder,
  reissueUids,
  removeFrom,
  serializeGuildStash,
  settlePending,
  splitStash,
  stashRefuses,
  tabAccess,
  type AdminGuildDetail,
  type AdminGuildMember,
  type AdminGuildSummary,
  type ClientMessage,
  type EntityId,
  type GuildInfo,
  type GuildLogKind,
  type GuildMemberView,
  type GuildPower,
  type GuildRank,
  type GuildStash,
  type Item,
  type ItemUid,
  type ManagedRank,
  type PlayerComp,
  type ServerMessage,
  type StashColorId,
  type TabPerms,
} from '@rune/shared';
import type { AccountStore } from './accounts.js';
import type { Client } from './client.js';
import { events } from './eventLog.js';
import type { Room } from './room.js';
import { rollBackTrade, snapshotForTrade } from './tradeRollback.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A Leader away this long hands the guild on (owner, 2026-10-02). */
export const LEADER_IDLE_MS = 30 * DAY_MS;
/**
 * Stash moves a client may make per second. Each one writes the character and the whole guild stash
 * in one transaction, so a client clicking as fast as the socket allows must not stall every room.
 */
const STASH_OPS_PER_SECOND = 8;

interface Member {
  rank: GuildRank;
  joinedAt: number;
}

interface Guild {
  id: number;
  name: string;
  tag: string;
  motd: string;
  createdAt: number;
  members: Map<number, Member>;
  /** Null when the stored stash could not be read: then it is never written, and nobody uses it. */
  stash: GuildStash | null;
  /** Clients with the guild stash open, who get it again after every change. */
  viewers: Set<Client>;
}

/** What the guild service needs from the room manager. */
export interface GuildHost {
  /** Every connection; only those with a character in the world count as online. */
  clients(): Iterable<Client>;
  playerName(client: Client): string;
  /** Where a member is for the roster: the region, the town or the room. */
  zone(client: Client): string;
}

type Actor = { room: Room; pid: EntityId; p: PlayerComp };

/** Items as the log names them: "Fire Rune x12 (common, item level 3)". */
function itemLabel(item: Item): string {
  const count = item.kind === 'rune' && item.count > 1 ? ` x${item.count}` : '';
  return `${item.name}${count} (${item.tier}, item level ${item.ilvl}, uid ${item.uid})`;
}

/**
 * Guilds (docs/features/guilds.md). Membership, ranks, invites, guild chat and the guild stash live
 * here, beside the rooms rather than in one: every member, in any room or world copy, acts on the
 * same guild object. The game runs on one thread, so two members taking the same item land one
 * after the other; the second finds it gone.
 *
 * Every stash move is one SQLite transaction with the character involved (character, account stash
 * and guild stash rows together). The player's side changes first, in memory; if the write throws,
 * the player is put back exactly as they were and the guild stash in memory never changed. Only a
 * write that committed changes the guild in memory, so memory and the database always agree.
 */
export class GuildService {
  private readonly guilds = new Map<number, Guild>();
  private readonly byAccount = new Map<number, number>();
  /** Invited account to the guild and the inviting account. Kept in memory, like party invites. */
  private readonly invites = new Map<number, { guildId: number; from: number }>();
  private readonly opWindow = new WeakMap<Client, { start: number; n: number }>();

  constructor(
    private readonly store: AccountStore,
    private readonly host: GuildHost,
    private readonly clock: () => number = Date.now,
  ) {
    this.load();
  }

  private get db() {
    return this.store.guilds;
  }

  private load(): void {
    for (const row of this.db.loadAll()) {
      let stash: GuildStash | null = null;
      try {
        const loaded = parseGuildStash(JSON.parse(row.stashJson));
        stash = loaded.stash;
        for (const w of loaded.warnings) events.warn('save', `[guild] ${row.name} (${row.id}) stash: ${w}`);
        if (loaded.converted) {
          // Written back marked, so the rune roll pass runs once on this row. If that write fails the
          // converted stash is used anyway: the next move writes it, and until then a restart only
          // runs the same pass again on the same row.
          try {
            this.db.writeStash(row.id, JSON.stringify(serializeGuildStash(stash)));
            events.log('conversion', `[guild] ${row.name} (${row.id}) stash went through the rune roll pass: ${loaded.rolls?.runesRetiered.length ?? 0} runes retiered`);
          } catch (err) {
            events.error('save', `[guild] ${row.name} (${row.id}) stash went through the rune roll pass but could not be written back; the next move writes it`, err);
          }
        }
      } catch (err) {
        events.error('save', `[guild] ${row.name} (${row.id}) has an unreadable stash; it is kept as is and refused until someone looks at it`, err);
      }
      const g: Guild = { id: row.id, name: row.name, tag: row.tag, motd: row.motd, createdAt: row.createdAt, members: new Map(row.members.map((m) => [m.accountId, { rank: m.rank, joinedAt: m.joinedAt }])), stash, viewers: new Set() };
      this.guilds.set(g.id, g);
      for (const id of g.members.keys()) this.byAccount.set(id, g.id);
    }
  }

  // Lookups -----------------------------------------------------------------------------------

  guildOf(accountId: number | null): Guild | null {
    if (accountId === null) return null;
    const id = this.byAccount.get(accountId);
    return id === undefined ? null : (this.guilds.get(id) ?? null);
  }

  /** The tag on nameplates and chat lines, or null outside a guild. */
  tagOf(accountId: number | null): string | null {
    return this.guildOf(accountId)?.tag ?? null;
  }

  private online(): Map<number, Client> {
    const out = new Map<number, Client>();
    for (const c of this.host.clients()) if (c.accountId !== null && c.characterId !== null) out.set(c.accountId, c);
    return out;
  }

  private onlineMembers(g: Guild): Client[] {
    const online = this.online();
    return [...g.members.keys()].flatMap((id) => {
      const c = online.get(id);
      return c ? [c] : [];
    });
  }

  private actor(client: Client): Actor | null {
    const room = client.room;
    const m = room?.members.get(client.id);
    const p = m ? room?.sim.world.player.get(m.playerId) : undefined;
    return room && m && p ? { room, pid: m.playerId, p } : null;
  }

  private send(client: Client, msg: ServerMessage): void {
    client.send(msg);
  }

  private notice(client: Client, text: string): void {
    client.send({ t: 'notice', text });
  }

  private system(client: Client, text: string): void {
    client.send({ t: 'chat', kind: 'system', from: '', to: null, text });
  }

  // The roster -------------------------------------------------------------------------------

  private members(g: Guild): GuildMemberView[] {
    const ids = [...g.members.keys()];
    const chars = this.db.rosterCharacters(ids);
    const online = this.online();
    return ids
      .map((id): GuildMemberView => {
        const m = g.members.get(id) ?? { rank: 'member', joinedAt: 0 };
        const c = online.get(id);
        const live = c?.room?.memberView(c);
        const stored = chars.get(id);
        return {
          id,
          name: c && live ? this.host.playerName(c) : (stored?.name ?? '?'),
          rank: m.rank,
          cls: live?.cls ?? stored?.classId ?? null,
          level: live?.level ?? stored?.level ?? 0,
          online: c !== undefined,
          zone: c ? this.host.zone(c) : '',
          joinedAt: m.joinedAt,
        };
      })
      .sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  private info(g: Guild, rank: GuildRank, members: GuildMemberView[]): GuildInfo {
    return { id: g.id, name: g.name, tag: g.tag, motd: g.motd, rank, members, maxMembers: GUILD_LIMITS.maxMembers, createdAt: g.createdAt };
  }

  /** Every online member gets the guild again: a join, a leave, a rank or a message of the day changed. */
  private sendGuild(g: Guild): void {
    const members = this.members(g);
    for (const c of this.onlineMembers(g)) {
      const m = c.accountId === null ? undefined : g.members.get(c.accountId);
      if (m) this.send(c, { t: 'guild', guild: this.info(g, m.rank, members), foundPrice: GUILD.foundPrice });
    }
  }

  private sendTo(client: Client): void {
    const g = this.guildOf(client.accountId);
    const m = g && client.accountId !== null ? g.members.get(client.accountId) : undefined;
    this.send(client, { t: 'guild', guild: g && m ? this.info(g, m.rank, this.members(g)) : null, foundPrice: GUILD.foundPrice });
  }

  // Entering and leaving the game ----------------------------------------------------------------

  /** A character entered the world: its guild, the message of the day, and the others see it online. */
  joined(client: Client): void {
    const g = this.guildOf(client.accountId);
    if (!g) {
      this.sendTo(client);
      return;
    }
    this.sendGuild(g);
    if (g.motd) client.send({ t: 'chat', kind: 'guild', from: '', to: null, text: `Message of the day: ${g.motd}` });
  }

  /**
   * A client left the world (logout, disconnect, another window). Called once the client no longer
   * counts as online, with the account it had, so the others' rosters show it offline.
   */
  left(client: Client, accountId: number | null): void {
    for (const g of this.guilds.values()) g.viewers.delete(client);
    const g = this.guildOf(accountId);
    if (g) this.sendGuild(g);
  }

  // Messages ---------------------------------------------------------------------------------

  /** Handles a guild message; false for anything else. */
  handle(client: Client, msg: ClientMessage): boolean {
    switch (msg.t) {
      case 'guildCreate':
        this.found(client, msg.name, msg.tag);
        return true;
      case 'guildInvite':
        this.invite(client, msg.name);
        return true;
      case 'guildAnswer':
        this.answer(client, msg.accept);
        return true;
      case 'guildLeave':
        this.leave(client);
        return true;
      case 'guildKick':
        this.kick(client, msg.member);
        return true;
      case 'guildPromote':
        this.setRank(client, msg.member, 'officer');
        return true;
      case 'guildDemote':
        this.setRank(client, msg.member, 'member');
        return true;
      case 'guildTransfer':
        this.transfer(client, msg.member);
        return true;
      case 'guildDisband':
        this.disband(client);
        return true;
      case 'guildMotd':
        this.setMotd(client, msg.text);
        return true;
      case 'guildRefresh':
        // The roster reads every member's last save, so one window asking every 5 s is plenty.
        if (this.allowRefresh(client)) this.sendTo(client);
        return true;
      case 'guildLog':
        this.sendLog(client, msg.before);
        return true;
      case 'guildStashOpen':
        this.openStash(client);
        return true;
      case 'guildStashClose':
        for (const g of this.guilds.values()) g.viewers.delete(client);
        return true;
      case 'guildDeposit':
        this.deposit(client, msg.uid, msg.tab, msg.at);
        return true;
      case 'guildWithdraw':
        this.withdraw(client, msg.uid, msg.at);
        return true;
      case 'guildMove':
        this.move(client, msg.uid, msg.tab, msg.at);
        return true;
      case 'guildBuyTab':
        this.buyTab(client);
        return true;
      case 'guildEditTab':
        this.editTab(client, msg.tab, msg.name, msg.color);
        return true;
      case 'guildTabPerms':
        this.setPerms(client, msg.tab, msg.rank, msg.perms);
        return true;
      default:
        return false;
    }
  }

  /** `/g message`: to every online member, wherever they are. */
  chat(client: Client, text: string, items: { items?: Item[] }): void {
    const g = this.guildOf(client.accountId);
    if (!g) return this.system(client, 'You are not in a guild');
    const from = this.host.playerName(client);
    for (const c of this.onlineMembers(g)) c.send({ t: 'chat', kind: 'guild', from, to: null, text, tag: g.tag, ...items });
  }

  // Founding, invites and membership -----------------------------------------------------------

  private found(client: Client, name: string, tag: string): void {
    const me = client.accountId;
    const a = this.actor(client);
    if (me === null || !a) return;
    if (this.guildOf(me)) return this.notice(client, 'Leave your guild first');
    const bad = guildNameProblem(name) ?? guildTagProblem(tag);
    if (bad) return this.notice(client, bad);
    const taken = this.db.nameOrTagTaken(name, tag);
    if (taken) return this.notice(client, taken === 'name' ? 'That guild name is taken' : 'That tag is taken');
    const price = GUILD.foundPrice;
    if (a.p.gold < price) return this.notice(client, `Founding a guild costs ${price} gold`);
    const stash = emptyGuildStash();
    const now = this.clock();
    const actor = this.host.playerName(client);
    const before = snapshotForTrade(a.p);
    a.p.gold -= price;
    changed(a.p);
    let id = 0;
    try {
      this.saveWith(client, () => {
        id = this.db.insertGuild(name, tag, now, JSON.stringify(serializeGuildStash(stash)));
        this.db.addMember(id, me, 'leader', now);
        this.db.addLog(id, 'found', actor, me, `${actor} founded ${name} [${tag}] for ${price} gold`, now);
      });
    } catch (err) {
      rollBackTrade(a.p, before);
      events.error('save', `[guild] founding ${name} [${tag}] by ${client.accountName} not saved; rolled back`, err);
      // A UNIQUE column refusing means someone took the name or tag a moment ago.
      return this.notice(client, this.db.nameOrTagTaken(name, tag) ? 'That guild name or tag was just taken' : 'The guild could not be saved, so nothing changed');
    }
    const g: Guild = { id, name, tag, motd: '', createdAt: now, members: new Map([[me, { rank: 'leader', joinedAt: now }]]), stash, viewers: new Set() };
    this.guilds.set(id, g);
    this.byAccount.set(me, id);
    this.invites.delete(me);
    events.log('server', `[guild] ${actor} (${client.accountName}) founded ${name} [${tag}] (${id}) for ${price} gold`);
    this.sendGuild(g);
    this.system(client, `You founded ${name} [${tag}]. Press G for the guild window.`);
  }

  private invite(client: Client, name: string): void {
    const g = this.guildOf(client.accountId);
    const me = client.accountId;
    const rank = g && me !== null ? g.members.get(me)?.rank : undefined;
    if (!g || me === null || !rank) return this.system(client, 'You are not in a guild');
    if (!guildCan(rank, 'invite')) return this.system(client, 'Only the Leader and Officers can invite');
    const wanted = name.trim().toLowerCase();
    const target = [...this.host.clients()].find((c) => c.characterId !== null && this.host.playerName(c).toLowerCase() === wanted);
    if (!target || target.accountId === null) return this.system(client, `${name} is not online`);
    if (target.accountId === me) return this.system(client, 'You cannot invite yourself');
    if (this.guildOf(target.accountId)) return this.system(client, `${this.host.playerName(target)} is already in a guild`);
    if (g.members.size >= GUILD_LIMITS.maxMembers) return this.system(client, `Your guild is full (${GUILD_LIMITS.maxMembers})`);
    this.invites.set(target.accountId, { guildId: g.id, from: me });
    target.send({ t: 'guildInvite', from: this.host.playerName(client), guild: g.name, tag: g.tag });
    this.system(client, `Invited ${this.host.playerName(target)} to ${g.name}`);
  }

  private answer(client: Client, accept: boolean): void {
    const me = client.accountId;
    if (me === null) return;
    const inv = this.invites.get(me);
    this.invites.delete(me);
    const g = inv ? this.guilds.get(inv.guildId) : undefined;
    if (!inv || !g) return this.system(client, 'That guild invite is no longer open');
    const inviter = this.online().get(inv.from);
    const who = this.host.playerName(client);
    if (!accept) {
      if (inviter) this.system(inviter, `${who} declined your guild invite`);
      return;
    }
    if (this.guildOf(me)) return this.system(client, 'Leave your guild first');
    if (g.members.size >= GUILD_LIMITS.maxMembers) return this.system(client, `${g.name} is full`);
    const now = this.clock();
    const by = inviter ? this.host.playerName(inviter) : 'an Officer';
    try {
      this.db.tx(() => {
        this.db.addMember(g.id, me, 'member', now);
        this.db.addLog(g.id, 'join', who, me, `${who} joined (invited by ${by})`, now);
      });
    } catch (err) {
      events.error('save', `[guild] ${who} joining ${g.name} not saved`, err);
      return this.system(client, 'Joining the guild could not be saved; try again');
    }
    g.members.set(me, { rank: 'member', joinedAt: now });
    this.byAccount.set(me, g.id);
    for (const c of this.onlineMembers(g)) if (c !== client) this.system(c, `${who} joined the guild`);
    this.system(client, `You joined ${g.name} [${g.tag}]. Press G for the guild window.`);
    this.sendGuild(g);
    if (g.motd) client.send({ t: 'chat', kind: 'guild', from: '', to: null, text: `Message of the day: ${g.motd}` });
  }

  /** Takes an account out of its guild in memory and tells it; the rows are gone already. */
  private dropMember(g: Guild, accountId: number): void {
    g.members.delete(accountId);
    this.byAccount.delete(accountId);
    const c = this.online().get(accountId);
    if (c) {
      g.viewers.delete(c);
      c.send({ t: 'guildStash', stash: null });
      this.sendTo(c);
    }
  }

  private leave(client: Client): void {
    const me = client.accountId;
    const g = this.guildOf(me);
    const m = g && me !== null ? g.members.get(me) : undefined;
    if (!g || me === null || !m) return this.system(client, 'You are not in a guild');
    if (m.rank === 'leader') {
      return this.system(client, g.members.size === 1 ? 'You are the last member: disband the guild instead (its stash must be empty)' : 'Hand leadership to another member first, or disband the guild');
    }
    const who = this.host.playerName(client);
    const now = this.clock();
    try {
      this.db.tx(() => {
        this.db.removeMember(me);
        this.db.addLog(g.id, 'leave', who, me, `${who} left`, now);
      });
    } catch (err) {
      events.error('save', `[guild] ${who} leaving ${g.name} not saved`, err);
      return this.system(client, 'Leaving could not be saved; try again');
    }
    this.dropMember(g, me);
    this.system(client, `You left ${g.name}`);
    for (const c of this.onlineMembers(g)) this.system(c, `${who} left the guild`);
    this.sendGuild(g);
  }

  /** The acting member: in a guild, with this power, or null after telling them why not. */
  private officer(client: Client, power: GuildPower, refusal: string): { g: Guild; me: number; rank: GuildRank } | null {
    const me = client.accountId;
    const g = this.guildOf(me);
    const rank = g && me !== null ? g.members.get(me)?.rank : undefined;
    if (!g || me === null || !rank) {
      this.system(client, 'You are not in a guild');
      return null;
    }
    if (!guildCan(rank, power)) {
      this.system(client, refusal);
      return null;
    }
    return { g, me, rank };
  }

  private memberName(accountId: number): string {
    const c = this.online().get(accountId);
    return c ? this.host.playerName(c) : (this.db.rosterCharacters([accountId]).get(accountId)?.name ?? 'someone');
  }

  private kick(client: Client, target: number): void {
    const who = this.officer(client, 'kick', 'Only the Leader and Officers can remove members');
    if (!who) return;
    const { g, me, rank } = who;
    const t = g.members.get(target);
    if (!t) return this.system(client, 'That player is not in your guild');
    if (target === me) return this.system(client, 'Leave the guild instead');
    if (t.rank === 'leader') return this.system(client, 'The Leader cannot be removed');
    if (!canKick(rank, t.rank)) return this.system(client, 'Only the Leader can remove an Officer');
    const actor = this.host.playerName(client);
    const name = this.memberName(target);
    const now = this.clock();
    try {
      this.db.tx(() => {
        this.db.removeMember(target);
        this.db.addLog(g.id, 'kick', actor, me, `${actor} removed ${name}`, now);
      });
    } catch (err) {
      events.error('save', `[guild] ${actor} removing ${name} from ${g.name} not saved`, err);
      return this.system(client, 'That could not be saved; try again');
    }
    const kicked = this.online().get(target);
    this.dropMember(g, target);
    if (kicked) this.system(kicked, `You were removed from ${g.name}`);
    for (const c of this.onlineMembers(g)) this.system(c, `${actor} removed ${name} from the guild`);
    this.sendGuild(g);
  }

  private setRank(client: Client, target: number, rank: 'officer' | 'member'): void {
    const who = this.officer(client, rank === 'officer' ? 'promote' : 'demote', `Only the Leader ${rank === 'officer' ? 'promotes' : 'demotes'} members`);
    if (!who) return;
    const { g, me } = who;
    const t = g.members.get(target);
    if (!t) return this.system(client, 'That player is not in your guild');
    if (t.rank === 'leader') return this.system(client, 'Hand leadership on to change your own rank');
    if (t.rank === rank) return this.system(client, `${this.memberName(target)} is already ${rank === 'officer' ? 'an Officer' : 'a Member'}`);
    const actor = this.host.playerName(client);
    const name = this.memberName(target);
    const now = this.clock();
    const text = `${actor} made ${name} ${rank === 'officer' ? 'an Officer' : 'a Member'}`;
    try {
      this.db.tx(() => {
        this.db.setRank(target, rank);
        this.db.addLog(g.id, 'rank', actor, me, text, now);
      });
    } catch (err) {
      events.error('save', `[guild] ${text} in ${g.name} not saved`, err);
      return this.system(client, 'That could not be saved; try again');
    }
    t.rank = rank;
    this.refreshViewer(g, target);
    for (const c of this.onlineMembers(g)) this.system(c, text);
    this.sendGuild(g);
  }

  private transfer(client: Client, target: number): void {
    const who = this.officer(client, 'transfer', 'Only the Leader hands leadership on');
    if (!who) return;
    const { g, me } = who;
    const t = g.members.get(target);
    const mine = g.members.get(me);
    if (!t || !mine) return this.system(client, 'That player is not in your guild');
    if (target === me) return this.system(client, 'You lead the guild already');
    const actor = this.host.playerName(client);
    const name = this.memberName(target);
    const now = this.clock();
    const text = `${actor} handed leadership to ${name}`;
    try {
      this.db.tx(() => {
        this.db.setRank(me, 'officer');
        this.db.setRank(target, 'leader');
        this.db.addLog(g.id, 'leader', actor, me, text, now);
      });
    } catch (err) {
      events.error('save', `[guild] ${text} in ${g.name} not saved`, err);
      return this.system(client, 'That could not be saved; try again');
    }
    mine.rank = 'officer';
    t.rank = 'leader';
    this.refreshViewer(g, me);
    this.refreshViewer(g, target);
    for (const c of this.onlineMembers(g)) this.system(c, text);
    this.sendGuild(g);
  }

  private disband(client: Client): void {
    const who = this.officer(client, 'disband', 'Only the Leader can disband the guild');
    if (!who) return;
    const { g } = who;
    if (!g.stash) return this.system(client, 'The guild stash could not be loaded; ask the server owner to look at it before disbanding');
    // Nothing may be lost: the Leader hands everything out first (owner, 2026-10-02).
    if (g.stash.items.size > 0) return this.system(client, `Empty the guild stash first: it still holds ${g.stash.items.size} item${g.stash.items.size === 1 ? '' : 's'}`);
    const actor = this.host.playerName(client);
    try {
      this.db.tx(() => this.db.deleteGuild(g.id));
    } catch (err) {
      events.error('save', `[guild] disbanding ${g.name} not saved`, err);
      return this.system(client, 'That could not be saved; try again');
    }
    const online = this.onlineMembers(g);
    this.guilds.delete(g.id);
    for (const id of g.members.keys()) this.byAccount.delete(id);
    for (const [acc, inv] of this.invites) if (inv.guildId === g.id) this.invites.delete(acc);
    for (const c of g.viewers) c.send({ t: 'guildStash', stash: null });
    g.viewers.clear();
    events.log('server', `[guild] ${actor} (${client.accountName}) disbanded ${g.name} [${g.tag}] (${g.id}), ${g.members.size} members`);
    for (const c of online) {
      this.system(c, `${actor} disbanded ${g.name}`);
      this.sendTo(c);
    }
  }

  private setMotd(client: Client, raw: string): void {
    const who = this.officer(client, 'motd', 'Only the Leader and Officers set the message of the day');
    if (!who) return;
    const { g, me } = who;
    const motd = cleanMotd(raw) ?? '';
    if (motd === g.motd) return;
    const actor = this.host.playerName(client);
    const now = this.clock();
    try {
      this.db.tx(() => {
        this.db.setMotd(g.id, motd);
        this.db.addLog(g.id, 'motd', actor, me, motd ? `${actor} set the message of the day: ${motd}` : `${actor} cleared the message of the day`, now);
      });
    } catch (err) {
      events.error('save', `[guild] message of the day for ${g.name} not saved`, err);
      return this.system(client, 'That could not be saved; try again');
    }
    g.motd = motd;
    this.sendGuild(g);
  }

  private sendLog(client: Client, before: number | null): void {
    const g = this.guildOf(client.accountId);
    if (!g) return this.system(client, 'You are not in a guild');
    const page = this.db.log(g.id, before, GUILD_LIMITS.logPage);
    client.send({ t: 'guildLog', entries: page.entries, more: page.more });
  }

  // The guild stash ----------------------------------------------------------------------------

  private readonly lastRefresh = new WeakMap<Client, number>();

  private allowRefresh(client: Client): boolean {
    const now = this.clock();
    if (now - (this.lastRefresh.get(client) ?? -Infinity) < 1000) return false;
    this.lastRefresh.set(client, now);
    return true;
  }

  private allowOp(client: Client): boolean {
    const now = this.clock();
    const w = this.opWindow.get(client);
    if (!w || now - w.start >= 1000) {
      this.opWindow.set(client, { start: now, n: 1 });
      return true;
    }
    return ++w.n <= STASH_OPS_PER_SECOND;
  }

  /**
   * Everything a stash move needs, or null after telling the player why not: in a guild whose stash
   * loaded, in a room, at the stash chest.
   */
  private stashContext(client: Client, chest = true): { g: Guild; stash: GuildStash; me: number; rank: GuildRank; a: Actor } | null {
    const me = client.accountId;
    const g = this.guildOf(me);
    const rank = g && me !== null ? g.members.get(me)?.rank : undefined;
    const a = this.actor(client);
    if (!g || me === null || !rank) {
      this.notice(client, 'You are not in a guild');
      client.send({ t: 'guildStash', stash: null });
      return null;
    }
    if (!g.stash) {
      this.notice(client, 'The guild stash could not be loaded. Nothing was lost; ask the server owner to look at it.');
      return null;
    }
    if (!a) return null;
    if (chest && !nearStash(a.room.sim, a.pid)) {
      this.notice(client, 'Stand at the stash to use it');
      return null;
    }
    return { g, stash: g.stash, me, rank, a };
  }

  private view(g: Guild, stash: GuildStash, accountId: number): ServerMessage | null {
    const m = g.members.get(accountId);
    return m ? { t: 'guildStash', stash: guildStashView(stash, m.rank, guildTabPrice(stash.tabs.length)) } : null;
  }

  private openStash(client: Client): void {
    const ctx = this.stashContext(client);
    if (!ctx) return;
    ctx.g.viewers.add(client);
    const v = this.view(ctx.g, ctx.stash, ctx.me);
    if (v) client.send(v);
  }

  /** After a change: everyone with the stash open sees it as it is now, as their rank may. */
  private refreshViewers(g: Guild): void {
    if (!g.stash) return;
    for (const c of g.viewers) {
      const v = c.accountId === null ? null : this.view(g, g.stash, c.accountId);
      if (v) c.send(v);
      else g.viewers.delete(c);
    }
  }

  /** A rank change shows a member other tabs. */
  private refreshViewer(g: Guild, accountId: number): void {
    if (!g.stash) return;
    for (const c of g.viewers) {
      if (c.accountId !== accountId) continue;
      const v = this.view(g, g.stash, accountId);
      if (v) c.send(v);
    }
  }

  /** The character, its account stash and the guild rows, in one transaction. Throws on failure. */
  private saveWith(client: Client, extra: () => void): void {
    const save = client.room?.exportMember(client);
    if (!save || client.characterId === null || client.accountId === null) throw new Error('no character to save');
    const { character, stash } = splitStash(save);
    this.store.saveCharacterWith(client.characterId, character, client.accountId, stash, extra);
  }

  /** The new guild stash and its log row, written by whoever opened the transaction. */
  private writeStash(g: Guild, next: GuildStash, log: { kind: GuildLogKind; actor: string; accountId: number; text: string } | null): void {
    this.db.writeStash(g.id, JSON.stringify(serializeGuildStash(next)));
    if (log) this.db.addLog(g.id, log.kind, log.actor, log.accountId, log.text, this.clock());
  }

  private deposit(client: Client, uid: ItemUid, tabId: number, at: { x: number; y: number } | null): void {
    if (!this.allowOp(client)) return;
    const ctx = this.stashContext(client);
    if (!ctx) return;
    const { g, stash, me, rank, a } = ctx;
    const tab = guildTab(stash, tabId);
    if (!tab) return this.notice(client, 'No such guild tab');
    if (!tabAccess(tab, rank).deposit) return this.notice(client, `Your rank cannot put items into ${tab.name}`);
    const item = a.p.items.get(uid);
    if (!item || !a.p.inventory.includes(uid)) return this.notice(client, 'Only items in your bag go into the guild stash');
    // Bound items stay with their character, as in the account stash: a new character must not farm
    // its starter kit for another account.
    const refused = stashRefuses(item);
    if (refused) return this.notice(client, refused);
    const next = cloneGuildStash(stash);
    const copy = intoGuild(next, item);
    const placeError = guildPlace(next, tabId, copy, at);
    if (placeError) return this.notice(client, placeError);
    const actor = this.host.playerName(client);
    const before = snapshotForTrade(a.p);
    removeFrom(a.p.inventory, uid);
    a.p.items.delete(uid);
    settlePending(a.p);
    changed(a.p);
    try {
      this.saveWith(client, () => this.writeStash(g, next, { kind: 'deposit', actor, accountId: me, text: `${actor} put ${itemLabel(copy)} into ${tab.name}` }));
    } catch (err) {
      rollBackTrade(a.p, before);
      events.error('save', `[guild] deposit by ${client.accountName} into ${g.name} not saved; rolled back`, err);
      return this.notice(client, 'That could not be saved, so nothing moved');
    }
    g.stash = next;
    events.log('server', `[guild] ${actor} (${client.accountName}) deposit into ${g.name} (${g.id}) ${tab.name}: ${item.name}, bag uid ${uid} -> guild uid ${copy.uid}`);
    this.refreshViewers(g);
  }

  private withdraw(client: Client, uid: ItemUid, at: { x: number; y: number } | null): void {
    if (!this.allowOp(client)) return;
    const ctx = this.stashContext(client);
    if (!ctx) return;
    const { g, stash, me, rank, a } = ctx;
    const item = stash.items.get(uid);
    const tab = locateGuildItem(stash, uid);
    if (!item || !tab) {
      // Another member took it first, or the window was a step behind.
      this.notice(client, 'Someone else took it');
      return this.refreshViewers(g);
    }
    const access = tabAccess(tab, rank);
    if (!access.withdraw) return this.notice(client, `Your rank cannot take items from ${tab.name}`);
    // Fresh uids from this room, as every item arriving from storage gets; the guild keeps none of its own on it.
    const copy = reissueUids(item, () => a.room.sim.newItemUid());
    const before = snapshotForTrade(a.p);
    if (at) {
      const size = itemSize(copy);
      if (!canPlace(a.p.inventory, BAG, size, at.x, at.y)) return this.notice(client, 'No room there');
      a.p.items.set(copy.uid, copy);
      place(a.p.inventory, BAG, copy.uid, size, at.x, at.y);
      changed(a.p);
    } else if (!addItem(a.p, copy)) return this.notice(client, 'No room in your bag');
    const next = cloneGuildStash(stash);
    guildTake(next, uid);
    placeUnplaced(next);
    const actor = this.host.playerName(client);
    try {
      this.saveWith(client, () => this.writeStash(g, next, { kind: 'withdraw', actor, accountId: me, text: `${actor} took ${itemLabel(item)} from ${tab.name}` }));
    } catch (err) {
      rollBackTrade(a.p, before);
      events.error('save', `[guild] withdrawal by ${client.accountName} from ${g.name} not saved; rolled back`, err);
      return this.notice(client, 'That could not be saved, so nothing moved');
    }
    g.stash = next;
    events.log('server', `[guild] ${actor} (${client.accountName}) withdrawal from ${g.name} (${g.id}) ${tab.name}: ${item.name}, guild uid ${uid} -> bag uid ${copy.uid}`);
    this.refreshViewers(g);
  }

  /** Inside the guild stash: needs withdraw on the tab it leaves and deposit on the tab it enters. */
  private move(client: Client, uid: ItemUid, tabId: number, at: { x: number; y: number }): void {
    if (!this.allowOp(client)) return;
    const ctx = this.stashContext(client);
    if (!ctx) return;
    const { g, stash, me, rank } = ctx;
    const item = stash.items.get(uid);
    const from = locateGuildItem(stash, uid);
    const to = guildTab(stash, tabId);
    if (!item || !from) {
      this.notice(client, 'Someone else took it');
      return this.refreshViewers(g);
    }
    if (!to) return this.notice(client, 'No such guild tab');
    if (from.id !== to.id && !tabAccess(from, rank).withdraw) return this.notice(client, `Your rank cannot take items from ${from.name}`);
    if (!tabAccess(to, rank).deposit) return this.notice(client, `Your rank cannot put items into ${to.name}`);
    if (from.id === to.id && anchorOf(from.cells, STASH, uid)?.x === at.x && anchorOf(from.cells, STASH, uid)?.y === at.y) return;
    const next = cloneGuildStash(stash);
    const error = guildPlace(next, tabId, item, at);
    if (error) return this.notice(client, error);
    placeUnplaced(next);
    const actor = this.host.playerName(client);
    // Moves inside one tab are tidying and stay out of the log; between tabs they say where things went.
    const log = from.id === to.id ? null : { kind: 'move' as const, actor, accountId: me, text: `${actor} moved ${itemLabel(item)} from ${from.name} to ${to.name}` };
    try {
      this.db.tx(() => this.writeStash(g, next, log));
    } catch (err) {
      events.error('save', `[guild] move in ${g.name} not saved`, err);
      return this.notice(client, 'That could not be saved, so nothing moved');
    }
    g.stash = next;
    this.refreshViewers(g);
  }

  private buyTab(client: Client): void {
    if (!this.allowOp(client)) return;
    const ctx = this.stashContext(client);
    if (!ctx) return;
    const { g, stash, me, rank, a } = ctx;
    if (!guildCan(rank, 'manageTabs')) return this.notice(client, 'Only the Leader and Officers buy guild tabs');
    const price = guildTabPrice(stash.tabs.length);
    if (price === null) return this.notice(client, `Your guild owns all ${GUILD.maxTabs} tabs it can`);
    if (a.p.gold < price) return this.notice(client, `A new guild tab costs ${price} gold`);
    const id = Math.max(0, ...stash.tabs.map((t) => t.id)) + 1;
    if (id > GUILD_LIMITS.tabIdMax) return this.notice(client, 'Your guild owns all the tabs it can');
    const next = cloneGuildStash(stash);
    next.tabs.push(newGuildTab(id));
    placeUnplaced(next);
    const actor = this.host.playerName(client);
    const before = snapshotForTrade(a.p);
    a.p.gold -= price;
    changed(a.p);
    try {
      this.saveWith(client, () => this.writeStash(g, next, { kind: 'tab', actor, accountId: me, text: `${actor} bought tab ${id} for ${price} gold` }));
    } catch (err) {
      rollBackTrade(a.p, before);
      events.error('save', `[guild] tab purchase by ${client.accountName} for ${g.name} not saved; rolled back`, err);
      return this.notice(client, 'That could not be saved, so nothing changed');
    }
    g.stash = next;
    this.refreshViewers(g);
  }

  private editTab(client: Client, tabId: number, name: string, color: StashColorId): void {
    if (!this.allowOp(client)) return;
    const ctx = this.stashContext(client, false);
    if (!ctx) return;
    const { g, stash, me, rank } = ctx;
    if (!guildCan(rank, 'manageTabs')) return this.notice(client, 'Only the Leader and Officers manage guild tabs');
    const tab = guildTab(stash, tabId);
    if (!tab) return this.notice(client, 'No such guild tab');
    if (tab.name === name && tab.color === color) return;
    const next = cloneGuildStash(stash);
    const t = guildTab(next, tabId);
    if (!t) return;
    t.name = name;
    t.color = color;
    const actor = this.host.playerName(client);
    const text = tab.name === name ? `${actor} recoloured ${name}` : `${actor} renamed ${tab.name} to ${name}`;
    try {
      this.db.tx(() => this.writeStash(g, next, { kind: 'tab', actor, accountId: me, text }));
    } catch (err) {
      events.error('save', `[guild] tab edit in ${g.name} not saved`, err);
      return this.notice(client, 'That could not be saved, so nothing changed');
    }
    g.stash = next;
    this.refreshViewers(g);
  }

  private setPerms(client: Client, tabId: number, target: ManagedRank, perms: TabPerms): void {
    if (!this.allowOp(client)) return;
    const ctx = this.stashContext(client, false);
    if (!ctx) return;
    const { g, stash, me, rank } = ctx;
    if (!guildCan(rank, 'manageTabs')) return this.notice(client, 'Only the Leader and Officers set tab permissions');
    const tab = guildTab(stash, tabId);
    if (!tab) return this.notice(client, 'No such guild tab');
    const want = normalisePerms(perms);
    const was = tab.perms[target];
    if (was.view === want.view && was.deposit === want.deposit && was.withdraw === want.withdraw) return;
    const next = cloneGuildStash(stash);
    const t = guildTab(next, tabId);
    if (!t) return;
    t.perms[target] = want;
    const actor = this.host.playerName(client);
    const list = (p: TabPerms): string => [p.view ? 'view' : '', p.deposit ? 'deposit' : '', p.withdraw ? 'withdraw' : ''].filter(Boolean).join(', ') || 'nothing';
    const text = `${actor} set ${GUILD_RANK_NAMES[target]}s in ${tab.name} to ${list(want)} (was ${list(was)})`;
    try {
      this.db.tx(() => this.writeStash(g, next, { kind: 'tab', actor, accountId: me, text }));
    } catch (err) {
      events.error('save', `[guild] tab permissions in ${g.name} not saved`, err);
      return this.notice(client, 'That could not be saved, so nothing changed');
    }
    g.stash = next;
    this.refreshViewers(g);
  }

  // Leadership --------------------------------------------------------------------------------

  /**
   * On boot and once a day: a guild whose Leader's account is gone, or who has not logged in for 30
   * days, passes to the longest-serving Officer, else the longest-serving Member (owner, 2026-10-02).
   * The old Leader, if still a member, becomes an Officer. Members are read again first, since an
   * account deletion removes its row behind this service's back. Returns how many guilds changed.
   */
  checkLeadership(): number {
    const now = this.clock();
    const online = this.online();
    let changedCount = 0;
    for (const g of [...this.guilds.values()]) {
      const rows = this.db.members(g.id);
      for (const id of g.members.keys()) if (!rows.some((r) => r.accountId === id)) this.byAccount.delete(id);
      g.members = new Map(rows.map((r) => [r.accountId, { rank: r.rank, joinedAt: r.joinedAt }]));
      for (const id of g.members.keys()) this.byAccount.set(id, g.id);
      const leader = [...g.members].find(([, m]) => m.rank === 'leader')?.[0];
      let reason: string | null = null;
      if (leader === undefined) reason = 'the Leader is gone';
      else if (!online.has(leader)) {
        const last = this.db.lastActive([leader]).get(leader) ?? 0;
        if (now - last >= LEADER_IDLE_MS) reason = `${this.memberName(leader)} had not logged in for ${Math.floor((now - last) / DAY_MS)} days`;
      }
      if (reason === null) continue;
      const pick = (rank: GuildRank): number | undefined =>
        [...g.members]
          .filter(([id, m]) => m.rank === rank && id !== leader)
          .sort(([ia, a], [ib, b]) => a.joinedAt - b.joinedAt || ia - ib)
          .map(([id]) => id)[0];
      const next = pick('officer') ?? pick('member');
      if (next === undefined) {
        // Nobody left to take it: the stash can only be reached once an admin names a Leader.
        if (g.members.size === 0) events.error('server', `[guild] ${g.name} (${g.id}) has no members left${g.stash && g.stash.items.size > 0 ? ` and ${g.stash.items.size} items in its stash` : ''}; an admin can name a Leader once someone joins, or look at the row`);
        continue;
      }
      const name = this.memberName(next);
      const text = `Leadership passed to ${name}: ${reason}`;
      try {
        this.db.tx(() => {
          if (leader !== undefined) this.db.setRank(leader, 'officer');
          this.db.setRank(next, 'leader');
          this.db.addLog(g.id, 'leader', '', null, text, now);
        });
      } catch (err) {
        events.error('save', `[guild] leadership handover in ${g.name} not saved`, err);
        continue;
      }
      const old = leader === undefined ? undefined : g.members.get(leader);
      if (old) old.rank = 'officer';
      const nm = g.members.get(next);
      if (nm) nm.rank = 'leader';
      events.log('server', `[guild] ${g.name} (${g.id}): ${text}`);
      changedCount++;
      for (const c of this.onlineMembers(g)) this.system(c, text);
      this.sendGuild(g);
    }
    for (const [acc, id] of this.byAccount) if (!this.guilds.get(id)?.members.has(acc)) this.byAccount.delete(acc);
    return changedCount;
  }

  // Admin -------------------------------------------------------------------------------------

  private summary(g: Guild): AdminGuildSummary {
    const leaderId = [...g.members].find(([, m]) => m.rank === 'leader')?.[0];
    const leader =
      leaderId === undefined
        ? null
        : { accountId: leaderId, username: this.db.usernames([leaderId]).get(leaderId) ?? '?', character: this.db.rosterCharacters([leaderId]).get(leaderId)?.name ?? null };
    return { id: g.id, name: g.name, tag: g.tag, createdAt: g.createdAt, members: g.members.size, leader, tabs: g.stash?.tabs.length ?? 0, items: g.stash?.items.size ?? 0, stashReadable: g.stash !== null };
  }

  adminList(): AdminGuildSummary[] {
    return [...this.guilds.values()].map((g) => this.summary(g));
  }

  adminDetail(id: number, before: number | null = null): AdminGuildDetail | null {
    const g = this.guilds.get(id);
    if (!g) return null;
    const ids = [...g.members.keys()];
    const names = this.db.usernames(ids);
    const chars = this.db.rosterCharacters(ids);
    const last = this.db.lastActive(ids);
    const online = this.online();
    const roster: AdminGuildMember[] = ids
      .map((acc) => {
        const m = g.members.get(acc) ?? { rank: 'member', joinedAt: 0 };
        const ch = chars.get(acc);
        return { accountId: acc, username: names.get(acc) ?? '?', rank: m.rank, joinedAt: m.joinedAt, character: ch?.name ?? null, classId: ch?.classId ?? null, level: ch?.level ?? 0, lastActive: last.get(acc) ?? 0, online: online.has(acc) };
      })
      .sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || a.joinedAt - b.joinedAt);
    const tabList = (g.stash?.tabs ?? []).map((t) => ({ id: t.id, name: t.name, items: new Set(t.cells.filter((c) => c !== null)).size }));
    const page = this.db.log(g.id, before, GUILD_LIMITS.logPage);
    return { ...this.summary(g), motd: g.motd, roster, tabList, log: page.entries, moreLog: page.more };
  }

  /**
   * An admin makes a member the Leader; the old Leader, if any, becomes an Officer. Returns why not,
   * or null.
   */
  adminSetLeader(id: number, accountId: number, by: string): string | null {
    const g = this.guilds.get(id);
    if (!g) return 'No such guild';
    const t = g.members.get(accountId);
    if (!t) return 'That account is not in the guild';
    if (t.rank === 'leader') return 'That account leads the guild already';
    const leader = [...g.members].find(([, m]) => m.rank === 'leader')?.[0];
    const name = this.memberName(accountId);
    const text = `An admin made ${name} the Leader`;
    const now = this.clock();
    this.db.tx(() => {
      if (leader !== undefined) this.db.setRank(leader, 'officer');
      this.db.setRank(accountId, 'leader');
      this.db.addLog(g.id, 'leader', '', null, text, now);
    });
    const old = leader === undefined ? undefined : g.members.get(leader);
    if (old) old.rank = 'officer';
    t.rank = 'leader';
    events.log('server', `[guild] ${g.name} (${g.id}): ${by} made ${name} (account ${accountId}) the Leader`);
    for (const c of this.onlineMembers(g)) this.system(c, text);
    this.sendGuild(g);
    if (leader !== undefined) this.refreshViewer(g, leader);
    this.refreshViewer(g, accountId);
    return null;
  }

  /** Every guild item, for conservation checks in tests. */
  stashItems(id: number): Item[] {
    return [...(this.guilds.get(id)?.stash?.items.values() ?? [])];
  }

  guildIdOf(accountId: number): number | null {
    return this.byAccount.get(accountId) ?? null;
  }
}
