import type { CSSProperties } from 'react';
import {
  COMBOS,
  HEAT,
  describeSpell,
  formatAffix,
  MINION_DEFS,
  RUNES,
  gearBase,
  levelRequirement,
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
    <ul className="affixes tt-sec">
      {item.affixes.map((a, i) => (
        <li key={i}>
          {formatAffix(a)} <span className={`tier t${a.tier + 1}`}>T{a.tier + 1}</span>
        </li>
      ))}
    </ul>
  );
}

const TIER_NAMES: Record<Item['tier'], string> = { common: 'Common', magic: 'Magic', rare: 'Rare', relic: 'Relic' };

function Head({ item, sub }: { item: Item; sub: string }) {
  return (
    <header className="tt-head">
      <h4 style={{ color: tierColor(item) }}>{item.name}</h4>
      <p className="tt-base">
        {TIER_NAMES[item.tier]} {sub}
      </p>
    </header>
  );
}

/** Red when the character cannot meet it, like D2's unusable item text. */
function Requirements({ item, classes }: { item: Item; classes?: readonly ClassId[] | undefined }) {
  const level = useUi((s) => s.level);
  const classId = useUi((s) => s.classId);
  const need = levelRequirement(item);
  const wrongClass = classes !== undefined && classId !== null && !classes.includes(classId);
  if (need <= 1 && !classes) return null;
  return (
    <section className="tt-sec tt-req">
      {need > 1 && <p className={need > level ? 'requirement unmet' : 'requirement'}>Requires level {need}</p>}
      {classes && <p className={wrongClass ? 'requirement unmet' : 'requirement'}>{classes.map((c) => c[0]?.toUpperCase() + c.slice(1)).join(' or ')} only</p>}
    </section>
  );
}

function GearDetails({ item }: { item: Extract<Item, { kind: 'gear' }> }) {
  const base = gearBase(item.base);
  const implicit = base ? STAT_IDS.filter((k) => base.implicit[k] !== undefined) : [];
  return (
    <div className="item-details">
      <Head item={item} sub={base?.name ?? item.base} />
      {base && implicit.length > 0 && (
        <ul className="implicit tt-sec">
          {implicit.map((k) => (
            <li key={k}>{STAT_LABELS[k](base.implicit[k] ?? 0)}</li>
          ))}
        </ul>
      )}
      <Affixes item={item} />
      <Requirements item={item} classes={base?.classes} />
      <p className="tt-foot">Item level {item.ilvl}</p>
    </div>
  );
}

export function ItemDetails({ item, classId }: { item: Item; classId: ClassId }) {
  if (item.kind === 'gear') return <GearDetails item={item} />;
  if (item.kind === 'vessel') return <VesselDetails item={item} />;
  return <SigilDetails item={item} classId={classId} />;
}

function VesselDetails({ item }: { item: Extract<Item, { kind: 'vessel' }> }) {
  const def = MINION_DEFS[item.minion];
  return (
    <div className="item-details">
      <Head item={item} sub="Soul Vessel" />
      <p className="tt-sec tt-lore">
        Binds a {def.name}: {def.ranged ? 'ranged' : 'melee'}, level {item.level}, defaults to {def.defaultBehaviour}.
      </p>
      <Affixes item={item} />
      <section className="tt-sec">
        <p className="requirement">Reserves {vesselSpirit(item)} spirit when bound</p>
      </section>
      <Requirements item={item} classes={['binder']} />
      <p className="tt-foot">Item level {item.ilvl}</p>
    </div>
  );
}

/** Separate components per kind so each one's hooks run unconditionally. */
function SigilDetails({ item, classId }: { item: Extract<Item, { kind: 'sigil' }>; classId: ClassId }) {
  const debug = useUi((s) => s.debugVisible);
  const editorAllowed = useUi((s) => s.editorAllowed);
  const result = compileFor(item, classId);
  const skill = skillById(item.skill);
  return (
    <div className="item-details">
      <Head item={item} sub={item.corrupted ? 'Corrupted Sigil' : 'Sigil'} />
      {skill && (
        <p className="skill-line tt-sec">
          <strong>{skill.name}</strong>: {skill.description}
        </p>
      )}
      {!skill && <p className="tt-sec muted">{sigilCapacity(item)} rune slots</p>}
      {item.corrupted && <p className="tt-sec corrupted">Corrupted: misfires more often</p>}
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
      <Requirements item={item} />
      <p className="tt-foot">Item level {item.ilvl}</p>
    </div>
  );
}
