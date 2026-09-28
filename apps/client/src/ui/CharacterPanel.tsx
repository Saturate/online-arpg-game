import { CLASSES, GEAR_SLOTS, type GearSlot } from '@rune/shared';
import { ItemCell } from './Inventory.js';
import { itemByUid, useUi } from './store.js';

const SLOT_LABELS: Record<GearSlot, string> = {
  weapon: 'Weapon',
  helmet: 'Helmet',
  body: 'Body',
  gloves: 'Gloves',
  boots: 'Boots',
  belt: 'Belt',
  amulet: 'Amulet',
  ring1: 'Ring',
  ring2: 'Ring',
};

/** Paperdoll positions on a 3 x 4 grid around the character silhouette. */
const SLOT_AREA: Record<GearSlot, string> = {
  helmet: 'helmet',
  amulet: 'amulet',
  weapon: 'weapon',
  body: 'body',
  gloves: 'gloves',
  ring1: 'ring1',
  ring2: 'ring2',
  belt: 'belt',
  boots: 'boots',
};

function pct(v: number): string {
  return `${Math.round((v - 1) * 100)}%`;
}

export function CharacterPanel() {
  const open = useUi((s) => s.characterOpen);
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const name = useUi((s) => s.name);
  const stats = useUi((s) => s.stats);
  const level = useUi((s) => s.level);
  if (!open || !inv || !classId) return null;
  const cls = CLASSES[classId];

  return (
    <section className="panel character" aria-label="Character">
      <header>
        <h2>{name}</h2>
        <span className="muted">
          Level {level} {cls.name}
        </span>
        <button type="button" className="close" onClick={() => useUi.setState({ characterOpen: false })} aria-label="Close character panel">
          x
        </button>
      </header>
      <div className="paperdoll">
        <div className="silhouette" aria-hidden="true" style={{ borderColor: `#${cls.color.toString(16).padStart(6, '0')}` }} />
        {GEAR_SLOTS.map((slot) => {
          const item = itemByUid(inv, inv.gear[slot]);
          return (
            <ItemCell
              key={slot}
              item={item}
              place={{ at: 'gear', slot }}
              className="gear-slot"
              iconSize={40}
              label={item ? undefined : SLOT_LABELS[slot]}
              style={{ gridArea: SLOT_AREA[slot] }}
            />
          );
        })}
      </div>
      {stats && (
        <dl className="stat-sheet">
          <dt>Life</dt>
          <dd>{Math.round(stats.maxLife)}</dd>
          <dt>Armour</dt>
          <dd>{Math.round(stats.armor)}</dd>
          <dt>Movement</dt>
          <dd>{Math.round(stats.moveSpeed)}</dd>
          <dt>Force</dt>
          <dd>{Math.round(stats.heatMax)}</dd>
          <dt>Force recovery</dt>
          <dd>{pct(stats.heatCooling)}</dd>
          <dt>Spirit</dt>
          <dd>{Math.round(stats.spiritMax)}</dd>
          <dt>Damage</dt>
          <dd>{pct(stats.damageMult)}</dd>
          <dt>Cast speed</dt>
          <dd>{pct(stats.castSpeedMult)}</dd>
          <dt>Attack speed</dt>
          <dd>{pct(stats.attackSpeedMult)}</dd>
          <dt>Life regen</dt>
          <dd>{stats.lifeRegen.toFixed(1)}/s</dd>
          {classId === 'binder' && (
            <>
              <dt>Minion damage</dt>
              <dd>{pct(stats.minionDamageMult)}</dd>
              <dt>Minion life</dt>
              <dd>{pct(stats.minionLifeMult)}</dd>
            </>
          )}
        </dl>
      )}
      <p className="muted small">Right-click gear to take it off, or drag it back to the bag.</p>
    </section>
  );
}
