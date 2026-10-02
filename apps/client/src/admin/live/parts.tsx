import { CLASSES, TICK_BUDGET_MS, type LiveHealth, type LivePlayer, type LiveRoom, type LiveRoomKind, type LiveWorld, type ServerEvent } from '@rune/shared';
import type { ReactNode } from 'react';

/** Presentational parts of the Live view: props in, markup out, so the tests render them in node. */

export function duration(seconds: number): string {
  if (seconds < 60) return '<1 min';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Under half the budget is fine; up to the budget is a warning; past it ticks are late. */
export function tickClass(ms: number): 'ok' | 'warn' | 'bad' {
  if (ms > TICK_BUDGET_MS) return 'bad';
  return ms > TICK_BUDGET_MS / 2 ? 'warn' : 'ok';
}

function ms(n: number): string {
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

export const ROOM_KIND_NAMES: Record<LiveRoomKind, string> = {
  world: 'World copy',
  dungeon: 'Dungeon',
  antechamber: 'Antechamber',
  arena: 'Arena run',
  arenaGate: 'Arena gate',
  sandbox: 'Sandbox',
  other: 'Other',
};

function Stat({ label, children, tone, title }: { label: string; children: ReactNode; tone?: string; title?: string }) {
  return (
    <div className={`live-stat${tone ? ` ${tone}` : ''}`} title={title}>
      <b>{children}</b>
      <span>{label}</span>
    </div>
  );
}

/**
 * Mean tick per second as a line, the worst tick per second as the shade above it, and the 50 ms
 * budget dashed. The scale never drops below the budget, so a quiet server reads as a flat line low
 * down rather than noise blown up to full height.
 */
export function Sparkline({ mean, max, budget = TICK_BUDGET_MS }: { mean: readonly number[]; max: readonly number[]; budget?: number }) {
  const w = 300;
  const h = 56;
  const top = Math.max(budget * 1.25, ...max);
  const n = Math.max(mean.length, 2);
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => h - (Math.min(v, top) / top) * h;
  const line = mean.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const shade = max.length > 0 ? `0,${h} ${max.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} ${x(max.length - 1).toFixed(1)},${h}` : '';
  const label = mean.length === 0 ? 'No tick samples yet' : `Tick time over the last ${Math.round(mean.length / 60)} minutes, latest ${ms(mean[mean.length - 1] ?? 0)} ms`;
  return (
    <svg className="live-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {shade && <polygon className="live-spark-max" points={shade} />}
      <line className="live-spark-budget" x1={0} x2={w} y1={y(budget)} y2={y(budget)} />
      {line && <polyline className="live-spark-mean" points={line} />}
    </svg>
  );
}

export function HealthPanel({ health }: { health: LiveHealth }) {
  const minutes = Math.max(1, Math.round(health.tickHistory.mean.length / 60));
  return (
    <section className="live-health" aria-label="Server health">
      <div className="live-stats">
        <Stat label="in the game">{health.inGame}</Stat>
        <Stat label="connections">{health.connections}</Stat>
        <Stat label={`tick, worst ${ms(health.tickMaxMs)} ms`} tone={tickClass(health.tickMaxMs)} title={`Mean and worst whole-server tick over the last 10 s; the budget is ${TICK_BUDGET_MS} ms`}>
          {ms(health.tickMs)} ms
        </Stat>
        <Stat label="messages in / out per s">
          {health.messagesIn} / {health.messagesOut}
        </Stat>
        <Stat label={`memory, heap ${health.heapMb} MB`}>{health.memoryMb} MB</Stat>
        <Stat label="uptime">{duration(health.uptimeSeconds)}</Stat>
        <Stat label="build">
          <span className="mono">{health.build.slice(0, 7)}</span>
        </Stat>
      </div>
      <figure className="live-spark-box">
        <Sparkline mean={health.tickHistory.mean} max={health.tickHistory.max} />
        <figcaption className="muted">
          Tick, {minutes} min · line mean, shade worst, dashes {TICK_BUDGET_MS} ms budget
        </figcaption>
      </figure>
    </section>
  );
}

export interface PlayerActions {
  canTeleport: boolean;
  canKick: boolean;
  onGoto: (p: LivePlayer) => void;
  onKick: (p: LivePlayer) => void;
  onOpen: (p: LivePlayer) => void;
}

export function PlayersTable({ players, actions }: { players: readonly LivePlayer[]; actions: PlayerActions }) {
  if (players.length === 0) return <p className="muted">Nobody is playing right now.</p>;
  return (
    <table className="adm-table live-table">
      <thead>
        <tr>
          <th>Character</th>
          <th>Class</th>
          <th className="num">Lvl</th>
          <th>Account</th>
          <th>Where</th>
          <th>Party</th>
          <th className="num">Online</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {players.map((p) => (
          <tr key={p.characterId}>
            <td>
              <button type="button" className="link" title={`Open ${p.account} in Players`} onClick={() => actions.onOpen(p)}>
                {p.name}
              </button>
            </td>
            <td>{CLASSES[p.classId].name}</td>
            <td className="num">{p.level}</td>
            <td>{p.account}</td>
            <td>
              {p.region}
              {p.region !== p.room && <span className="muted"> · {p.room}</span>}
              {p.game && <span className="muted mono"> {p.game}</span>}
            </td>
            <td>{p.party ?? <span className="muted">solo</span>}</td>
            <td className="num">{duration(p.onlineSeconds)}</td>
            <td className="adm-row-actions">
              {actions.canTeleport && (
                <button type="button" className="small" onClick={() => actions.onGoto(p)}>
                  Go to
                </button>
              )}
              {actions.canKick && (
                <button type="button" className="danger small" onClick={() => actions.onKick(p)}>
                  Kick
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TickCell({ room }: { room: LiveRoom }) {
  const share = Math.min(1, room.tickMaxMs / TICK_BUDGET_MS);
  return (
    <td className="num live-tick" title={`Mean ${ms(room.tickMs)} ms, worst ${ms(room.tickMaxMs)} ms over the last 5 s; budget ${TICK_BUDGET_MS} ms`}>
      <span className={tickClass(room.tickMaxMs)}>
        {ms(room.tickMs)} / {ms(room.tickMaxMs)}
      </span>
      <span className="live-bar" aria-hidden="true">
        <span className={tickClass(room.tickMaxMs)} style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
    </td>
  );
}

export function RoomsTable({ rooms }: { rooms: readonly LiveRoom[] }) {
  if (rooms.length === 0) return <p className="muted">No rooms are open.</p>;
  const sorted = [...rooms].sort((a, b) => b.players - a.players || b.tickMaxMs - a.tickMaxMs);
  return (
    <table className="adm-table live-table">
      <thead>
        <tr>
          <th>Room</th>
          <th>Kind</th>
          <th className="num">Players</th>
          <th className="num">Monsters</th>
          <th className="num">Minions</th>
          <th className="num">Spells</th>
          <th className="num">Tick ms (mean / worst)</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.id} className={r.players === 0 ? 'live-idle' : ''}>
            <td>
              {r.name} <span className="muted mono">{r.id}</span>
            </td>
            <td>{ROOM_KIND_NAMES[r.kind]}</td>
            <td className="num">{r.players}</td>
            <td className="num">{r.monsters}</td>
            <td className="num">{r.minions}</td>
            <td className="num">{r.spells}</td>
            <TickCell room={r} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function LogTail({ entries, empty, label }: { entries: readonly ServerEvent[]; empty: string; label: string }) {
  if (entries.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ol className="live-log" aria-label={label}>
      {entries.map((e) => (
        <li key={e.id} className={e.kind === 'error' ? 'err' : ''}>
          <time dateTime={new Date(e.at).toISOString()}>{clock(e.at)}</time>
          <span className={`live-kind ${e.kind}`}>{e.kind}</span>
          <span className="live-text">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** Dark, desaturated tints, one per region; the grid only says which region a cell is in. */
const REGION_TINTS = ['#353222', '#352c26', '#243024', '#36281c', '#2a2b34', '#33291f', '#22302f', '#352529'];

export function WorldMinimap({ world, children }: { world: LiveWorld; children?: ReactNode }) {
  const { width, height, regions } = world;
  // About 4 px on the side panel's 300 px map, whatever the world's size.
  const dot = Math.max(width, height) / 75;
  const runs: { key: string; x: number; y: number; w: number; h: number; tint: string; name: string }[] = [];
  if (regions) {
    const cw = width / regions.cols;
    const ch = height / regions.rows;
    // One rect per run of same-region cells in a row, so a 48-wide grid is tens of nodes, not thousands.
    for (let r = 0; r < regions.rows; r++) {
      let start = 0;
      for (let c = 1; c <= regions.cols; c++) {
        const here = regions.cells[r * regions.cols + start] ?? 0;
        if (c < regions.cols && regions.cells[r * regions.cols + c] === here) continue;
        runs.push({ key: `${r}-${start}`, x: start * cw, y: r * ch, w: (c - start) * cw + 0.5, h: ch + 0.5, tint: REGION_TINTS[here % REGION_TINTS.length] ?? '#222', name: regions.names[here] ?? '' });
        start = c;
      }
    }
  }
  const names = world.dots.map((d) => d.name).join(', ');
  return (
    <figure className="live-map">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${world.name}: ${world.dots.length === 0 ? 'nobody in the world room' : names}`}>
        <rect x={0} y={0} width={width} height={height} className="live-map-bg" />
        {runs.map((r) => (
          <rect key={r.key} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.tint}>
            <title>{r.name}</title>
          </rect>
        ))}
        {world.town && <rect className="live-map-town" x={world.town.x} y={world.town.y} width={world.town.w} height={world.town.h} />}
        {world.dots.map((d) => (
          <circle key={d.name} className={d.inParty ? 'live-dot party' : 'live-dot'} cx={d.x} cy={d.y} r={dot}>
            <title>{d.name}</title>
          </circle>
        ))}
      </svg>
      <figcaption>
        <b>{world.name}</b> <span className="muted mono">{world.game}</span> <span className="muted">· {world.dots.length} in the world</span>
        <span className="muted small live-map-seed">
          seed <span className="mono">{world.seed}</span>
          {!world.genCurrent && (
            <span className="badge" title={`Built with ${Object.entries(world.gen).map(([k, v]) => `${k} ${v}`).join(', ') || 'the code defaults'}; a rebuild takes the numbers in force now`}>
              older generation numbers
            </span>
          )}
        </span>
        {children}
      </figcaption>
    </figure>
  );
}
