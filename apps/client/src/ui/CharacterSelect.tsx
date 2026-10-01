import { ACCOUNT_RULES, can, CLASS_IDS, CLASSES, classStarterSigils, type CharacterSummary, type ClassId } from '@rune/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { takeResume } from '../game/update.js';
import { api } from '../net/api.js';
import { cssColor } from '../render/config.js';
import { useUi } from './store.js';
import { patternHint } from './validity.js';

function lastPlayed(at: number): string {
  if (at === 0) return 'Never played';
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return 'Played just now';
  if (mins < 60) return `Played ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `Played ${hours} h ago`;
  return `Played ${new Date(at).toLocaleDateString()}`;
}

function CreateCharacter({ token, onCreated, onCancel }: { token: string; onCreated: (c: CharacterSummary) => void; onCancel: (() => void) | null }) {
  const [name, setName] = useState('');
  const [classId, setClassId] = useState<ClassId>('mage');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const res = await api.createCharacter(token, name, classId);
    setBusy(false);
    if (res.ok) onCreated(res.data);
    else setError(res.error);
  };

  return (
    <form className="create-character" onSubmit={(e) => void submit(e)}>
      <h2>New character</h2>
      {error && <p className="error">{error}</p>}
      <ul className="class-list" role="radiogroup" aria-label="Class">
        {CLASS_IDS.map((id) => {
          const def = CLASSES[id];
          return (
            <li key={id}>
              <button type="button" role="radio" aria-checked={classId === id} className={classId === id ? 'on' : ''} onClick={() => setClassId(id)}>
                <span className="swatch" style={{ background: cssColor(def.color) }} />
                <strong>{def.name}</strong>
                <span>
                  {classStarterSigils(id)
                    .map((sk) => sk.name)
                    .join(', ')}
                  {id === 'binder' ? '. Commands minions.' : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <label className="name-field">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={16}
          name="character-name"
          pattern={ACCOUNT_RULES.characterNamePattern.source}
          {...patternHint('3 to 16 characters, starting with a letter')}
          placeholder="Wanderer"
          required
          autoFocus
        />
      </label>
      <div className="row-actions">
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="primary" disabled={busy}>
          Create {CLASSES[classId].name}
        </button>
      </div>
    </form>
  );
}

/**
 * A guest account lives only in this browser's session. Picking a name and password keeps it,
 * characters and all, and lets you log in anywhere.
 */
function ClaimGuest({ token, onClaimed }: { token: string; onClaimed: () => void }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await api.claim(token, username, password);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    useUi.setState({ username: res.data.username });
    onClaimed();
  };
  return (
    <section className="guest-banner">
      <p>
        You are playing as a guest. This browser is the only way back in, so <b>save your account</b> to keep your characters.
      </p>
      {!open ? (
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          Save account
        </button>
      ) : (
        <form className="account-form" onSubmit={(e) => void submit(e)}>
          {error && <p className="error">{error}</p>}
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" maxLength={16} pattern={ACCOUNT_RULES.usernamePattern.source} {...patternHint('3 to 16 letters, digits or underscores')} required autoFocus />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={ACCOUNT_RULES.passwordMin} maxLength={ACCOUNT_RULES.passwordMax} required />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Please wait' : 'Keep this account'}
          </button>
        </form>
      )}
    </section>
  );
}

export function CharacterSelect() {
  const token = useUi((s) => s.token);
  const username = useUi((s) => s.username);
  const notice = useUi((s) => s.connectionError);
  const play = useUi((s) => s.play);
  const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
  const [isStaff, setIsStaff] = useState(false);
  const [isGuest, setIsGuest] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = (attempt: number): void => {
      void api.characters(token).then((res) => {
        if (!live) return;
        if (!res.ok) {
          if (res.status === 401) {
            useUi.getState().logout();
            useUi.setState({ connectionError: 'Your session has expired, log in again' });
          } else if ((res.status === 0 || res.status >= 502) && attempt < 8) {
            // The server is restarting (a deploy, or a dev reload): try again shortly instead of showing a gateway error.
            timer = setTimeout(() => load(attempt + 1), 1500);
          } else setError(res.error);
          return;
        }
        setError(null);
        // Coming back from an update reload: go straight back in with the same character.
        const resume = takeResume();
        const again = resume ? res.data.characters.find((c) => c.id === resume.characterId) : undefined;
        if (resume && again) {
          play(again);
          return;
        }
        useUi.setState({ username: res.data.username });
        setIsStaff(can(res.data.role, 'viewAdmin'));
        setIsGuest(res.data.guest);
        setCharacters(res.data.characters);
        setSelected(res.data.characters[0]?.id ?? null);
        setCreating(res.data.characters.length === 0);
      });
    };
    load(0);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  if (!token) return null;
  const current = characters?.find((c) => c.id === selected) ?? null;

  const logout = () => {
    void api.logout(token);
    useUi.getState().logout();
  };

  const remove = async (c: CharacterSummary) => {
    const res = await api.deleteCharacter(token, c.id);
    setConfirmDelete(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const rest = (characters ?? []).filter((x) => x.id !== c.id);
    setCharacters(rest);
    setSelected(rest[0]?.id ?? null);
    if (rest.length === 0) setCreating(true);
  };

  return (
    <main className="picker characters">
      <header className="account-bar">
        <h1>Allan's ARPG</h1>
        <span className="muted">
          {isStaff && (
            <>
              <a className="link" href="/admin/">
                Admin
              </a>{' '}
            </>
          )}
          {username}{' '}
          <button type="button" className="link" onClick={logout}>
            Log out
          </button>
        </span>
      </header>
      {(error ?? notice) && <p className="error">{error ?? notice}</p>}
      {isGuest && token && <ClaimGuest token={token} onClaimed={() => setIsGuest(false)} />}
      {characters === null ? (
        <p className="tagline">Loading characters</p>
      ) : creating ? (
        <CreateCharacter
          token={token}
          onCancel={characters.length > 0 ? () => setCreating(false) : null}
          onCreated={(c) => {
            setCharacters([c, ...characters]);
            setSelected(c.id);
            setCreating(false);
          }}
        />
      ) : (
        <>
          <ul className="character-list" role="listbox" aria-label="Characters">
            {characters.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={c.id === selected}
                  className={c.id === selected ? 'on' : ''}
                  onClick={() => {
                    setSelected(c.id);
                    setConfirmDelete(false);
                  }}
                  onDoubleClick={() => play(c)}
                >
                  <span className="swatch" style={{ background: cssColor(CLASSES[c.classId].color) }} />
                  <strong>{c.name}</strong>
                  <span>
                    {CLASSES[c.classId].name}. {lastPlayed(c.playedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="row-actions">
            <button type="button" onClick={() => setCreating(true)} disabled={characters.length >= ACCOUNT_RULES.maxCharacters}>
              New character
            </button>
            {current &&
              (confirmDelete ? (
                <button type="button" className="danger" onClick={() => void remove(current)}>
                  Delete {current.name} for good
                </button>
              ) : (
                <button type="button" onClick={() => setConfirmDelete(true)}>
                  Delete
                </button>
              ))}
            <button type="button" className="primary" disabled={!current} onClick={() => current && play(current)}>
              Play{current ? ` ${current.name}` : ''}
            </button>
          </div>
        </>
      )}
      <p className="hint">WASD to move, mouse to aim, left and right click cast the skills you pick on the skill bar (click a slot with that button, or scroll; Shift+scroll for the left), 1 to 4 cast directly, I inventory, C character, T minion stance, Esc menu, Tab minimap, M world map, Alt loot names, F1 debug, F3 dev tools (builders), F8 record replay, Enter chat. Click-to-move and gamepad are in Esc, Settings.</p>
    </main>
  );
}
