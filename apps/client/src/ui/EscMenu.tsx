import { useState } from 'react';
import { keyLabel, useSettings } from './settings.js';
import { sendCommand, useUi } from './store.js';

/** Esc menu. Pauses the world when the player is alone outside town; otherwise it is only a menu. */
export function EscMenu() {
  const open = useUi((s) => s.menuOpen);
  const paused = useUi((s) => s.paused);
  const canPause = useUi((s) => s.canPause);
  const roomName = useUi((s) => s.roomName);
  const instances = useUi((s) => s.instances);
  const toggleMenu = useUi((s) => s.toggleMenu);
  const seed = useUi((s) => s.roomSeed);
  const recording = useUi((s) => s.recording);
  const recordKey = useSettings((s) => s.bindings.record);
  const toggleRecording = useUi((s) => s.toggleRecording);
  const [seedText, setSeedText] = useState('');
  if (!open) return null;
  const parsedSeed = /^\d{1,9}$/.test(seedText.trim()) ? Number(seedText.trim()) : null;

  const go = (msg: Parameters<typeof sendCommand>[0]) => {
    sendCommand(msg);
    toggleMenu();
  };

  return (
    <div className="menu-backdrop" role="dialog" aria-label="Menu">
      <section className="panel menu">
        <h2>{paused ? 'Paused' : 'Menu'}</h2>
        <p className="muted">
          {roomName}
          {seed !== null ? ` (seed ${seed})` : ''}
          {paused ? '. The world is frozen until you resume.' : canPause ? '' : '. Others are here or this is town, so the world keeps running.'}
        </p>
        <div className="menu-actions">
          <button type="button" onClick={toggleMenu} autoFocus>
            Resume
          </button>
          <button type="button" onClick={() => go({ t: 'townPortal' })}>
            Town portal
          </button>
          <button type="button" onClick={() => go({ t: 'newInstance', seed: null })}>
            New game (fresh world)
          </button>
          <form
            className="seed-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (parsedSeed !== null) go({ t: 'newInstance', seed: parsedSeed });
            }}
          >
            <input value={seedText} onChange={(e) => setSeedText(e.target.value)} placeholder="Seed" inputMode="numeric" aria-label="World seed" />
            <button type="submit" disabled={parsedSeed === null}>
              New game from seed
            </button>
          </form>
          {toggleRecording && (
            <button type="button" onClick={toggleRecording}>
              {recording ? 'Stop and save replay' : 'Record replay'} <kbd>{keyLabel(recordKey)}</kbd>
            </button>
          )}
          <button type="button" onClick={() => useUi.setState({ settingsOpen: true })}>
            Settings
          </button>
          <button type="button" onClick={() => useUi.getState().leave(null)}>
            Quit to title
          </button>
        </div>
        {instances.length > 0 && (
          <>
            <h3>Games</h3>
            <ul className="instances">
              {instances.map((i) => (
                <li key={i.id}>
                  <span>
                    {i.name}{' '}
                    <span className="muted">
                      {i.players.length}/{i.capacity}
                      {i.players.length > 0 ? `: ${i.players.join(', ')}` : ''}
                    </span>
                  </span>
                  <button type="button" disabled={i.yours || i.players.length >= i.capacity} onClick={() => go({ t: 'joinInstance', id: i.id })}>
                    {i.yours ? 'You are here' : i.players.length >= i.capacity ? 'Full' : 'Join'}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted small">
          <kbd>Esc</kbd> menu <kbd>Tab</kbd> minimap <kbd>Alt</kbd> show all loot
        </p>
      </section>
    </div>
  );
}
