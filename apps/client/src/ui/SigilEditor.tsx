import { COMBOS, describeSpell, RUNE_IDS, RUNES, sigilCapacity, isRuneId, type RuneCategory, type RuneId, type SigilItem } from '@rune/shared';
import { useEffect, useState, type DragEvent } from 'react';
import { CostLine, RuneChip, tierColor } from './parts.js';
import { compileFor, itemByUid, sendCommand, useUi } from './store.js';

const CATEGORIES: RuneCategory[] = ['form', 'element', 'effect', 'modifier', 'trigger', 'action'];

/** The compiler fixtures from the spec, loadable from the debug view to try each one in play. */
const FIXTURES: string[] = [
  'bolt fire',
  'bolt fire timer split',
  'bolt fire split',
  'bolt fire split timer',
  'dash impact onland nova',
  'bolt pierce swift',
  'zone restore linger',
  'nova restore',
  'aura restore',
  'link ward',
  'aura fire onhit nova',
  'split bolt',
  'bolt timer split timer split timer split',
];

function parseFixture(s: string): RuneId[] {
  return s.split(' ').filter(isRuneId);
}

const DRAG_RUNE = 'application/x-rune';
const DRAG_SLOT = 'application/x-rune-slot';

export function SigilEditor() {
  const open = useUi((s) => s.editorOpen);
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const uid = useUi((s) => s.editorUid);
  const debug = useUi((s) => s.debugVisible);
  const item = itemByUid(inv, uid);
  const sigil: SigilItem | null = item?.kind === 'sigil' ? item : null;
  const [draft, setDraftState] = useState<RuneId[]>([]);
  const [original, setOriginal] = useState<RuneId[]>([]);

  useEffect(() => {
    setDraftState(sigil ? [...sigil.runes] : []);
    // Reset the draft when switching sigils or when the server confirms or rejects a change.
  }, [sigil?.uid, sigil?.runes.join(',')]);
  useEffect(() => {
    setOriginal(sigil ? [...sigil.runes] : []);
  }, [sigil?.uid]);

  /** Edits apply immediately, so a change can be tried in play right away; the server still validates. */
  const setDraft = (next: RuneId[]) => {
    setDraftState(next);
    if (sigil) sendCommand({ t: 'inscribe', uid: sigil.uid, runes: next });
  };

  if (!open || !inv || !classId) return null;
  const sigils = inv.items.filter((i): i is SigilItem => i.kind === 'sigil');
  const capacity = sigil ? sigilCapacity(sigil) : 0;
  const result = sigil ? compileFor(sigil, classId, draft) : null;
  const changed = draft.join(',') !== original.join(',');
  const equippedSlot = (u: number) => inv.sigils.indexOf(u);

  const insert = (rune: RuneId, at: number) => {
    const next = [...draft];
    if (draft.length >= capacity) {
      // Full: dropping onto a slot replaces what is there instead of silently doing nothing.
      if (at >= capacity) {
        useUi.getState().notify(`This sigil holds ${capacity} runes. Drop onto a slot to replace it.`);
        return;
      }
      next[at] = rune;
    } else {
      next.splice(Math.min(at, next.length), 0, rune);
    }
    setDraft(next);
  };
  const removeAt = (i: number) => setDraft(draft.filter((_, k) => k !== i));
  const move = (from: number, to: number) => {
    const next = [...draft];
    const [r] = next.splice(from, 1);
    if (r === undefined) return;
    next.splice(Math.min(to, next.length), 0, r);
    setDraft(next);
  };

  const onDropSlot = (e: DragEvent, index: number) => {
    e.preventDefault();
    const rune = e.dataTransfer.getData(DRAG_RUNE);
    const from = e.dataTransfer.getData(DRAG_SLOT);
    if (from !== '') move(Number(from), index);
    else if (isRuneId(rune)) insert(rune, index);
  };
  const onDropPalette = (e: DragEvent) => {
    e.preventDefault();
    const from = e.dataTransfer.getData(DRAG_SLOT);
    if (from !== '') removeAt(Number(from));
  };

  return (
    <section className="panel editor" aria-label="Sigil editor">
      <header>
        <h2>Sigil editor</h2>
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
            <div className="slots" onDragOver={(e) => e.preventDefault()}>
              {Array.from({ length: capacity }, (_, i) => {
                const rune = draft[i];
                return (
                  <div
                    key={i}
                    className={`slot${rune ? ' filled' : ''}`}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onDropSlot(e, i)}
                  >
                    {rune && (
                      <div draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_SLOT, String(i))}>
                        <RuneChip id={rune} onClick={() => removeAt(i)} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="verdict">
              {draft.length === 0 ? <span className="muted">Drag runes into the slots. The first rune must be a Form.</span> : <CostLine result={result} />}
              {result.ok &&
                result.combos.map((c) => (
                  <span key={c} className="combo">
                    {COMBOS.find((x) => x.id === c)?.name}
                  </span>
                ))}
            </div>
            {debug && draft.length > 0 && (
              <p className="debug-line">
                {result.ok ? `${describeSpell(result.program)}, ${result.worstCaseEntities} entities` : `dud: ${result.dud}`}
              </p>
            )}

            <div className="editor-actions">
              <button type="button" disabled={!changed} onClick={() => setDraft([...original])}>
                Undo changes
              </button>
              <button type="button" disabled={draft.length === 0} onClick={() => setDraft([])}>
                Clear
              </button>
              {debug && (
                <select
                  aria-label="Load a compiler fixture"
                  value=""
                  onChange={(e) => setDraft(parseFixture(e.target.value).slice(0, capacity))}
                >
                  <option value="">Load fixture...</option>
                  {FIXTURES.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="palette" onDragOver={(e) => e.preventDefault()} onDrop={onDropPalette}>
              {CATEGORIES.map((cat) => (
                <div key={cat} className="palette-group">
                  <h4>{cat}</h4>
                  <div className="rune-row">
                    {RUNE_IDS.filter((r) => RUNES[r].category === cat).map((r) => (
                      <div key={r} draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_RUNE, r)}>
                        <RuneChip id={r} onClick={() => insert(r, draft.length)} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <p className="muted">Changes apply instantly. Click a rune to append it, click a slotted rune to remove it, or drag to place, replace and reorder.</p>
            </div>
          </div>
        ) : (
          <p className="muted">Pick a sigil on the left.</p>
        )}
      </div>
    </section>
  );
}
