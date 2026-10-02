import {
  affixTierLabel,
  formatDamageRange,
  formatImplicit,
  isShapeId,
  programDamage,
  runeImplicit,
  runeName,
  shapeBaseRange,
  type AffixRoll,
  type RuneItem,
  type DamagePart,
  type DamageType,
  type RuneId,
  type ShapeDamage,
  type SpellProgram,
} from '@rune/shared';

/** The CSS class that colours a damage type (one muted colour per type, `--dmg-*` in styles.css). */
export function damageClass(type: DamageType): string {
  return `dmg dmg-${type}`;
}

function Part({ part }: { part: DamagePart }) {
  return (
    <span className={damageClass(part.type)}>
      {formatDamageRange(part.min, part.max)} {part.type}
    </span>
  );
}

function cadence(d: ShapeDamage): string {
  if (d.cadence.per === 'tick') return ` every ${Number(d.cadence.seconds.toFixed(2))} s`;
  if (d.cadence.per === 'second') return ' a second';
  return ' a hit';
}

/** One line per damaging shape: "Orb: 12 to 20 fire a hit", each type in its colour. */
export function DamageLines({ program, className }: { program: SpellProgram; className?: string }) {
  const shapes = programDamage(program);
  if (shapes.length === 0) return null;
  return (
    <ul className={`dmg-lines ${className ?? ''}`}>
      {shapes.map((d, i) => (
        <li key={i}>
          <span className="dmg-shape">
            {d.depth > 0 ? '└ ' : ''}
            {runeName(d.form)}
            {d.copiesMax > d.copies ? ` x${d.copies} to ${d.copiesMax}` : d.copies > 1 ? ` x${d.copies}` : ''}
          </span>{' '}
          {d.parts.map((p, k) => (
            <span key={p.type}>
              {k > 0 && ' + '}
              <Part part={p} />
            </span>
          ))}
          <span className="muted">{cadence(d)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A shape's base hit: the physical range it rolls on every hit, read live, times the rune's
 * implicit (`scale`). Null for runes that deal no base damage.
 */
export function ShapeImplicit({ rune, scale = 1 }: { rune: RuneId; scale?: number }) {
  if (!isShapeId(rune)) return null;
  const form = rune === 'orb' || rune === 'bolt' || rune === 'nova' || rune === 'zone' || rune === 'dash' ? rune : null;
  const base = form ? shapeBaseRange(form) : null;
  if (!base) return null;
  return (
    <ul className="implicit tt-sec">
      <li>
        Deals <Part part={{ type: 'physical', min: base.min * scale, max: base.max * scale }} /> damage
      </li>
    </ul>
  );
}

/**
 * A rune's implicit, above its affixes: its line and tier ("104% base damage T3") and, on a shape
 * that deals damage, the base hit it gives at the live numbers.
 */
export function RuneImplicit({ item }: { item: RuneItem }) {
  const implicit = runeImplicit(item);
  const line = formatImplicit(item);
  if (!implicit || line === null) return null;
  const scale = implicit.id === 'implicit_base' ? implicit.value / 100 : 1;
  return (
    <>
      <ShapeImplicit rune={item.rune} scale={scale} />
      <ul className="implicit tt-sec">
        <li>
          {line} <span className={`tier ${affixTierLabel(implicit.id, implicit.tier).toLowerCase()}`}>{affixTierLabel(implicit.id, implicit.tier)}</span>
        </li>
      </ul>
    </>
  );
}

/** The damage type an "Adds X to Y" roll deals, so its line can carry the type's colour. */
export function addedType(roll: AffixRoll): DamageType | null {
  if (roll.id === 'rune_added_fire') return 'fire';
  if (roll.id === 'rune_added_cold') return 'cold';
  if (roll.id === 'rune_added_lightning') return 'lightning';
  return null;
}
