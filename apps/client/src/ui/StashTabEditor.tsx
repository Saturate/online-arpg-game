import { isStashTabName, STASH_COLORS, STASH_TABS, type StashColorId } from '@rune/shared';
import { useState, type KeyboardEvent } from 'react';
import { tip } from './Tip.js';

/** The swatch colour of a stash tab, personal or guild. */
export function colorHex(id: StashColorId): string {
  return STASH_COLORS.find((c) => c.id === id)?.hex ?? '#6e6a62';
}

/** Trims and collapses spaces, the way the server wants a name. */
function cleanName(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

/** Rename and recolour a stash tab; personal and guild tabs follow the same naming rules. */
export function TabEditor({ name, color, onSave, onClose }: { name: string; color: StashColorId; onSave: (name: string, color: StashColorId) => void; onClose: () => void }) {
  const [text, setText] = useState(name);
  const [pick, setPick] = useState<StashColorId>(color);
  const clean = cleanName(text);
  const ok = isStashTabName(clean);
  const save = () => {
    if (!ok) return;
    onSave(clean, pick);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="stash-editor" role="dialog" aria-label="Edit stash tab">
      <label>
        <span>Name</span>
        <input autoFocus value={text} maxLength={STASH_TABS.nameMax} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} spellCheck={false} />
      </label>
      <div className="stash-swatches" role="radiogroup" aria-label="Tab colour">
        {STASH_COLORS.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={pick === c.id} className={`bare stash-swatch${pick === c.id ? ' on' : ''}`} style={{ background: c.hex }} aria-label={c.label} {...tip(c.label)} onClick={() => setPick(c.id)} />
        ))}
      </div>
      {!ok && <p className="stash-editor-why">1 to {STASH_TABS.nameMax} letters, digits, spaces or . , ' ! ? &amp; ( ) + # : -</p>}
      <div className="stash-editor-actions">
        <button type="button" onClick={save} disabled={!ok}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
