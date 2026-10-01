import type { CSSProperties } from 'react';
import {
  HEAT,
  bracketTree,
  describeTree,
  formatAffix,
  isCastableRune,
  MINION_DEFS,
  gearBase,
  levelRequirement,
  runeAffixDescription,
  runeColor,
  runeDescription,
  runeKind,
  runeGlyph,
  runeName,
  RUNE_STACK,
  sigilCapacity,
  matchingStarter,
  starterDamageFor,
  STAT_IDS,
  STAT_LABELS,
  vesselPackmates,
  vesselSpirit,
  type ClassId,
  type Item,
  type RuneId,
  type RuneItem,
  type SigilCompile,
} from '@rune/shared';
import { cssColor, TIER_COLORS, UNIQUE_COLOR } from '../render/config.js';
import { compileFor, useUi } from './store.js';
import { tip } from './Tip.js';
import { formatCooldown } from '../game/castTiming.js';
import { useStarterTuning } from '../game/starterTuning.js';
import { useSigilCooldown } from './useSigilCooldown.js';

/** A rune in a row. Pass `item` for a rune in a sigil slot, so its rolls show on hover. */
export function RuneChip({ id, item, small = false, onClick }: { id: RuneId; item?: RuneItem; small?: boolean; onClick?: () => void }) {
  const kind = runeKind(id);
  const style: CSSProperties & Record<'--rune', string> = { '--rune': cssColor(runeColor(id)) };
  const rolls = item?.affixes.map(formatAffix) ?? [];
  return (
    <span
      className={`rune-chip cat-${kind === 'shape' ? 'form' : kind}${small ? ' small' : ''}`}
      style={style}
      {...tip(
        <div className="tip-lines">
          <strong style={{ color: 'var(--rune)' }}>{runeName(id)}</strong> <span className="muted">({kind})</span>
          {rolls.map((r, i) => (
            <p key={i} className="tip-roll">
              {r}
            </p>
          ))}
        </div>,
      )}
      onClick={onClick}
    >
      <b>{runeGlyph(id)}</b>
      {!small && <i>{runeName(id)}</i>}
      {rolls.length > 0 && <sup>*</sup>}
    </span>
  );
}

export function tierColor(item: Item): string {
  // Hand-named items carry their own colour whatever their tier, as D2's uniques do.
  if (item.kind === 'vessel' && item.fixedName) return cssColor(UNIQUE_COLOR);
  return cssColor(TIER_COLORS[item.tier]);
}

/** Force per cast or spirit held; a spell that breaks a rule says which one. */
export function CostLine({ result }: { result: SigilCompile }) {
  if (!result.ok) {
    return (
      <span className="cost unstable">
        Fizzles: {result.errors[0]?.message ?? 'the runes do not make a spell'}{' '}
        <em>
          ({Math.round(result.force * HEAT.dudHeatFraction)} {HEAT.displayName} lost per try)
        </em>
      </span>
    );
  }
  if (result.persistent) return <span className="cost stable">Held while equipped, reserves {result.spirit} spirit</span>;
  return (
    <span className="cost stable">
      {Math.round(result.force)} {HEAT.displayName} per cast
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
  if (item.kind === 'rune') return <RuneDetails item={item} />;
  return <SigilDetails item={item} classId={classId} />;
}

/** Rolled lines with what each one means, since rune affixes are new to most players. */
function RuneAffixLines({ item }: { item: RuneItem }) {
  return (
    <ul className="affixes tt-sec">
      {item.affixes.map((a, i) => {
        const why = runeAffixDescription(a.id);
        return (
          <li key={i}>
            {formatAffix(a)} <span className={`tier t${a.tier + 1}`}>T{a.tier + 1}</span>
            {why && <small className="affix-why">{why}</small>}
          </li>
        );
      })}
    </ul>
  );
}

const KIND_NAMES = { shape: 'Shape', infusion: 'Infusion', shaper: 'Shaper', effect: 'Effect', trigger: 'Trigger', modifier: 'Modifier' } as const;

function RuneDetails({ item }: { item: RuneItem }) {
  const rolled = item.affixes.length > 0;
  return (
    <div className="item-details">
      <Head item={item} sub={`${KIND_NAMES[runeKind(item.rune)]} rune${rolled ? ', rolled' : ''}`} />
      <p className="tt-sec tt-lore">{runeDescription(item.rune)}</p>
      {rolled && <RuneAffixLines item={item} />}
      <section className="tt-sec">
        <p className="muted">
          {rolled ? 'Rolled runes are single and never stack.' : item.count > 1 ? `${item.count} in this stack, up to ${RUNE_STACK}.` : `Plain runes stack up to ${RUNE_STACK}.`}
        </p>
        {item.bound && <p className="requirement">Bound: cannot be sold, dropped or stashed</p>}
        {!isCastableRune(item.rune) && <p className="requirement unmet">Not in the game yet: no sigil can cast it</p>}
      </section>
      <p className="tt-foot">Inscribed at the forge in town · Item level {item.ilvl}</p>
    </div>
  );
}

function VesselDetails({ item }: { item: Extract<Item, { kind: 'vessel' }> }) {
  const def = MINION_DEFS[item.minion];
  const mates = vesselPackmates(item);
  return (
    <div className="item-details">
      <Head item={item} sub={item.fixedName ? 'Unique Soul Vessel' : 'Soul Vessel'} />
      {item.lore && <p className="tt-sec tt-unique-lore">{item.lore}</p>}
      <p className="tt-sec tt-lore">
        {mates > 0
          ? `Binds a ${def.name} pack: a Leader and ${mates} packmate${mates === 1 ? '' : 's'}, melee, level ${item.level}. The Leader pounces and howls; packmates flank and their bites poison.`
          : `Binds a ${def.name}: ${def.ranged ? 'ranged' : 'melee'}, level ${item.level}, defaults to ${def.defaultBehaviour}.`}
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
  const editorAllowed = useUi((s) => s.station === 'forge' || (s.editorAllowed && s.devTools));
  const starterDamage = useStarterTuning((s) => s.damage);
  const result = compileFor(item, classId, starterDamage);
  const cooldown = useSigilCooldown(item);
  // Still the starter it came from only while it holds the starter's runes.
  const skill = matchingStarter(item);
  const tuned = starterDamageFor(item, starterDamage);
  const sub = item.corrupted ? 'Corrupted Sigil' : skill ? 'Starter Sigil' : 'Sigil';
  return (
    <div className="item-details">
      <Head item={item} sub={sub} />
      {skill && (
        <p className="skill-line tt-sec">
          <strong>{skill.name}</strong>: {skill.description}
        </p>
      )}
      {tuned !== 1 && <p className="tt-sec tt-tuned">Tuned to deal {Math.round(tuned * 100)}% damage while it holds the whole starter</p>}
      <p className="tt-sec tt-wand">
        {sigilCapacity(item)} rune slots
        {!(result.ok && result.persistent) && <> · Cooldown {formatCooldown(cooldown)}</>}
      </p>
      {item.corrupted && <p className="tt-sec corrupted">Corrupted: misfires more often</p>}
      <Affixes item={item} />
      <div className="rune-row">
        {item.slots.length === 0 ? (
          <span className="muted">{editorAllowed ? 'Blank. Inscribe it with K.' : 'Blank. Inscribe runes into it at the forge in town.'}</span>
        ) : (
          item.slots.map((r) => <RuneChip key={r.uid} id={r.rune} item={r} small />)
        )}
      </div>
      {item.slots.length > 0 && result.ok && <p className="tt-sec tt-sentence">{describeTree(result.tree)}</p>}
      {item.slots.length > 0 && <CostLine result={result} />}
      {debug && item.slots.length > 0 && result.ok && <p className="debug-line">{bracketTree(result.tree)}</p>}
      <Requirements item={item} />
      <p className="tt-foot">Item level {item.ilvl}</p>
    </div>
  );
}
