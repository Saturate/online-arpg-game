import { can, type AdminLive, type LivePlayer, type Role } from '@rune/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminApi } from '../../net/api.js';
import { liveApi } from './liveApi.js';
import { HealthPanel, LogTail, PlayersTable, RoomsTable, WorldMinimap, type PlayerActions } from './parts.js';
import './live.css';

/** Often enough to feel live, rare enough that two open pages stay far under the 120 a minute limit. */
const POLL_MS = 3000;

/**
 * The Live view (docs/features/admin-ui.md): who is online and where, the rooms and their tick time,
 * server health, the log tails and a minimap per world copy, refreshed every few seconds. The server
 * sends the log tails only to roles with `serverLog`; the page shows what it gets.
 */
export function LiveTab({ token, role, notify, openPlayer }: { token: string; role: Role; notify: (t: string) => void; openPlayer: (accountId: number) => void }) {
  const [data, setData] = useState<AdminLive | null>(null);
  const [stopped, setStopped] = useState<string | null>(null);
  const [text, setText] = useState('');

  const load = useCallback(() => {
    void liveApi.live(token).then((r) => {
      if (r.ok) {
        setData(r.data);
        return;
      }
      // An expired session will not fix itself, so stop polling instead of toasting every 3 s.
      if (r.status === 401) setStopped('Session expired, log in to the game again');
      else notify(r.error);
    });
  }, [token, notify]);

  useEffect(() => {
    if (stopped) return;
    load();
    const t = setInterval(() => {
      // A tab in the background polls nothing; it catches up the moment it is shown again.
      if (!document.hidden) load();
    }, POLL_MS);
    const onShow = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [load, stopped]);

  const announce = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const r = await adminApi.announce(token, text.trim());
    notify(r.ok ? `Announced to ${r.data.reached} players` : r.error);
    if (r.ok) setText('');
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
        load();
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
          {data.worlds.length === 0 ? <p className="muted">No world copy is open.</p> : data.worlds.map((w) => <WorldMinimap key={w.game} world={w} />)}
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
