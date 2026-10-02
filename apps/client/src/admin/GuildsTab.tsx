import { can, CLASSES, GUILD_RANK_NAMES, rankOrder, type AdminGuildDetail, type AdminGuildSummary, type GuildLogEntry, type Role } from '@rune/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { guildsApi } from './guildsApi.js';
import { searchId } from './tabs.js';

/**
 * Every guild (docs/features/guilds.md), for every staff role: who leads it, how big it is and
 * whether its stash reads. A guild opens to its roster and its log, paged back 100 lines at a time.
 * Handing leadership to a member needs the `guilds` permission (owner and admins), as the route does.
 */

function ago(at: number): string {
  if (at === 0) return 'never';
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : new Date(at).toLocaleDateString();
}

function when(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function Detail({ token, role, id, notify, reloadList }: { token: string; role: Role; id: number; notify: (t: string) => void; reloadList: () => void }) {
  const [detail, setDetail] = useState<AdminGuildDetail | null>(null);
  const [log, setLog] = useState<GuildLogEntry[]>([]);
  const [more, setMore] = useState(false);
  const load = useCallback(() => {
    void guildsApi.detail(token, id, null).then((r) => {
      if (!r.ok) return notify(r.error);
      setDetail(r.data);
      setLog(r.data.log);
      setMore(r.data.moreLog);
    });
  }, [token, id, notify]);
  useEffect(load, [load]);
  const older = () => {
    const last = log[log.length - 1];
    if (!last) return;
    void guildsApi.detail(token, id, last.id).then((r) => {
      if (!r.ok) return notify(r.error);
      setLog((cur) => [...cur, ...r.data.log.filter((e) => !cur.some((c) => c.id === e.id))]);
      setMore(r.data.moreLog);
    });
  };
  if (!detail) return <p className="muted">Loading</p>;
  const roster = [...detail.roster].sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || a.username.localeCompare(b.username));
  const mayLead = can(role, 'guilds');
  return (
    <div className="adm-guild-detail">
      <p className="muted">
        {detail.motd ? <>Message of the day: {detail.motd}</> : 'No message of the day.'} Tabs: {detail.tabList.map((t) => `${t.name} (${t.items})`).join(', ') || 'none'}
      </p>
      <h3>Roster</h3>
      <table className="adm-table inner">
        <thead>
          <tr>
            <th>Account</th>
            <th>Character</th>
            <th>Rank</th>
            <th>Joined</th>
            <th>Last active</th>
            <th>Online</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {roster.map((m) => (
            <tr key={m.accountId} className={m.online ? '' : 'adm-dim'}>
              <td>{m.username}</td>
              <td>{m.character ? `${m.character}${m.classId ? `, ${CLASSES[m.classId].name} ${m.level}` : ''}` : <span className="muted">none</span>}</td>
              <td>{GUILD_RANK_NAMES[m.rank]}</td>
              <td>{new Date(m.joinedAt).toLocaleDateString()}</td>
              <td>{ago(m.lastActive)}</td>
              <td>{m.online ? <span className="badge gold">online</span> : ''}</td>
              <td className="adm-row-actions">
                {mayLead && m.rank !== 'leader' && (
                  <button
                    type="button"
                    className="small"
                    onClick={() => {
                      if (!confirm(`Make ${m.username} the Leader of ${detail.name}? The current Leader becomes an Officer.`)) return;
                      void guildsApi.setLeader(token, id, m.accountId).then((r) => {
                        notify(r.ok ? `${m.username} now leads ${detail.name}` : r.error);
                        load();
                        reloadList();
                      });
                    }}
                  >
                    Make Leader
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Log</h3>
      {log.length === 0 ? (
        <p className="muted">Nothing logged.</p>
      ) : (
        <table className="adm-table inner">
          <thead>
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>By</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {log.map((e) => (
              <tr key={e.id}>
                <td>{when(e.at)}</td>
                <td>{e.kind}</td>
                <td>{e.actor || <span className="muted">server</span>}</td>
                <td>{e.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {more && (
        <button type="button" className="small" onClick={older}>
          Older log lines
        </button>
      )}
    </div>
  );
}

export function GuildsTab({ token, role, notify }: { token: string; role: Role; notify: (t: string) => void }) {
  const [guilds, setGuilds] = useState<AdminGuildSummary[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const load = useCallback(() => {
    void guildsApi.list(token).then((r) => (r.ok ? setGuilds(r.data) : notify(r.error)));
  }, [token, notify]);
  useEffect(load, [load]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (guilds ?? []).filter((g) => !f || g.name.toLowerCase().includes(f) || g.tag.toLowerCase().includes(f) || (g.leader?.username.toLowerCase().includes(f) ?? false));
  }, [guilds, filter]);
  if (!guilds) return <p className="muted">Loading</p>;
  return (
    <>
      <div className="adm-toolbar">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search guilds, tags or leaders" aria-label="Search guilds" />
        <span className="muted">{guilds.length} {guilds.length === 1 ? 'guild' : 'guilds'}</span>
      </div>
      {guilds.length === 0 ? (
        <p className="muted">No guilds yet.</p>
      ) : (
        <table className="adm-table">
          <thead>
            <tr>
              <th>Guild</th>
              <th>Tag</th>
              <th>Members</th>
              <th>Leader</th>
              <th>Tabs</th>
              <th>Items</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => [
              <tr key={g.id} className={open === g.id ? 'open' : ''} onClick={() => setOpen(open === g.id ? null : g.id)} data-search-id={searchId('guilds', String(g.id))} tabIndex={-1}>
                <td>
                  {g.name} {!g.stashReadable && <span className="badge red" title="The stored stash could not be read; the server refuses it and keeps the row">stash unreadable</span>}
                </td>
                <td>[{g.tag}]</td>
                <td>{g.members}</td>
                <td>{g.leader ? `${g.leader.username}${g.leader.character ? ` (${g.leader.character})` : ''}` : <span className="badge red">no leader</span>}</td>
                <td>{g.tabs}</td>
                <td>{g.items}</td>
                <td>{new Date(g.createdAt).toLocaleDateString()}</td>
              </tr>,
              open === g.id && (
                <tr key={`${g.id}-detail`} className="adm-sub">
                  <td colSpan={7}>
                    <Detail token={token} role={role} id={g.id} notify={notify} reloadList={load} />
                  </td>
                </tr>
              ),
            ])}
          </tbody>
        </table>
      )}
    </>
  );
}
