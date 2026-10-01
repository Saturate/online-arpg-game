import { can, SEARCH_QUERY, type Role } from '@rune/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { adminApi } from '../../net/api.js';
import { listTryOns } from '../../render/tryOn.js';
import { liveApi } from '../live/liveApi.js';
import { TAB_NAMES } from '../tabs.js';
import { accountEntries, allowedEntries, KIND_NAMES, logEntries, rankEntries, staticEntries, tokenEntries, tryOnEntries, type SearchEntry } from './searchIndex.js';
import './search.css';

/** Long enough that typing a name is one server search, short enough to feel immediate. */
const DEBOUNCE_MS = 200;
const SHOWN = 12;

export function isSearchShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k';
}

/**
 * The header's search box (Ctrl+K or Cmd+K anywhere on the page). Settings, tuning, monsters,
 * minions and model checks are searched here; accounts, characters and log lines on the server,
 * which leaves out what the role may not see. Results for tabs the role cannot open are dropped too.
 */
export function SearchBox({ token, role, onJump }: { token: string; role: Role; onJump: (entry: SearchEntry) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loaded, setLoaded] = useState<SearchEntry[]>([]);
  const [server, setServer] = useState<{ q: string; entries: SearchEntry[] } | null>(null);
  const fetchedExtras = useRef(false);
  const fixed = useMemo(() => staticEntries(), []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isSearchShortcut(e)) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Tokens and try-ons are fetched once, on first use, rather than with every page load. */
  const loadExtras = () => {
    if (fetchedExtras.current) return;
    fetchedExtras.current = true;
    const tokens = can(role, 'apiTokens') ? adminApi.tokens(token).then((r) => (r.ok ? tokenEntries(r.data) : [])) : Promise.resolve([]);
    const tryOns = listTryOns().then(tryOnEntries, () => []);
    void Promise.all([tokens, tryOns]).then(([a, b]) => setLoaded([...a, ...b]));
  };

  const q = query.trim();
  useEffect(() => {
    if (q.length < SEARCH_QUERY.min || q.length > SEARCH_QUERY.max) return;
    let live = true;
    const t = setTimeout(() => {
      void liveApi.search(token, q).then((r) => {
        if (live && r.ok) setServer({ q, entries: [...accountEntries(r.data.accounts), ...logEntries(r.data.log ?? [])] });
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, token]);

  const results = useMemo(() => {
    if (q === '') return [];
    // Server results stay while the next query is on its way, ranked against what is typed now.
    const fromServer = server?.entries ?? [];
    return rankEntries(allowedEntries([...fixed, ...loaded, ...fromServer], role), q, SHOWN);
  }, [q, fixed, loaded, server, role]);

  const pending = q.length >= SEARCH_QUERY.min && server?.q !== q;

  const jump = (entry: SearchEntry | undefined) => {
    if (!entry) return;
    setOpen(false);
    input.current?.blur();
    onJump(entry);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      jump(results[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      input.current?.blur();
    }
  };

  const show = open && q !== '';
  return (
    <div className="srch">
      <input
        ref={input}
        type="search"
        value={query}
        placeholder="Search everything (Ctrl+K)"
        aria-label="Search the admin page"
        role="combobox"
        aria-expanded={show}
        aria-controls="srch-results"
        aria-activedescendant={show && results[active] ? `srch-${results[active].id}` : undefined}
        aria-autocomplete="list"
        onFocus={() => {
          loadExtras();
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {show && (
        <ul id="srch-results" className="srch-results" role="listbox" aria-label="Search results">
          {results.length === 0 && <li className="srch-empty muted">{pending ? 'Searching' : 'Nothing found'}</li>}
          {results.map((r, i) => (
            <li
              key={r.id}
              id={`srch-${r.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : ''}
              // Before the input's blur, which would close the list under the click.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => jump(r)}
            >
              <span className={`srch-kind ${r.kind}`}>{KIND_NAMES[r.kind]}</span>
              <span className="srch-title">{r.title}</span>
              <span className="srch-detail muted">{r.detail}</span>
              <span className="srch-tab muted">{TAB_NAMES[r.tab]}</span>
            </li>
          ))}
          {results.length > 0 && pending && <li className="srch-empty muted">Searching players and the log</li>}
        </ul>
      )}
    </div>
  );
}
