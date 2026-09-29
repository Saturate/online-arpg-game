import { ASSIGNABLE_ROLES, can, CLASSES, isAssignableRole, rank, ROLE_INFO, SETTINGS_LIMITS, type AdminAccount, type AdminOverview, type Role, type ServerSettings } from '@rune/shared';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { adminApi, api } from '../net/api.js';

/**
 * Server admin: who is online and where, every account and character, live settings and
 * announcements. The server decides what each role may do; this page hides what the viewer's role
 * cannot use, reusing the game's login from this browser.
 */

type Tab = 'overview' | 'players' | 'settings';

function readToken(): string | null {
  try {
    return localStorage.getItem('rune.session');
  } catch {
    return null;
  }
}

function ago(at: number): string {
  if (at === 0) return 'never';
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : new Date(at).toLocaleDateString();
}

function uptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

interface TabProps {
  token: string;
  role: Role;
  notify: (t: string) => void;
}

function Overview({ token, role, notify }: TabProps) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [text, setText] = useState('');

  const [expired, setExpired] = useState(false);
  const load = useCallback(() => {
    void adminApi.overview(token).then((r) => {
      if (r.ok) return setData(r.data);
      // An expired session will not fix itself, so stop polling instead of toasting every 3 s.
      if (r.status === 401) setExpired(true);
      notify(r.status === 401 ? 'Session expired, log in to the game again' : r.error);
    });
  }, [token, notify]);

  useEffect(() => {
    if (expired) return;
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load, expired]);

  const announce = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const r = await adminApi.announce(token, text.trim());
    notify(r.ok ? `Announced to ${r.data.reached} players` : r.error);
    if (r.ok) setText('');
  };

  if (!data) return <p className="muted">Loading</p>;
  return (
    <>
      <div className="adm-cards">
        <div className="adm-card">
          <b>{data.online.length}</b>
          <span>online</span>
        </div>
        <div className="adm-card">
          <b>{data.games.length}</b>
          <span>games</span>
        </div>
        <div className="adm-card">
          <b>{data.rooms.length}</b>
          <span>rooms</span>
        </div>
        <div className="adm-card">
          <b>{data.memoryMb} MB</b>
          <span>memory</span>
        </div>
        <div className="adm-card">
          <b>{uptime(data.uptimeSeconds)}</b>
          <span>uptime</span>
        </div>
        <div className="adm-card">
          <b className="mono">{data.build.slice(0, 7)}</b>
          <span>build</span>
        </div>
      </div>

      {can(role, 'announce') && (
        <form className="adm-announce" onSubmit={(e) => void announce(e)}>
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="Announce to everyone online" aria-label="Announcement" />
          <button type="submit" className="primary" disabled={!text.trim()}>
            Announce
          </button>
        </form>
      )}

      <h2>Online</h2>
      {data.online.length === 0 ? (
        <p className="muted">Nobody is playing right now.</p>
      ) : (
        <table className="adm-table">
          <thead>
            <tr>
              <th>Character</th>
              <th>Class</th>
              <th>Level</th>
              <th>Account</th>
              <th>Where</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.online.map((p) => (
              <tr key={p.characterId}>
                <td>{p.name}</td>
                <td>{CLASSES[p.classId].name}</td>
                <td>{p.level}</td>
                <td>{p.account}</td>
                <td>
                  {p.room}
                  {p.game ? <span className="muted"> ({p.game})</span> : null}
                </td>
                <td className="adm-row-actions">
                  {can(role, 'teleport') && (
                    <button
                      type="button"
                      className="small"
                      onClick={() => {
                        void adminApi.goto(token, p.characterId).then((r) => notify(r.ok ? `Teleported to ${p.name}` : r.error));
                      }}
                    >
                      Go to
                    </button>
                  )}
                  {can(role, 'kick') && (
                    <button
                      type="button"
                      className="danger small"
                      onClick={() => {
                        if (!confirm(`Kick ${p.name}?`)) return;
                        void adminApi.kick(token, p.characterId).then((r) => {
                          notify(r.ok ? (r.data.kicked ? `Kicked ${p.name}` : `${p.name} had already left`) : r.error);
                          load();
                        });
                      }}
                    >
                      Kick
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="adm-cols">
        <div>
          <h2>Games</h2>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Game</th>
                <th>Host</th>
                <th>Players</th>
                <th>Rooms</th>
              </tr>
            </thead>
            <tbody>
              {data.games.map((g) => (
                <tr key={g.id}>
                  <td className="mono">{g.id}</td>
                  <td>{g.host}</td>
                  <td>{g.players}</td>
                  <td>{g.rooms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h2>Rooms</h2>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Players</th>
                <th>Monsters</th>
              </tr>
            </thead>
            <tbody>
              {data.rooms.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name} <span className="muted mono">{r.id}</span>
                  </td>
                  <td>{r.players}</td>
                  <td>{r.monsters}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Players({ token, role, notify }: TabProps) {
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(() => {
    void adminApi.accounts(token).then((r) => (r.ok ? setAccounts(r.data) : notify(r.error)));
  }, [token, notify]);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (accounts ?? []).filter((a) => !f || a.username.toLowerCase().includes(f) || a.characters.some((c) => c.name.toLowerCase().includes(f)));
  }, [accounts, filter]);

  if (!accounts) return <p className="muted">Loading</p>;
  return (
    <>
      <div className="adm-toolbar">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search accounts or characters" aria-label="Search" />
        <span className="muted">
          {accounts.length} accounts, {accounts.reduce((n, a) => n + a.characters.length, 0)} characters
        </span>
      </div>
      <table className="adm-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Joined</th>
            <th>Characters</th>
            <th>Last played</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((a) => {
            const last = Math.max(0, ...a.characters.map((c) => c.playedAt));
            return [
              <tr key={a.id} className={open === a.id ? 'open' : ''} onClick={() => setOpen(open === a.id ? null : a.id)}>
                <td>
                  {a.username} {a.role !== 'player' && <span className="badge gold">{ROLE_INFO[a.role].name}</span>} {a.guest && <span className="badge">guest</span>} {a.banned && <span className="badge red">banned</span>}
                </td>
                <td>{new Date(a.createdAt).toLocaleDateString()}</td>
                <td>{a.characters.length}</td>
                <td>{ago(last)}</td>
                <td className="adm-row-actions">
                  {can(role, 'manageRoles') && a.role !== 'owner' && (
                    <select
                      value={a.role}
                      aria-label={`Role for ${a.username}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const next = e.target.value;
                        if (!isAssignableRole(next)) return;
                        void adminApi.setRole(token, a.id, next).then((r) => {
                          notify(r.ok ? `${a.username} is now ${ROLE_INFO[next].name.toLowerCase()}` : r.error);
                          load();
                        });
                      }}
                    >
                      {ASSIGNABLE_ROLES.map((r) => (
                        <option key={r} value={r} title={ROLE_INFO[r].blurb}>
                          {ROLE_INFO[r].name}
                        </option>
                      ))}
                    </select>
                  )}
                  {/* Mirrors the server: only accounts ranked below you, though owners may unban each other. */}
                  {can(role, 'ban') && (rank(a.role) < rank(role) || (role === 'owner' && a.banned)) && (
                    <button
                      type="button"
                      className={a.banned ? 'small' : 'danger small'}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!a.banned && !confirm(`Ban ${a.username}? They are kicked and cannot log in.`)) return;
                        void adminApi.ban(token, a.id, !a.banned).then((r) => {
                          notify(r.ok ? `${a.banned ? 'Unbanned' : 'Banned'} ${a.username}` : r.error);
                          load();
                        });
                      }}
                    >
                      {a.banned ? 'Unban' : 'Ban'}
                    </button>
                  )}
                </td>
              </tr>,
              open === a.id && (
                <tr key={`${a.id}-chars`} className="adm-sub">
                  <td colSpan={5}>
                    {a.characters.length === 0 ? (
                      <span className="muted">No characters yet.</span>
                    ) : (
                      <table className="adm-table inner">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Class</th>
                            <th>Level</th>
                            <th>Created</th>
                            <th>Last played</th>
                          </tr>
                        </thead>
                        <tbody>
                          {a.characters.map((c) => (
                            <tr key={c.id}>
                              <td>{c.name}</td>
                              <td>{CLASSES[c.classId].name}</td>
                              <td>{c.level}</td>
                              <td>{new Date(c.createdAt).toLocaleDateString()}</td>
                              <td>{ago(c.playedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </>
  );
}

function Settings({ token, role, notify }: TabProps) {
  const [saved, setSaved] = useState<ServerSettings | null>(null);
  const [draft, setDraft] = useState<ServerSettings | null>(null);

  useEffect(() => {
    void adminApi.settings(token).then((r) => {
      if (!r.ok) return notify(r.error);
      setSaved(r.data);
      setDraft(r.data);
    });
  }, [token, notify]);

  if (!draft || !saved) return <p className="muted">Loading</p>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await adminApi.saveSettings(token, draft);
    if (!r.ok) return notify(r.error);
    setSaved(r.data);
    setDraft(r.data);
    notify('Settings saved and applied to every room');
  };
  const rate = (key: 'xpRate' | 'lootRate', label: string, hint: string) => (
    <label className="adm-field">
      <span>
        {label} <b>x{draft[key]}</b>
      </span>
      <input type="range" min={0} max={5} step={0.25} value={Math.min(5, draft[key])} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} />
      <input type="number" min={SETTINGS_LIMITS.rateMin} max={SETTINGS_LIMITS.rateMax} step={0.25} value={draft[key]} onChange={(e) => {
          // An emptied field reads as 0, which would silently switch XP or loot off on save.
          if (e.target.value !== '') setDraft({ ...draft, [key]: Number(e.target.value) });
        }} aria-label={label} />
      <small className="muted">{hint}</small>
    </label>
  );
  const editable = can(role, 'settings');
  return (
    <form className="adm-settings" onSubmit={(e) => void save(e)}>
      {!editable && <p className="muted">Your role can see the settings but not change them.</p>}
      <fieldset disabled={!editable}>
        {rate('xpRate', 'XP rate', 'Multiplies XP from every kill.')}
        {rate('lootRate', 'Loot rate', 'Multiplies how often monsters drop, and how many items rares and bosses drop.')}
        <label className="adm-field wide">
          <span>Message of the day</span>
          <textarea value={draft.motd} maxLength={SETTINGS_LIMITS.motdMax} rows={3} onChange={(e) => setDraft({ ...draft, motd: e.target.value })} placeholder="Shown in chat as players enter the world" />
        </label>
        <label className="adm-field">
          <span>
            World seed <b>{draft.worldSeed}</b>
          </span>
          <input
            type="number"
            min={0}
            max={SETTINGS_LIMITS.seedMax}
            step={1}
            value={draft.worldSeed}
            aria-label="World seed"
            onChange={(e) => {
              const v = Number(e.target.value);
              if (e.target.value !== '' && Number.isInteger(v)) setDraft({ ...draft, worldSeed: v });
            }}
          />
          <button type="button" onClick={() => setDraft({ ...draft, worldSeed: Math.floor(Math.random() * (SETTINGS_LIMITS.seedMax + 1)) })}>
            Random
          </button>
          <small className="muted">The layout of the public world. Copies already running keep theirs until everyone leaves; new ones use this.</small>
        </label>
        <label className="adm-check">
          <input type="checkbox" checked={draft.registrationOpen} onChange={(e) => setDraft({ ...draft, registrationOpen: e.target.checked })} />
          Registration open <small className="muted">New accounts can be created</small>
        </label>
      </fieldset>
      {editable && (
        <div className="adm-actions">
          <button type="button" disabled={!dirty} onClick={() => setDraft(saved)}>
            Revert
          </button>
          <button type="submit" className="primary" disabled={!dirty}>
            Save
          </button>
        </div>
      )}
    </form>
  );
}

export function AdminApp() {
  const token = readToken();
  const [tab, setTab] = useState<Tab>('overview');
  /** null while checking, the viewer's role when staff, otherwise the reason to show. */
  const [access, setAccess] = useState<{ role: Role; username: string } | string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((t: string) => {
    setToast(t);
    setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 3500);
  }, []);

  useEffect(() => {
    if (!token) return;
    void api.characters(token).then((r) => {
      if (r.ok) return setAccess(can(r.data.role, 'viewAdmin') ? { role: r.data.role, username: r.data.username } : 'This account has no staff role.');
      setAccess(r.status === 401 ? 'Your session expired. Log in to the game again.' : `Could not reach the server (${r.error}). Reload to retry.`);
    });
  }, [token]);

  if (!token || typeof access === 'string') {
    return (
      <main className="adm-gate">
        <h1>Allan's ARPG admin</h1>
        <p className="muted">{token && typeof access === 'string' ? access : 'Log in to the game first; this page uses the same login.'}</p>
        <a href="/">Go to the game</a>
      </main>
    );
  }
  if (access === null) return <main className="adm-gate muted">Checking access</main>;
  const { role } = access;
  return (
    <div className="adm">
      <header className="adm-header">
        <h1>Allan's ARPG admin</h1>
        <nav>
          {(['overview', 'players', 'settings'] as const).map((t) => (
            <button key={t} type="button" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'overview' ? 'Overview' : t === 'players' ? 'Players' : 'Settings'}
            </button>
          ))}
        </nav>
        <span className="muted adm-who">
          {access.username} <span className="badge gold">{ROLE_INFO[role].name}</span>
        </span>
        <a href="/">Back to game</a>
      </header>
      <main className="adm-main">
        {tab === 'overview' && <Overview token={token} role={role} notify={notify} />}
        {tab === 'players' && <Players token={token} role={role} notify={notify} />}
        {tab === 'settings' && <Settings token={token} role={role} notify={notify} />}
      </main>
      {toast && (
        <div className="adm-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
