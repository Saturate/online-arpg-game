import { useEffect, useState } from 'react';
import { CLASSES, DAMAGE_PER_FORCE_BOUND, STARTER_DAMAGE_LIMITS, STARTER_SIGILS, starterDamageEstimate, starterDamageOf, type StarterDamage } from '@rune/shared';

/**
 * One row per starter skill: its live damage multiplier and what that does to its damage per Force
 * against the bound player-made spells are held to. Saved with the rest of the settings.
 */
export function StarterDamageTable({ value, onChange }: { value: StarterDamage; onChange: (next: StarterDamage) => void }) {
  const set = (id: string, m: number) => {
    const next: Record<string, number> = { ...value };
    if (m === 1) delete next[id];
    else next[id] = m;
    onChange(next);
  };
  return (
    <div className="adm-field wide">
      <span>Starter damage</span>
      <table className="adm-table adm-starters">
        <thead>
          <tr>
            <th>Starter</th>
            <th>Class</th>
            <th>Multiplier</th>
            <th title="Damage per Force to one target and to a pack of six, from the balance harness, scaled by the multiplier">Per Force (est.)</th>
            <th title={`As a share of the best starter's damage per Force at the defaults; player-made spells are held to ${DAMAGE_PER_FORCE_BOUND}x`}>x best</th>
          </tr>
        </thead>
        <tbody>
          {STARTER_SIGILS.map((def) => {
            const m = starterDamageOf(value, def.id);
            const est = starterDamageEstimate(def.id, m);
            const over = est !== null && est.ofBest > DAMAGE_PER_FORCE_BOUND;
            return (
              <tr key={def.id} className={m !== 1 ? 'open' : undefined}>
                <td>{def.name}</td>
                <td className="muted">{CLASSES[def.classId].name}</td>
                <td>
                  <MultiplierInput value={m} label={`${def.name} damage multiplier`} onChange={(v) => set(def.id, v)} />
                  {m !== 1 && (
                    <button type="button" className="small" onClick={() => set(def.id, 1)}>
                      Reset
                    </button>
                  )}
                </td>
                <td className="mono">{est ? `${est.single.toFixed(2)} / ${est.pack.toFixed(2)}` : <span className="muted">no damage</span>}</td>
                <td className="mono">{est ? <>{est.ofBest.toFixed(2)}x{over && <span className="badge red">over {DAMAGE_PER_FORCE_BOUND}x</span>}</> : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <small className="muted">
        {`Multiplies a starter's damage while a sigil holds its whole recipe; a changed rune or a player-made spell never gets it. Heals, shields and auras keep their strength. Applies on the next cast, without a restart. Per Force is an estimate: the harness numbers at 1x times the multiplier. Range ${STARTER_DAMAGE_LIMITS.min} to ${STARTER_DAMAGE_LIMITS.max}, default 1.`}
      </small>
    </div>
  );
}

/** Keeps its own text so half-typed values ("0.") stay in the box; only an in-range number reaches the draft. */
function MultiplierInput({ value, label, onChange }: { value: number; label: string; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((t) => (Number(t) === value ? t : String(value)));
  }, [value]);
  const v = Number(text);
  const valid = text !== '' && Number.isFinite(v) && v >= STARTER_DAMAGE_LIMITS.min && v <= STARTER_DAMAGE_LIMITS.max;
  return (
    <input
      type="number"
      min={STARTER_DAMAGE_LIMITS.min}
      max={STARTER_DAMAGE_LIMITS.max}
      step={0.05}
      value={text}
      aria-label={label}
      aria-invalid={!valid}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n) && n >= STARTER_DAMAGE_LIMITS.min && n <= STARTER_DAMAGE_LIMITS.max) onChange(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}
