import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closePlayerMenu, playerMenuItems, usePlayerMenu, type PlayerMenuItem } from './playerActions.js';
import { sendCommand, useUi } from './store.js';

const LABELS: Record<PlayerMenuItem, string> = { whisper: 'Whisper', party: 'Invite to party', guild: 'Invite to guild' };

function run(item: PlayerMenuItem, name: string): void {
  if (item === 'whisper') useUi.setState({ chatOpen: true, chatDraft: `/w ${name} ` });
  else if (item === 'party') sendCommand({ t: 'partyInvite', name });
  else sendCommand({ t: 'guildInvite', name });
  closePlayerMenu();
}

/** The right-click menu on another player, at the mouse. Any click elsewhere or Escape closes it. */
export function PlayerMenu() {
  const { name, tag, x, y } = usePlayerMenu();
  const me = useUi((s) => s.name);
  const party = useUi((s) => s.partyInfo);
  const guild = useUi((s) => s.guild);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Keyboard users land on the first action; Escape still closes it.
    el.querySelector('button')?.focus({ preventScroll: true });
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4)), top: Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4)) });
  }, [x, y, name]);

  useEffect(() => {
    if (name === null) return;
    const away = (e: MouseEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      closePlayerMenu();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Before the game's own Escape, which would open the menu or close the bag.
      e.stopPropagation();
      closePlayerMenu();
    };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [name]);

  if (name === null) return null;
  const items = playerMenuItems(name, me, party, guild, tag);
  if (items.length === 0) return null;
  return (
    <div ref={ref} className="player-menu" role="menu" aria-label={`Actions for ${name}`} style={{ left: pos.left, top: pos.top }}>
      <p className="player-menu-name">{name}</p>
      {items.map((item) => (
        <button key={item} type="button" role="menuitem" className="bare" onClick={() => run(item, name)}>
          {LABELS[item]}
        </button>
      ))}
    </div>
  );
}
