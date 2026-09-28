import { CLASSES } from '@rune/shared';
import { cssColor } from '../render/config.js';
import { sendCommand, useUi } from './store.js';

/** Antechamber party list and ready check. The gate opens when everyone here is ready. */
export function StagingPanel() {
  const staging = useUi((s) => s.staging);
  const name = useUi((s) => s.name);
  if (!staging) return null;
  const me = staging.members.find((m) => m.name === name);
  const readyCount = staging.members.filter((m) => m.ready).length;
  return (
    <section className="panel staging-panel" aria-label="Dungeon party">
      <header>
        <h2>Dungeon party</h2>
        <span className="muted">Monster level {staging.level}</span>
      </header>
      <ul>
        {staging.members.map((m) => (
          <li key={m.name} className={m.ready ? 'ready' : ''}>
            <span className="dot" style={{ background: cssColor(CLASSES[m.cls].color) }} />
            <span className="pname">{m.name}</span>
            <span className="state">{m.ready ? 'Ready' : 'Waiting'}</span>
          </li>
        ))}
      </ul>
      {staging.countdown !== null ? (
        <p className="countdown">Descending in {staging.countdown}</p>
      ) : staging.open ? (
        <p className="muted">
          A run is under way with {staging.inside} inside. Walk through the gate to join them.
        </p>
      ) : (
        <p className="muted">
          {readyCount} of {staging.members.length} ready. Wait here for friends; they can join from the Esc menu.
        </p>
      )}
      <button type="button" className={me?.ready ? 'on' : ''} onClick={() => sendCommand({ t: 'ready', ready: !(me?.ready ?? false) })}>
        {me?.ready ? 'Not ready' : 'Ready'} <kbd>R</kbd>
      </button>
    </section>
  );
}
