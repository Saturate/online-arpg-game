import { ACCOUNT_RULES, CLASS_IDS, CLASSES, classSkills, type CharacterSummary, type ClassId, type GameMode } from '@rune/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../net/api.js';
import { cssColor } from '../render/config.js';
import { useUi } from './store.js';

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
                  {classSkills(id)
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
          pattern={ACCOUNT_RULES.characterNamePattern.source}
          title="3 to 16 characters, starting with a letter"
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

export function CharacterSelect() {
  const token = useUi((s) => s.token);
  const username = useUi((s) => s.username);
  const notice = useUi((s) => s.connectionError);
  const play = useUi((s) => s.play);
  const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mode, setMode] = useState<GameMode>('world');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void api.characters(token).then((res) => {
      if (!live) return;
      if (!res.ok) {
        if (res.status === 401) {
          useUi.getState().logout();
          useUi.setState({ connectionError: 'Your session has expired, log in again' });
        } else setError(res.error);
        return;
      }
      useUi.setState({ username: res.data.username });
      setCharacters(res.data.characters);
      setSelected(res.data.characters[0]?.id ?? null);
      setCreating(res.data.characters.length === 0);
    });
    return () => {
      live = false;
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
        <h1>Rune</h1>
        <span className="muted">
          {username}{' '}
          <button type="button" className="link" onClick={logout}>
            Log out
          </button>
        </span>
      </header>
      {(error ?? notice) && <p className="error">{error ?? notice}</p>}
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
                  onDoubleClick={() => play(c, mode)}
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
          <div className="mode-switch" role="radiogroup" aria-label="Mode">
            <button type="button" role="radio" aria-checked={mode === 'world'} className={mode === 'world' ? 'on' : ''} onClick={() => setMode('world')}>
              <strong>World</strong>
              <span>Start in town, explore generated Wilds. Progress is saved.</span>
            </button>
            <button type="button" role="radio" aria-checked={mode === 'arena'} className={mode === 'arena' ? 'on' : ''} onClick={() => setMode('arena')}>
              <strong>Arena</strong>
              <span>Waves and free sigil editing. Nothing here is saved.</span>
            </button>
          </div>
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
            <button type="button" className="primary" disabled={!current} onClick={() => current && play(current, mode)}>
              Play{current ? ` ${current.name}` : ''}
            </button>
          </div>
        </>
      )}
      <p className="hint">WASD to move, mouse to aim, left click to attack, 1 to 4 for skills, I inventory, C character, T minion stance, Esc menu, Tab minimap, Alt loot names, F1 debug, F3 sandbox.</p>
    </main>
  );
}
