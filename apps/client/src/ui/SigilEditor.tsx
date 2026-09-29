import { bracketTree, describeTree, sigilCapacity, type SigilItem } from '@rune/shared';
import { CostLine, RuneChip, tierColor } from './parts.js';
import { compileFor, itemByUid, useUi } from './store.js';

/**
 * A read-only view of a sigil's runes while the forge is rebuilt around rune items: the server
 * refuses every inscribe until then, so this panel sends nothing.
 */
export function SigilEditor() {
  const open = useUi((s) => s.editorOpen);
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const uid = useUi((s) => s.editorUid);
  const debug = useUi((s) => s.debugVisible);
  const item = itemByUid(inv, uid);
  const sigil: SigilItem | null = item?.kind === 'sigil' ? item : null;

  if (!open || !inv || !classId) return null;
  const sigils = inv.items.filter((i): i is SigilItem => i.kind === 'sigil');
  const capacity = sigil ? sigilCapacity(sigil) : 0;
  const result = sigil ? compileFor(sigil, classId) : null;
  const equippedSlot = (u: number) => inv.sigils.indexOf(u);

  return (
    <section className="panel editor" aria-label="Sigil editor">
      <header>
        <h2>Forge</h2>
        <button type="button" className="close" onClick={() => useUi.setState({ editorOpen: false })} aria-label="Close editor">
          x
        </button>
      </header>

      <div className="editor-body">
        <nav className="sigil-list" aria-label="Your sigils">
          {sigils.map((s) => {
            const slot = equippedSlot(s.uid);
            return (
              <button
                key={s.uid}
                type="button"
                className={s.uid === uid ? 'active' : ''}
                style={{ color: tierColor(s) }}
                onClick={() => useUi.setState({ editorUid: s.uid })}
              >
                {slot >= 0 && <kbd>{slot + 1}</kbd>} {s.name}
              </button>
            );
          })}
        </nav>

        {sigil && result ? (
          <div className="workbench">
            <h3 style={{ color: tierColor(sigil) }}>{sigil.name}</h3>
            <div className="slots">
              {Array.from({ length: capacity }, (_, i) => {
                const rune = sigil.slots[i];
                return (
                  <div key={i} className={`slot${rune ? ' filled' : ''}`}>
                    {rune && <RuneChip id={rune.rune} item={rune} />}
                  </div>
                );
              })}
            </div>

            <div className="verdict">{sigil.slots.length === 0 ? <span className="muted">No runes inscribed.</span> : <CostLine result={result} />}</div>
            {result.ok ? <p>{describeTree(result.tree)}</p> : result.errors.map((e, i) => <p key={i} className="muted">{e.message}</p>)}
            {debug && result.ok && <p className="debug-line">{bracketTree(result.tree)}</p>}
            <p className="muted">The forge is being rebuilt. Runes cannot be inscribed or taken out until it reopens.</p>
          </div>
        ) : (
          <p className="muted">Pick a sigil on the left.</p>
        )}
      </div>
    </section>
  );
}
