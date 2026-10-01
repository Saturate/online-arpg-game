import type { ServerEvent, ServerEventKind } from '@rune/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { liveApi } from './live/liveApi.js';
import { nextPollDelay } from './live/poll.js';
import { searchId, type Jump } from './tabs.js';
import './live/live.css';

const KINDS: readonly ServerEventKind[] = ['error', 'staff', 'save', 'conversion', 'players', 'server'];
/** The server keeps this many; the page keeps the same so a long open tab does not grow without end. */
const KEEP = 4000;
const POLL_MS = 5000;
const PAGE = 1000;

function when(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

/**
 * The server's recent events (`GET /api/admin/log`, `serverLog` only), followed with the cursor the
 * route hands back. `focus` is an event id from the search; it clears the filters so the line shows.
 */
export function LogTab({ token, notify, focus }: { token: string; notify: (t: string) => void; focus: Jump | null }) {
  const [entries, setEntries] = useState<ServerEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('');
  const [kinds, setKinds] = useState<ReadonlySet<ServerEventKind>>(new Set(KINDS));
  const cursor = useRef({ next: 0, startedAt: 0 });

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_MS;
    let warned = false;
    /** Reads until the server has nothing more, then waits; returns the last status. */
    const read = async (): Promise<number> => {
      for (;;) {
        const r = await liveApi.log(token, cursor.current.next);
        if (!live) return 0;
        if (!r.ok) {
          if (r.status !== 429) notify(r.error);
          return r.status;
        }
        setLoaded(true);
        // A restart starts the ids again: what the page holds belongs to the old process, and the
        // old cursor would skip the new one's first lines, so it reads again from the start.
        if (cursor.current.startedAt !== 0 && r.data.startedAt !== cursor.current.startedAt) {
          cursor.current = { next: 0, startedAt: r.data.startedAt };
          setEntries([]);
          continue;
        }
        cursor.current = { next: r.data.next, startedAt: r.data.startedAt };
        if (r.data.entries.length > 0) setEntries((old) => [...old, ...r.data.entries].slice(-KEEP));
        // A full page means more is waiting (the route sends 1000 at most), so read on now.
        if (r.data.entries.length < PAGE) return 200;
      }
    };
    const tick = async () => {
      const status = document.hidden ? 200 : await read();
      if (!live) return;
      if (status === 429 && !warned) {
        warned = true;
        notify('The server is limiting requests; the log updates more slowly until it recovers');
      }
      if (status !== 429) warned = false;
      delay = nextPollDelay(delay, POLL_MS, status === 429);
      timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [token, notify]);

  useEffect(() => {
    if (!focus) return;
    setFilter('');
    setKinds(new Set(KINDS));
  }, [focus]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out: ServerEvent[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && kinds.has(e.kind) && (q === '' || e.text.toLowerCase().includes(q))) out.push(e);
    }
    return out;
  }, [entries, filter, kinds]);

  const toggle = (k: ServerEventKind) => {
    const next = new Set(kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setKinds(next);
  };

  return (
    <>
      <div className="adm-toolbar">
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter the log" aria-label="Filter the log" />
        {KINDS.map((k) => (
          <label key={k} className="adm-check">
            <input type="checkbox" checked={kinds.has(k)} onChange={() => toggle(k)} /> {k}
          </label>
        ))}
      </div>
      <p className="muted small log-note">
        {entries.length} lines since the server started, newest first; a restart empties it (the pod log keeps everything).
      </p>
      {!loaded ? (
        <p className="muted">Loading</p>
      ) : shown.length === 0 ? (
        <p className="muted">{entries.length === 0 ? 'Nothing logged yet.' : 'No line matches the filter.'}</p>
      ) : (
        <ol className="live-log log-full" aria-label="Server log, newest first">
          {shown.map((e) => (
            <li key={e.id} className={e.kind === 'error' ? 'err' : ''} data-search-id={searchId('log', String(e.id))} tabIndex={-1}>
              <time dateTime={new Date(e.at).toISOString()}>{when(e.at)}</time>
              <span className={`live-kind ${e.kind}`}>{e.kind}</span>
              <span className="live-text">{e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
