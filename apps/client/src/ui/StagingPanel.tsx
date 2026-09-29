import { CLASSES } from '@rune/shared';
import { cssColor } from '../render/config.js';
import { keyLabel, useSettings } from './settings.js';
import { sendCommand, useUi } from './store.js';

/** Antechamber party list and ready check. The gate opens when everyone here is ready. */
export function StagingPanel() {
  const staging = useUi((s) => s.staging);
  const name = useUi((s) => s.name);
  const readyKey = useSettings((s) => s.bindings.ready);
  if (!staging) return null;
  const arena = staging.kind === 'arena';
  const me = staging.members.find((m) => m.name === name);
  const readyCount = staging.members.filter((m) => m.ready).length;
  return (
    <section className="panel staging-panel" aria-label={arena ? 'Arena party' : 'Dungeon party'}>
      <header>
        <h2>{arena ? 'Arena party' : 'Dungeon party'}</h2>
        <span className="muted">
          {arena ? 'Wave 1 at level' : 'Monster level'} {staging.level}
        </span>
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
      {staging.cleared && <p className="cleared">Last run cleared</p>}
      {staging.countdown !== null ? (
        <p className="countdown">
          {arena ? 'Into the pit in' : 'Descending in'} {staging.countdown}
        </p>
      ) : staging.open ? (
        <p className="muted">
          A run is under way with {staging.inside} inside. Walk through the gate to join them.
        </p>
      ) : arena ? (
        <p className="muted">
          {readyCount} of {staging.members.length} ready. Everyone here goes in together, one life each; nobody can join once it starts.
          {staging.inside > 0 && ` ${staging.inside} fighting in the pit now.`}
        </p>
      ) : (
        <p className="muted">
          {readyCount} of {staging.members.length} ready. Wait here for friends; they can join from the Esc menu.
        </p>
      )}
      <div className="row-actions">
        <button type="button" className={me?.ready ? 'on' : ''} onClick={() => sendCommand({ t: 'ready', ready: !(me?.ready ?? false) })}>
          {me?.ready ? 'Not ready' : 'Ready'} <kbd>{keyLabel(readyKey)}</kbd>
        </button>
        {arena && (
          <button type="button" onClick={() => useUi.setState((s) => ({ boardOpen: !s.boardOpen }))}>
            Leaderboard
          </button>
        )}
      </div>
    </section>
  );
}
