import { useEffect, useState } from 'react';
import { CLASSES, DAMAGE_PER_FORCE_BOUND, STARTER_DAMAGE_LIMITS, STARTER_SIGILS, starterDamageEstimate, starterDamageOf, starterDealsDamage, type StarterDamage } from '@rune/shared';

function validMultiplier(text: string): boolean {
  const v = Number(text);
  return text.trim() !== '' && Number.isFinite(v) && v >= STARTER_DAMAGE_LIMITS.min && v <= STARTER_DAMAGE_LIMITS.max;
}

/**
 * One row per starter skill: its live damage multiplier and what that does to its damage per Force
 * against the bound player-made spells are held to. Saved with the rest of the settings. A box holding
 * something out of range is reported through `onInvalid` (starter names), so the form can hold Save
 * instead of quietly sending the last good value.
 */
export function StarterDamageTable({ value, onChange, onInvalid }: { value: StarterDamage; onChange: (next: StarterDamage) => void; onInvalid: (names: readonly string[]) => void }) {
  // Only boxes being typed in have an entry; the rest show the draft's value.
  const [texts, setTexts] = useState<Readonly<Record<string, string>>>({});
  const invalid = STARTER_SIGILS.filter((def) => {
    const t = texts[def.id];
    return t !== undefined && !validMultiplier(t);
  }).map((def) => def.name);
  const invalidKey = invalid.join('|');
  useEffect(() => {
    onInvalid(invalidKey === '' ? [] : invalidKey.split('|'));
  }, [invalidKey, onInvalid]);

  const set = (id: string, m: number) => {
    const next: Record<string, number> = { ...value };
    if (m === 1) delete next[id];
    else next[id] = m;
    onChange(next);
  };
  const type = (id: string, text: string) => {
    setTexts((t) => ({ ...t, [id]: text }));
    if (validMultiplier(text)) set(id, Number(text));
  };
  const settle = (id: string) => {
    // A valid box goes back to showing the draft; an invalid one stays so the admin sees what blocks Save.
    setTexts((t) => {
      const text = t[id];
      if (text === undefined || !validMultiplier(text)) return t;
      const { [id]: _done, ...rest } = t;
      return rest;
    });
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
            const damages = starterDealsDamage(def.id);
            const est = starterDamageEstimate(def.id, m);
            const over = est !== null && est.ofBest > DAMAGE_PER_FORCE_BOUND;
            const text = texts[def.id];
            return (
              <tr key={def.id} className={m !== 1 ? 'open' : undefined}>
                <td>{def.name}</td>
                <td className="muted">{CLASSES[def.classId].name}</td>
                <td>
                  <input
                    type="number"
                    min={STARTER_DAMAGE_LIMITS.min}
                    max={STARTER_DAMAGE_LIMITS.max}
                    step={0.05}
                    value={damages ? (text ?? String(m)) : '1'}
                    disabled={!damages}
                    title={damages ? undefined : 'Deals no damage, so it takes no multiplier'}
                    aria-label={`${def.name} damage multiplier`}
                    aria-invalid={text !== undefined && !validMultiplier(text)}
                    onChange={(e) => type(def.id, e.target.value)}
                    onBlur={() => settle(def.id)}
                  />
                  {damages && (m !== 1 || text !== undefined) && (
                    <button
                      type="button"
                      className="small"
                      onClick={() => {
                        setTexts(({ [def.id]: _reset, ...rest }) => rest);
                        set(def.id, 1);
                      }}
                    >
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
        {`Multiplies a starter's damage while a sigil holds its whole recipe; a changed rune or a player-made spell never gets it. Starters that deal no damage (heals, wards, auras, plain dashes) take none. Applies on the next cast, without a restart, the Arena included. Per Force is an estimate: the harness numbers at 1x times the multiplier. Range ${STARTER_DAMAGE_LIMITS.min} to ${STARTER_DAMAGE_LIMITS.max}, default 1.`}
      </small>
    </div>
  );
}
