import { useState } from 'react';
import { sendCommand, useUi } from './store.js';

/** Esc menu. Pauses the world when the player is alone outside town; otherwise it is only a menu. */
export function EscMenu() {
  const open = useUi((s) => s.menuOpen);
  const paused = useUi((s) => s.paused);
  const canPause = useUi((s) => s.canPause);
  const theme = useUi((s) => s.roomTheme);
  const roomName = useUi((s) => s.roomName);
  const instances = useUi((s) => s.instances);
  const toggleMenu = useUi((s) => s.toggleMenu);
  const seed = useUi((s) => s.roomSeed);
  const recording = useUi((s) => s.recording);
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
          {theme !== 'town' && (
            <button type="button" onClick={() => go({ t: 'townPortal' })}>
              Town portal
            </button>
          )}
          <button type="button" onClick={() => go({ t: 'newInstance', seed: null })}>
            New Wilds (random layout)
          </button>
          <form
            className="seed-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (parsedSeed !== null) go({ t: 'newInstance', seed: parsedSeed });
            }}
          >
            <input value={seedText} onChange={(e) => setSeedText(e.target.value)} placeholder="Seed" inputMode="numeric" aria-label="Wilds seed" />
            <button type="submit" disabled={parsedSeed === null}>
              Open seed
            </button>
          </form>
          {toggleRecording && (
            <button type="button" onClick={toggleRecording}>
              {recording ? 'Stop and save replay' : 'Record replay'} <kbd>F8</kbd>
            </button>
          )}
          <button type="button" onClick={() => useUi.getState().leave(null)}>
            Quit to title
          </button>
        </div>
        {instances.length > 0 && (
          <>
            <h3>Open instances</h3>
            <ul className="instances">
              {instances.map((i) => (
                <li key={i.roomId}>
                  <span>
                    {i.name}{' '}
                    <span className="muted">
                      {i.kind === 'staging' ? 'dungeon party' : `seed ${i.seed}`}, {i.players.length > 0 ? i.players.join(', ') : 'empty'}
                    </span>
                  </span>
                  <button type="button" onClick={() => go({ t: 'joinInstance', roomId: i.roomId })}>
                    Join
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
