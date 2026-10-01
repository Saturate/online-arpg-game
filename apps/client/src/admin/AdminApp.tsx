import { ASSIGNABLE_ROLES, can, DEFAULT_SERVER_SETTINGS, isSeason, seasonOf, type LeaderboardResponse, CLASSES, dayPhaseAt, hourOfPhase, phaseOfHour, isAssignableRole, rank, ROLE_INFO, SETTINGS_LIMITS, settingsConflict, type AdminAccount, type AdminOverview, type Permission, type Role, type ServerSettings } from '@rune/shared';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { adminApi, api } from '../net/api.js';
import { StaffGate, type StaffAccess } from './access.js';
import { LeaderboardTables } from '../ui/ArenaBoard.js';
import { ModelCheckTab } from './monsters/ModelCheckTab.js';
import { TuningTab } from './monsters/TuningTab.js';
import { TunablesTab } from './TunablesTab.js';
import { GrantTab } from './GrantTab.js';
import { TokensTab } from './TokensTab.js';

/**
 * Server admin: who is online and where, every account and character, live settings and
 * announcements. The server decides what each role may do; this page hides what the viewer's role
 * cannot use, reusing the game's login from this browser.
 */

type Tab = 'overview' | 'players' | 'arena' | 'settings' | 'tuning' | 'monsters' | 'minions' | 'modelCheck' | 'grant' | 'tokens';

const TAB_NAMES: Record<Tab, string> = { overview: 'Overview', players: 'Players', arena: 'Arena', settings: 'Settings', tuning: 'Tuning', monsters: 'Monsters', minions: 'Minions', modelCheck: 'Model check', grant: 'Grant item', tokens: 'API tokens' };
/** Tabs only some roles see; the server checks the same permission on every call. */
const TAB_PERMISSION: Partial<Record<Tab, Permission>> = { grant: 'grantItems', tokens: 'apiTokens' };
/** Every staff role is a builder or above, so all of them get the monster tabs; editing is checked per action. */
const WIDE_TABS: ReadonlySet<Tab> = new Set(['tuning', 'monsters', 'minions', 'modelCheck']);

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

function clockText(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The in-game clock: shows what time it is now and sets it. Setting a time while cycling shifts the
 * clock (it keeps running from there); holding stops it at that time.
 */
function ClockControl({ draft, setDraft }: { draft: ServerSettings; setDraft: (s: ServerSettings) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const current = hourOfPhase(dayPhaseAt(now, draft));
  const setHour = (hour: number) => {
    const target = phaseOfHour(hour);
    // The offset that makes the running clock read `target` right now.
    const raw = dayPhaseAt(now, { ...draft, timeOfDay: 'cycle', clockOffset: 0 });
    setDraft({ ...draft, heldPhase: target, clockOffset: (((target - raw) % 1) + 1) % 1 });
  };
  return (
    <label className="adm-field">
      <span>
        Time of day <b>{clockText(current)}</b> {draft.timeOfDay === 'hold' ? '(held)' : ''}
      </span>
      <input type="range" min={0} max={23.99} step={0.25} value={current} onChange={(e) => setHour(Number(e.target.value))} aria-label="Set the clock" />
      <span className="adm-inline">
        <label>
          <input type="checkbox" checked={draft.timeOfDay === 'hold'} onChange={(e) => setDraft({ ...draft, timeOfDay: e.target.checked ? 'hold' : 'cycle', heldPhase: phaseOfHour(current) })} /> Hold the clock here
        </label>
      </span>
      <small className="muted">Day 06:00 to 19:10, dusk to 21:40, night until 03:40. Saving applies it to everyone online right away.</small>
    </label>
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
  const force = (key: 'forceMax' | 'forceCostRate' | 'forceCoolRate' | 'forceRampMax', label: string, hint: string, min: number, max: number, step: number) => (
    <label className="adm-field">
      <span>
        {label} <b>{key === 'forceMax' ? draft[key] : `x${draft[key]}`}</b>
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft[key]}
        aria-label={label}
        onChange={(e) => {
          // An emptied field reads as 0, which the server would reject; keep the last value instead.
          if (e.target.value !== '') setDraft({ ...draft, [key]: Number(e.target.value) });
        }}
      />
      <small className="muted">{hint}</small>
    </label>
  );
  const respawn = (key: 'respawnMinutes' | 'bossRespawnMinutes' | 'gateRespawnMinutes', label: string, hint: string) => (
    <label className="adm-field">
      <span>
        {label} <b>{draft[key]} min</b>
      </span>
      <input
        type="number"
        min={SETTINGS_LIMITS.respawnMinutesMin}
        max={SETTINGS_LIMITS.respawnMinutesMax}
        step={1}
        value={draft[key]}
        aria-label={label}
        onChange={(e) => {
          // An emptied field reads as 0, which the server would reject; keep the last value instead.
          if (e.target.value !== '') setDraft({ ...draft, [key]: Number(e.target.value) });
        }}
      />
      <small className="muted">{hint}</small>
    </label>
  );
  const boss = (key: 'bossLifeMultiplier' | 'bossDamageMultiplier', label: string, hint: string) => (
    <label className="adm-field">
      <span>
        {label} <b>x{draft[key]}</b>
      </span>
      <input
        type="number"
        min={SETTINGS_LIMITS.bossMultiplierMin}
        max={SETTINGS_LIMITS.bossMultiplierMax}
        step={0.1}
        value={draft[key]}
        aria-label={label}
        onChange={(e) => {
          // An emptied field reads as 0, which the server would reject; keep the last value instead.
          if (e.target.value !== '') setDraft({ ...draft, [key]: Number(e.target.value) });
        }}
      />
      <small className="muted">{hint}</small>
    </label>
  );
  const zoom = (key: 'zoomDefault' | 'zoomDungeon' | 'zoomMin' | 'zoomMax', label: string, hint: string) => (
    <label className="adm-field">
      <span>
        {label} <b>{Math.round(draft[key] * 100)}%</b>
      </span>
      <input type="range" min={SETTINGS_LIMITS.zoomMin} max={SETTINGS_LIMITS.zoomMax} step={0.05} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} aria-label={label} />
      <small className="muted">{hint}</small>
    </label>
  );
  const zoomProblem = settingsConflict(draft);
  const editable = can(role, 'settings');
  return (
    <form className="adm-settings" onSubmit={(e) => void save(e)}>
      {!editable && <p className="muted">Your role can see the settings but not change them.</p>}
      <fieldset disabled={!editable}>
        {rate('xpRate', 'XP rate', 'Multiplies XP from every kill.')}
        {rate('lootRate', 'Loot rate', 'Multiplies how often monsters drop, and how many items rares and bosses drop.')}
        {force('forceMax', 'Force bar', `Force at level 1 before gear; each level adds more. Default ${DEFAULT_SERVER_SETTINGS.forceMax}.`, SETTINGS_LIMITS.forceMaxMin, SETTINGS_LIMITS.forceMaxMax, 10)}
        {force('forceCostRate', 'Force cost', 'Multiplies every skill\'s Force cost.', SETTINGS_LIMITS.forceRateMin, SETTINGS_LIMITS.forceRateMax, 0.05)}
        {force('forceCoolRate', 'Force cooling', 'Multiplies how fast Force drains back down. Lower makes long fights and bosses run hot.', SETTINGS_LIMITS.forceRateMin, SETTINGS_LIMITS.forceRateMax, 0.05)}
        {force('forceRampMax', 'Cooling ramp', `How much faster cooling gets after a pause in casting, at most. Default x${DEFAULT_SERVER_SETTINGS.forceRampMax}.`, SETTINGS_LIMITS.forceRampMin, SETTINGS_LIMITS.forceRampMax, 0.5)}
        <label className="adm-field">
          <span>
            Cast cooldown <b>{draft.castCooldownSeconds} s</b>
          </span>
          <input
            type="number"
            min={SETTINGS_LIMITS.castCooldownMin}
            max={SETTINGS_LIMITS.castCooldownMax}
            step={0.05}
            value={draft.castCooldownSeconds}
            aria-label="Cast cooldown"
            onChange={(e) => {
              // An emptied field reads as 0, which the server would reject; keep the last value instead.
              if (e.target.value !== '') setDraft({ ...draft, castCooldownSeconds: Number(e.target.value) });
            }}
          />
          <small className="muted">{`Seconds between any two spell casts, before cast delay and cast speed shorten it. Force is the magazine, this is the fire rate. Default ${DEFAULT_SERVER_SETTINGS.castCooldownSeconds}.`}</small>
        </label>
        {respawn('respawnMinutes', 'Monster respawn', `Minutes a stretch of the world must go with no player or minion within about 2000 units before its killed packs and opened chests come back. Default ${DEFAULT_SERVER_SETTINGS.respawnMinutes}.`)}
        {respawn('bossRespawnMinutes', 'Boss respawn', `The same for region bosses and their escorts. Default ${DEFAULT_SERVER_SETTINGS.bossRespawnMinutes}.`)}
        {respawn('gateRespawnMinutes', 'Gate boss respawn', `Minutes from a gate boss's death until it comes back for the next character. Default ${DEFAULT_SERVER_SETTINGS.gateRespawnMinutes}.`)}
        {boss('bossLifeMultiplier', 'Boss life', `Every boss's life, on top of the 3x every rare has. Bosses already alive keep theirs. Default x${DEFAULT_SERVER_SETTINGS.bossLifeMultiplier}.`)}
        {boss('bossDamageMultiplier', 'Boss damage', `Everything a boss deals: hits, abilities, projectiles and pools. Bosses already alive keep theirs. Default x${DEFAULT_SERVER_SETTINGS.bossDamageMultiplier}.`)}
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
        <label className="adm-field">
          <span>
            Day length <b>{draft.dayMinutes} min</b>
          </span>
          <input type="range" min={SETTINGS_LIMITS.dayMinutesMin} max={120} step={1} value={Math.min(120, draft.dayMinutes)} onChange={(e) => setDraft({ ...draft, dayMinutes: Number(e.target.value) })} />
          <small className="muted">One full day and night.</small>
        </label>
        <label className="adm-field">
          <span>
            Night brightness <b>{Math.round(draft.nightBrightness * 100)}%</b>
          </span>
          <input type="range" min={0} max={1} step={0.05} value={draft.nightBrightness} onChange={(e) => setDraft({ ...draft, nightBrightness: Number(e.target.value) })} />
          <small className="muted">How much light is left at the darkest point of night.</small>
        </label>
        <label className="adm-field">
          <span>
            Hero light at night <b>{Math.round(draft.heroLight * 100)}%</b>
          </span>
          <input type="range" min={0} max={SETTINGS_LIMITS.lightRateMax} step={0.05} value={draft.heroLight} onChange={(e) => setDraft({ ...draft, heroLight: Number(e.target.value) })} />
          <small className="muted">The warm light around each hero at night; party members carry a faint share. Underground it scales the hero's torch.</small>
        </label>
        <label className="adm-field">
          <span>
            Hero light reach <b>{draft.heroLightRadius}</b>
          </span>
          <input type="range" min={SETTINGS_LIMITS.heroLightRadiusMin} max={SETTINGS_LIMITS.heroLightRadiusMax} step={20} value={draft.heroLightRadius} onChange={(e) => setDraft({ ...draft, heroLightRadius: Number(e.target.value) })} />
          <small className="muted">How far the hero's night light reaches, in world units; the screen is about 540 tall.</small>
        </label>
        <label className="adm-field">
          <span>
            Lamps and torches <b>{Math.round(draft.lampLight * 100)}%</b>
          </span>
          <input type="range" min={0} max={SETTINGS_LIMITS.lightRateMax} step={0.05} value={draft.lampLight} onChange={(e) => setDraft({ ...draft, lampLight: Number(e.target.value) })} />
          <small className="muted">Torches, lanterns, fires, portals and waypoints: their light at night and every torch underground.</small>
        </label>
        <ClockControl draft={draft} setDraft={setDraft} />
        {zoom('zoomDefault', 'Camera zoom', 'Where players start outdoors and in town. 100% is the classic view; higher is closer.')}
        {zoom('zoomDungeon', 'Camera zoom in dungeons', 'Where players start in dungeons and their antechambers.')}
        {zoom('zoomMin', 'Furthest zoom out', `How much of the map a player can see at most. The server allows ${Math.round(SETTINGS_LIMITS.zoomMin * 100)}% and up.`)}
        {zoom('zoomMax', 'Closest zoom in', 'How close a player can bring the camera.')}
        {zoomProblem && <p className="adm-field wide"><span className="badge red">{zoomProblem}</span></p>}
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
          <button type="submit" className="primary" disabled={!dirty || zoomProblem !== null}>
            Save
          </button>
        </div>
      )}
    </form>
  );
}

/** Read-only: the same boards the champions' stone shows in game, for any season. */
function Arena({ notify }: Pick<TabProps, 'notify'>) {
  const [season, setSeason] = useState(() => seasonOf(Date.now()));
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  useEffect(() => {
    if (!isSeason(season)) return;
    let live = true;
    void api.leaderboard(season).then((r) => {
      if (!live) return;
      if (r.ok) setBoard(r.data);
      else notify(r.error);
    });
    return () => {
      live = false;
    };
  }, [season, notify]);
  return (
    <>
      <div className="adm-toolbar">
        <label>
          Season <input type="month" value={season} onChange={(e) => setSeason(e.target.value)} aria-label="Season" />
        </label>
      </div>
      {board ? <LeaderboardTables board={board} /> : <p className="muted">Loading</p>}
    </>
  );
}

export function AdminApp() {
  return (
    <StaffGate title="Allan's ARPG admin" permission="viewAdmin">
      {(access) => <AdminPage access={access} />}
    </StaffGate>
  );
}

function AdminPage({ access }: { access: StaffAccess }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((t: string) => {
    setToast(t);
    setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 3500);
  }, []);
  const { role, token } = access;
  return (
    <div className="adm">
      <header className="adm-header">
        <h1>Allan's ARPG admin</h1>
        <nav>
          {(['overview', 'players', 'arena', 'settings', 'tuning', 'monsters', 'minions', 'modelCheck', 'grant', 'tokens'] as const)
            .filter((t) => {
              const p = TAB_PERMISSION[t];
              return p === undefined || can(role, p);
            })
            .map((t) => (
            <button key={t} type="button" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {TAB_NAMES[t]}
            </button>
          ))}
        </nav>
        <span className="muted adm-who">
          {access.username} <span className="badge gold">{ROLE_INFO[role].name}</span>
        </span>
        {can(role, 'devTools') && <a href="/admin/dev/">Dev tools</a>}
        {/* The town editor works on the live town from inside the game, so it has no page of its own. */}
        {can(role, 'townEdit') && <span className="muted" title="Open the game, stand in town and press F2">Town editor: F2 in town</span>}
        <a href="/">Back to game</a>
      </header>
      <main className={WIDE_TABS.has(tab) ? 'adm-main adm-wide' : 'adm-main'}>
        {tab === 'overview' && <Overview token={token} role={role} notify={notify} />}
        {tab === 'players' && <Players token={token} role={role} notify={notify} />}
        {tab === 'arena' && <Arena notify={notify} />}
        {tab === 'settings' && <Settings token={token} role={role} notify={notify} />}
        {tab === 'tuning' && <TunablesTab token={token} role={role} notify={notify} />}
        {tab === 'monsters' && <TuningTab key="monsters" kind="monsters" token={token} role={role} notify={notify} />}
        {tab === 'minions' && <TuningTab key="minions" kind="minions" token={token} role={role} notify={notify} />}
        {tab === 'modelCheck' && <ModelCheckTab notify={notify} />}
        {tab === 'grant' && can(role, 'grantItems') && <GrantTab token={token} notify={notify} />}
        {tab === 'tokens' && can(role, 'apiTokens') && <TokensTab token={token} role={role} notify={notify} />}
      </main>
      {toast && (
        <div className="adm-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
