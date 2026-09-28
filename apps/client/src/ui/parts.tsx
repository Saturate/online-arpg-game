import type { CSSProperties } from 'react';
import {
  COMBOS,
  HEAT,
  describeSpell,
  formatAffix,
  MINION_DEFS,
  RUNES,
  gearBase,
  sigilCapacity,
  STAT_IDS,
  STAT_LABELS,
  skillById,
  vesselSpirit,
  type ClassId,
  type CompileResult,
  type Item,
  type RuneId,
} from '@rune/shared';
import { cssColor, TIER_COLORS } from '../render/config.js';
import { compileFor, useUi } from './store.js';

export function RuneChip({ id, small = false, onClick }: { id: RuneId; small?: boolean; onClick?: () => void }) {
  const def = RUNES[id];
  const style: CSSProperties & Record<'--rune', string> = { '--rune': cssColor(def.color) };
  return (
    <span
      className={`rune-chip cat-${def.category}${small ? ' small' : ''}`}
      style={style}
      title={`${def.name} (${def.category})`}
      onClick={onClick}
    >
      <b>{def.syllable}</b>
      {!small && <i>{def.name}</i>}
    </span>
  );
}

export function tierColor(item: Item): string {
  return cssColor(TIER_COLORS[item.tier]);
}

/** Stability wording only. The reason for a dud is deliberately hidden outside the debug overlay. */
export function CostLine({ result }: { result: CompileResult }) {
  if (!result.ok) {
    return (
      <span className="cost unstable">
        Unstable <em>{Math.round(result.heat * 0.5)} {HEAT.displayName} on fizzle</em>
      </span>
    );
  }
  if (result.persistent) return <span className="cost stable">Persistent, reserves {result.spirit} spirit</span>;
  return (
    <span className="cost stable">
      {Math.round(result.heat)} {HEAT.displayName}
    </span>
  );
}

/** Affix lines with their tier, so a T3 roll is visibly better than a T1. */
function Affixes({ item }: { item: Item }) {
  if (item.affixes.length === 0) return null;
  return (
    <ul className="affixes">
      {item.affixes.map((a, i) => (
        <li key={i}>
          {formatAffix(a)} <span className="tier">T{a.tier + 1}</span>
        </li>
      ))}
    </ul>
  );
}

function GearDetails({ item }: { item: Extract<Item, { kind: 'gear' }> }) {
  const base = gearBase(item.base);
  return (
    <div className="item-details">
      <h4 style={{ color: tierColor(item) }}>{item.name}</h4>
      <p className="muted">
        {base?.name ?? item.base}, {item.category}, item level {item.ilvl}
      </p>
      {base && (
        <ul className="implicit">
          {STAT_IDS.filter((k) => base.implicit[k] !== undefined).map((k) => (
            <li key={k}>{STAT_LABELS[k](base.implicit[k] ?? 0)}</li>
          ))}
        </ul>
      )}
      <Affixes item={item} />
      {base?.classes && <p className="muted">Usable by: {base.classes.join(', ')}</p>}
    </div>
  );
}

export function ItemDetails({ item, classId }: { item: Item; classId: ClassId }) {
  if (item.kind === 'gear') return <GearDetails item={item} />;
  const debug = useUi((s) => s.debugVisible);
  const editorAllowed = useUi((s) => s.editorAllowed);
  if (item.kind === 'vessel') {
    const def = MINION_DEFS[item.minion];
    return (
      <div className="item-details">
        <h4 style={{ color: tierColor(item) }}>{item.name}</h4>
        <p className="muted">
          {item.tier} vessel, level {item.level}. {def.name}: {def.ranged ? 'ranged' : 'melee'}, defaults to {def.defaultBehaviour}.
        </p>
        <Affixes item={item} />
        <p className="muted">Reserves {vesselSpirit(item)} spirit when bound. Item level {item.ilvl}.</p>
      </div>
    );
  }
  const result = compileFor(item, classId);
  const skill = skillById(item.skill);
  return (
    <div className="item-details">
      <h4 style={{ color: tierColor(item) }}>{item.name}</h4>
      {skill && (
        <p className="skill-line">
          <strong>{skill.name}</strong>: {skill.description}
        </p>
      )}
      <p className="muted">
        {item.tier} sigil, item level {item.ilvl}
        {skill ? '' : `, ${sigilCapacity(item)} rune slots`}
        {item.corrupted ? ', corrupted: more misfires' : ''}
      </p>
      <Affixes item={item} />
      <div className="rune-row">
        {item.runes.length === 0 ? <span className="muted">{editorAllowed ? 'Blank. Inscribe it with K.' : 'Blank. Sigils can be inscribed in the Arena.'}</span> : item.runes.map((r, i) => <RuneChip key={i} id={r} small />)}
      </div>
      {item.runes.length > 0 && <CostLine result={result} />}
      {result.ok &&
        result.combos.map((c) => (
          <p key={c} className="combo">
            {COMBOS.find((x) => x.id === c)?.name}
          </p>
        ))}
      {debug && item.runes.length > 0 && (
        <p className="debug-line">{result.ok ? describeSpell(result.program) : `dud: ${result.dud}`}</p>
      )}
    </div>
  );
}
