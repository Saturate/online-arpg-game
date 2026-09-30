import { CLASSES, type PartyMemberStatus, type PartyPlace } from '@rune/shared';
import type { CSSProperties } from 'react';
import { cssColor } from '../render/config.js';
import { tip } from './Tip.js';
import './party.css';
import { useUi } from './store.js';

const PLACE_LABEL: Record<PartyPlace, string> = {
  town: 'In town',
  wilds: 'Wilds',
  dungeon: 'Dungeon',
  arena: 'Arena',
  sandbox: 'Sandbox',
  offline: 'Offline',
};

function Frame({ m }: { m: PartyMemberStatus }) {
  // Same room: the snapshot carries life every tick, so the bar keeps up with a fight.
  const live = useUi((s) => s.party.find((p) => p.name === m.name));
  const channelling = useUi((s) => s.teleport?.to === m.name);
  const life = live?.life ?? m.life;
  const maxLife = live?.maxLife ?? m.maxLife;
  const dead = live?.dead ?? m.dead;
  const offline = m.place === 'offline';
  const ratio = maxLife > 0 ? Math.max(0, Math.min(1, life / maxLife)) : 0;
  const color = m.cls ? cssColor(CLASSES[m.cls].color) : '#6a6258';
  const state = dead ? 'Dead' : PLACE_LABEL[m.place];
  const go = () => useUi.getState().send?.({ t: 'partyTeleport', name: m.name });
  const style: CSSProperties & Record<'--cls', string> = { '--cls': color };
  return (
    <button
      type="button"
      className={`pframe${offline ? ' offline' : ''}${dead ? ' dead' : ''}${m.no ? ' refused' : ''}${channelling ? ' going' : ''}`}
      style={style}
      onClick={go}
      aria-label={`${m.name}, ${state}${m.zone ? `, ${m.zone}` : ''}. ${m.no ?? 'Click to teleport'}`}
      {...tip(m.no ?? `Teleport to ${m.name}: stand still for 3 s`)}
    >
      <span className="pframe-top">
        <span className="pframe-name">{m.name}</span>
        {m.level > 0 && <small>Lv {m.level}</small>}
      </span>
      <span className="pframe-bar">
        <span style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="pframe-where">
        <span className={`pframe-state ${dead ? 'dead' : m.place}`}>{state}</span>
        {m.zone && <span className="pframe-zone">{m.zone}</span>}
        {!m.no && <span className="pframe-go">Go to</span>}
      </span>
    </button>
  );
}

/** Always on screen in a party: every other member, wherever they are, and a click to go to them. */
export function PartyFrames() {
  const members = useUi((s) => s.partyStatus);
  const inParty = useUi((s) => s.partyInfo !== null);
  if (!inParty || members.length === 0) return null;
  return (
    <div className="party-frames" role="group" aria-label="Party">
      {members.map((m) => (
        <Frame key={m.name} m={m} />
      ))}
    </div>
  );
}

/** The teleport channel as a cast bar. The fill is a CSS animation, so nothing runs per frame here. */
export function TeleportBar() {
  const teleport = useUi((s) => s.teleport);
  if (!teleport) return null;
  // Timed from when the channel started, so a re-render midway does not restart the fill.
  const elapsed = Math.max(0, teleport.seconds - (teleport.endsAt - performance.now()) / 1000);
  const style: CSSProperties = { animationDuration: `${teleport.seconds}s`, animationDelay: `-${elapsed}s` };
  return (
    <div className="cast-bar" role="progressbar" aria-label={`Teleporting to ${teleport.to}`}>
      <div key={teleport.endsAt} className="cast-bar-fill" style={style} />
      <span>Teleporting to {teleport.to}</span>
    </div>
  );
}
