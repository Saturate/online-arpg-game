import { can, SETTINGS_LIMITS, type AdminLive, type LivePlayer, type LiveWorld, type Role } from '@rune/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { adminApi } from '../../net/api.js';
import { liveApi, rebuildSummary } from './liveApi.js';
import { nextPollDelay, RegionCache } from './poll.js';
import { HealthPanel, LogTail, PlayersTable, RoomsTable, WorldMinimap, type PlayerActions } from './parts.js';
import './live.css';

/** Long enough to finish a fight and step into town, short enough to keep the deploy moving. */
const RESTART_WARNING_SECONDS = 60;

/** Often enough to feel live, rare enough that two open pages stay far under the 120 a minute limit. */
const POLL_MS = 3000;

/**
 * Rebuild and reroll for one world copy. Both move everyone in it onto the new map, so each asks
 * first; a public copy takes every public copy on its seed with it, as the server does.
 */
function WorldActions({ world, token, role, notify, done }: { world: LiveWorld; token: string; role: Role; notify: (t: string) => void; done: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const scope = world.kind === 'public' ? 'every public world copy on this seed' : world.name;
  const run = async (ask: string, call: () => ReturnType<typeof liveApi.rebuild>, verb: string) => {
    if (!confirm(ask)) return;
    setBusy(true);
    const r = await call();
    setBusy(false);
    notify(r.ok ? rebuildSummary(r.data, verb) : r.error);
    if (r.ok) {
      setPin('');
      done();
    }
  };
  const pinned = /^\d{1,6}$/.test(pin.trim()) ? Number(pin.trim()) : null;
  const pinOk = pinned !== null && pinned <= SETTINGS_LIMITS.seedMax;
  return (
    <div className="live-world-actions">
      {can(role, 'tuning') && (
        <button
          type="button"
          className="small"
          disabled={busy}
          title="Rebuild with the generation numbers in force now, carrying everyone in it to open ground"
          onClick={() => void run(`Rebuild ${scope} with the generation numbers in force now? Everyone inside is carried to open ground; if the plan changes, its dead bosses and opened chests are forgotten.`, () => liveApi.rebuild(token, world.game), 'Rebuilt')}
        >
          Rebuild
        </button>
      )}
      {can(role, 'settings') && (
        <>
          <button
            type="button"
            className="small"
            disabled={busy}
            title={world.kind === 'public' ? 'A random seed for the public world: sets the world seed setting too' : 'A random seed for this party world'}
            onClick={() => void run(`Reroll the seed of ${scope}? It becomes a new world at once, with fresh bosses and chests.`, () => liveApi.reroll(token, world.game), 'Rerolled')}
          >
            Reroll seed
          </button>
          <input className="live-seed" inputMode="numeric" placeholder="seed" value={pin} onChange={(e) => setPin(e.target.value)} aria-label={`Seed to pin for ${world.name}`} />
          <button type="button" className="small" disabled={busy || !pinOk} title={`Pin a seed from 0 to ${SETTINGS_LIMITS.seedMax}`} onClick={() => pinned !== null && void run(`Put ${scope} on seed ${pinned}?`, () => liveApi.reroll(token, world.game, pinned), 'Pinned')}>
            Pin
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The Live view (docs/features/admin-ui.md): who is online and where, the rooms and their tick time,
 * server health, the log tails and a minimap per world copy, refreshed every few seconds. The server
 * sends the log tails only to roles with `serverLog`; the page shows what it gets.
 */
export function LiveTab({ token, role, notify, openPlayer }: { token: string; role: Role; notify: (t: string) => void; openPlayer: (accountId: number) => void }) {
  const [data, setData] = useState<AdminLive | null>(null);
  const [stopped, setStopped] = useState<string | null>(null);
  const [text, setText] = useState('');

  const regions = useRef(new RegionCache());
  const load = useCallback(async (): Promise<number> => {
    const r = await liveApi.live(token, regions.current.have());
    if (r.ok) {
      setData({ ...r.data, worlds: regions.current.resolve(r.data.worlds) });
      return 200;
    }
    // An expired session will not fix itself, so stop polling instead of toasting every 3 s.
    if (r.status === 401) setStopped('Session expired, log in to the game again');
    else if (r.status !== 429) notify(r.error);
    return r.status;
  }, [token, notify]);

  useEffect(() => {
    if (stopped) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_MS;
    let warned = false;
    const tick = async () => {
      // A tab in the background polls nothing; it catches up the moment it is shown again.
      const status = document.hidden ? 200 : await load();
      if (!live) return;
      if (status === 429 && !warned) {
        warned = true;
        notify('The server is limiting requests; the live view slows down until it recovers');
      }
      if (status !== 429) warned = false;
      delay = nextPollDelay(delay, POLL_MS, status === 429);
      timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    const onShow = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [load, stopped, notify]);

  const announce = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const r = await adminApi.announce(token, text.trim());
    notify(r.ok ? `Announced to ${r.data.reached} players` : r.error);
    if (r.ok) setText('');
  };

  const countdown = async () => {
    if (!confirm('Warn everyone online that the server restarts for an update in 60 seconds? It only warns; the deploy does the restart.')) return;
    const r = await adminApi.restartCountdown(token, RESTART_WARNING_SECONDS);
    notify(r.ok ? `Restart countdown sent to ${r.data.reached} players` : r.error);
  };

  if (stopped) return <p className="muted">{stopped}</p>;
  if (!data) return <p className="muted">Loading the live view</p>;

  const actions: PlayerActions = {
    canTeleport: can(role, 'teleport'),
    canKick: can(role, 'kick'),
    onOpen: (p: LivePlayer) => openPlayer(p.accountId),
    onGoto: (p) => void adminApi.goto(token, p.characterId).then((r) => notify(r.ok ? `Teleported to ${p.name}` : r.error)),
    onKick: (p) => {
      if (!confirm(`Kick ${p.name}?`)) return;
      void adminApi.kick(token, p.characterId).then((r) => {
        notify(r.ok ? (r.data.kicked ? `Kicked ${p.name}` : `${p.name} had already left`) : r.error);
        void load();
      });
    },
  };

  return (
    <div className="live">
      <HealthPanel health={data.health} />

      {can(role, 'announce') && (
        <form className="adm-announce" onSubmit={(e) => void announce(e)}>
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="Announce to everyone online" aria-label="Announcement" />
          <button type="submit" className="primary" disabled={!text.trim()}>
            Announce
          </button>
          <button type="button" onClick={() => void countdown()} title="Before a deploy while people are online: a banner, a countdown and chat reminders">
            Restart countdown ({RESTART_WARNING_SECONDS} s)
          </button>
        </form>
      )}

      <div className="live-grid">
        <section className="live-main">
          <h2>
            Online <span className="muted">{data.players.length}</span>
          </h2>
          <PlayersTable players={data.players} actions={actions} />
          <h2>
            Rooms <span className="muted">{data.rooms.length}</span>
          </h2>
          <RoomsTable rooms={data.rooms} />
        </section>
        <aside className="live-side">
          <h2>World copies</h2>
          {can(role, 'tuning') && data.worlds.length > 0 && (
            <button
              type="button"
              className="small"
              title="Every world copy takes the generation numbers in force now"
              onClick={() => {
                if (!confirm('Rebuild every world copy with the generation numbers in force now? Everyone is carried to open ground; copies whose plan changes forget their dead bosses and opened chests.')) return;
                void liveApi.rebuild(token).then((r) => {
                  notify(r.ok ? rebuildSummary(r.data, 'Rebuilt') : r.error);
                  void load();
                });
              }}
            >
              Rebuild every copy
            </button>
          )}
          {data.worlds.length === 0 ? (
            <p className="muted">No world copy is open.</p>
          ) : (
            data.worlds.map((w) => (
              <WorldMinimap key={w.game} world={w}>
                <WorldActions world={w} token={token} role={role} notify={notify} done={() => void load()} />
              </WorldMinimap>
            ))
          )}
        </aside>
      </div>

      {data.log && data.staff && (
        <div className="live-tails">
          <section>
            <h2>Server log</h2>
            <LogTail entries={data.log} label="Server log, newest first" empty="Nothing logged since the server started." />
          </section>
          <section>
            <h2>Staff changes</h2>
            <LogTail entries={data.staff} label="Staff changes, newest first" empty="No staff changes since the server started." />
          </section>
        </div>
      )}
    </div>
  );
}
