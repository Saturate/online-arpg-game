import { useState } from 'react';
import { GamePanel, useMovablePanel } from './GamePanel.js';
import { keyLabel, useSettings } from './settings.js';
import { sendCommand, useUi } from './store.js';

/** Esc menu. Pauses the world when the player is alone outside town; otherwise it is only a menu. */
export function EscMenu() {
  const open = useUi((s) => s.menuOpen);
  const paused = useUi((s) => s.paused);
  const canPause = useUi((s) => s.canPause);
  const roomName = useUi((s) => s.roomName);
  const world = useUi((s) => s.world);
  const party = useUi((s) => s.partyInfo);
  const toggleMenu = useUi((s) => s.toggleMenu);
  const recording = useUi((s) => s.recording);
  const recordKey = useSettings((s) => s.bindings.record);
  const toggleRecording = useUi((s) => s.toggleRecording);
  const [inviteName, setInviteName] = useState('');
  if (!open) return null;

  const go = (msg: Parameters<typeof sendCommand>[0]) => {
    sendCommand(msg);
    toggleMenu();
  };

  return (
    <div className="menu-backdrop" role="dialog" aria-label="Menu">
      <GamePanel id="menu" className="menu" title={paused ? 'Paused' : 'Menu'}>
        <p className="muted">
          {roomName}
          {world ? `, ${world.name} (${world.players}/${world.capacity})` : ''}
          {paused ? '. The world is frozen until you resume.' : canPause ? '' : '. Others are here or this is town, so the world keeps running.'}
        </p>
        <div className="menu-actions">
          <button type="button" onClick={toggleMenu} autoFocus>
            Resume
          </button>
          <button type="button" onClick={() => go({ t: 'townPortal' })}>
            Town portal
          </button>
          {party && world?.kind !== 'party' && (
            <button type="button" onClick={() => go({ t: 'partyWorld' })}>
              {party.hasWorld ? 'Join the party world' : 'Open a party world'}
            </button>
          )}
          {world?.kind === 'party' && (
            <button type="button" onClick={() => go({ t: 'publicWorld' })}>
              Back to the public world
            </button>
          )}
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
        <h3>Party</h3>
        {party ? (
          <ul className="instances">
            {party.members.map((m) => (
              <li key={m.name}>
                <span>
                  {m.name}
                  {m.name === party.leader ? <span className="muted"> (leader)</span> : null}
                </span>
                <span className="muted">{m.online ? 'online' : 'offline'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Invite someone to play in the same world and share a party world of your own.</p>
        )}
        <form
          className="seed-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!inviteName.trim()) return;
            sendCommand({ t: 'partyInvite', name: inviteName.trim() });
            setInviteName('');
          }}
        >
          <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Character name" maxLength={24} aria-label="Invite to party" />
          <button type="submit" disabled={!inviteName.trim()}>
            Invite
          </button>
        </form>
        {party && (
          <button type="button" onClick={() => go({ t: 'partyLeave' })}>
            Leave party
          </button>
        )}
        <p className="muted small">
          <kbd>Esc</kbd> menu <kbd>Tab</kbd> minimap <kbd>Alt</kbd> show all loot
        </p>
      </GamePanel>
    </div>
  );
}

/** The invite prompt, like D2's party request, answered with a click or /accept and /decline. */
export function PartyInvitePrompt() {
  const from = useUi((s) => s.partyInvite);
  const { ref, handleProps } = useMovablePanel('party-invite');
  if (!from) return null;
  const answer = (accept: boolean) => {
    sendCommand({ t: 'partyAnswer', accept });
    useUi.setState({ partyInvite: null });
  };
  return (
    <div className="panel party-invite" role="alertdialog" aria-label="Party invite" ref={ref} {...handleProps}>
      <p>
        <b>{from}</b> invites you to a party.
      </p>
      <div className="menu-actions row">
        <button type="button" className="primary" onClick={() => answer(true)}>
          Join
        </button>
        <button type="button" onClick={() => answer(false)}>
          Decline
        </button>
      </div>
    </div>
  );
}
