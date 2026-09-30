import { CLASSES, PROGRESSION } from '@rune/shared';
import type { ReactNode } from 'react';
import { GamePanel } from './GamePanel.js';
import { useUi } from './store.js';
import { tip } from './Tip.js';

function pct(v: number): string {
  const n = Math.round((v - 1) * 100);
  return `${n >= 0 ? '+' : ''}${n}%`;
}

function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="cs-row" {...tip(hint)}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** The character sheet: level and every derived stat, grouped the way players think about them. */
export function CharacterPanel() {
  const open = useUi((s) => s.characterOpen);
  const classId = useUi((s) => s.classId);
  const name = useUi((s) => s.name);
  const stats = useUi((s) => s.stats);
  const level = useUi((s) => s.level);
  const xp = useUi((s) => s.xp);
  const xpNext = useUi((s) => s.xpNext);
  if (!open || !classId) return null;
  const cls = CLASSES[classId];
  const ratio = xpNext > 0 ? Math.min(1, xp / xpNext) : 1;

  return (
    <GamePanel id="character" className="cs-window" headerClassName="inv-header" aria-label="Character" title={name} onClose={() => useUi.setState({ characterOpen: false })} closeLabel="Close character sheet">
      <div className="cs-identity">
        <span className="cs-level">{level}</span>
        <div>
          <strong>{cls.name}</strong>
          <div className="cs-xp" {...tip(`${xp.toLocaleString()} / ${xpNext.toLocaleString()} XP`)}>
            <div style={{ width: `${ratio * 100}%` }} />
          </div>
          <span className="muted small">{level >= PROGRESSION.maxLevel ? 'Maximum level' : `${Math.floor(ratio * 100)}% to level ${level + 1}`}</span>
        </div>
      </div>
      {stats && (
        <>
          <h3 className="inv-section">Defence</h3>
          <dl className="cs-grid">
            <Row label="Life" value={Math.round(stats.maxLife)} />
            <Row label="Armour" value={Math.round(stats.armor)} hint="Reduces the damage of each hit" />
            <Row label="Life regen" value={`${stats.lifeRegen.toFixed(1)}/s`} />
            <Row label="Movement" value={Math.round(stats.moveSpeed)} />
          </dl>
          <h3 className="inv-section">Offence</h3>
          <dl className="cs-grid">
            <Row label="Damage" value={pct(stats.damageMult)} />
            <Row label="Cast speed" value={pct(stats.castSpeedMult)} />
            <Row label="Attack speed" value={pct(stats.attackSpeedMult)} />
          </dl>
          <h3 className="inv-section">Force and spirit</h3>
          <dl className="cs-grid">
            <Row label="Force" value={Math.round(stats.heatMax)} hint="Casting builds Force; past the limit, skills misfire" />
            <Row label="Recovery" value={pct(stats.heatCooling)} />
            <Row label="Spirit" value={Math.round(stats.spiritMax)} hint="Reserved by auras, links and bound minions" />
          </dl>
          {classId === 'binder' && (
            <>
              <h3 className="inv-section">Minions</h3>
              <dl className="cs-grid">
                <Row label="Minion damage" value={pct(stats.minionDamageMult)} />
                <Row label="Minion life" value={pct(stats.minionLifeMult)} />
              </dl>
            </>
          )}
        </>
      )}
    </GamePanel>
  );
}
