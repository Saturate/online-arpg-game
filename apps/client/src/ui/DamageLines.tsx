import {
  formatDamageRange,
  isShapeId,
  programDamage,
  runeName,
  shapeBaseRange,
  type AffixRoll,
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
            {d.copies > 1 ? ` x${d.copies}` : ''}
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

/** A shape rune's implicit: the physical range it rolls on every hit, read live. Null for other runes. */
export function ShapeImplicit({ rune }: { rune: RuneId }) {
  if (!isShapeId(rune)) return null;
  const form = rune === 'orb' || rune === 'bolt' || rune === 'nova' || rune === 'zone' || rune === 'dash' ? rune : null;
  const base = form ? shapeBaseRange(form) : null;
  if (!base) return null;
  return (
    <ul className="implicit tt-sec">
      <li>
        Deals <Part part={{ type: 'physical', min: base.min, max: base.max }} /> damage
      </li>
    </ul>
  );
}

/** The damage type an "Adds X to Y" roll deals, so its line can carry the type's colour. */
export function addedType(roll: AffixRoll): DamageType | null {
  if (roll.id === 'rune_added_fire') return 'fire';
  if (roll.id === 'rune_added_cold') return 'cold';
  if (roll.id === 'rune_added_lightning') return 'lightning';
  return null;
}
