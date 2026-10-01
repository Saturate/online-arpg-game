import { BENCH_LIMITS, checkBenchSpell, CLASS_IDS, CLASSES, isClassId, type BenchSpell, type ClassId } from '@rune/shared';
import { useState, type FormEvent } from 'react';

/**
 * Adds an admin pick. The same grammar and compile check the server runs shows its verdict while
 * typing, so a typo is caught before the request; the server checks again.
 */
export function PickForm({ busy, onAdd }: { busy: boolean; onAdd: (spell: BenchSpell) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [classId, setClassId] = useState<ClassId>('mage');
  const [multicast, setMulticast] = useState(1);
  const verdict = text.trim() === '' ? null : checkBenchSpell({ text, classId, multicast });
  const problem = typeof verdict === 'string' ? verdict : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (verdict === null || typeof verdict === 'string') return;
    if (await onAdd(verdict)) setText('');
  };

  return (
    <form className="bn-pick" onSubmit={(e) => void submit(e)}>
      <label className="bn-pick-text">
        <span>Add a pick</span>
        <input
          type="text"
          value={text}
          maxLength={BENCH_LIMITS.textMax}
          placeholder="bolt[onhit] nova[+55% damage] lightning"
          spellCheck={false}
          aria-invalid={problem !== null}
          aria-describedby="bn-pick-verdict"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label>
        <span>Class</span>
        <select value={classId} onChange={(e) => isClassId(e.target.value) && setClassId(e.target.value)}>
          {CLASS_IDS.map((c) => (
            <option key={c} value={c}>
              {CLASSES[c].name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Multicast</span>
        <input type="number" min={1} max={BENCH_LIMITS.multicastMax} step={1} value={multicast} onChange={(e) => setMulticast(Math.max(1, Math.min(BENCH_LIMITS.multicastMax, Math.round(Number(e.target.value) || 1))))} />
      </label>
      <button type="submit" className="primary" disabled={busy || verdict === null || problem !== null}>
        Add
      </button>
      <p id="bn-pick-verdict" className={`bn-verdict ${problem ? 'bad' : ''}`} aria-live="polite">
        {problem ?? (verdict && typeof verdict !== 'string' ? `Reads as ${verdict.text}` : 'Rune text as the forge writes it; shared with every admin.')}
      </p>
    </form>
  );
}
