import { PROP_DEFS, TOWN_PROP_KINDS } from '@rune/shared';
import { activeTownEditor, useTownEditor, type EditorTool } from '../game/townEditor.js';
import { useMovablePanel } from './GamePanel.js';
import { tip } from './Tip.js';

const TOOLS: { id: EditorTool; label: string; key: string }[] = [
  { id: 'select', label: 'Select / move', key: '1' },
  { id: 'place', label: 'Place prop', key: '2' },
  { id: 'path', label: 'Path brush', key: '3' },
  { id: 'plaza', label: 'Plaza brush', key: '4' },
  { id: 'erase', label: 'Erase', key: '5' },
];

/** Controls for the town editor. All editing happens in the scene; this is only the toolbox. */
export function TownEditorPanel() {
  const s = useTownEditor();
  const { ref: panelRef, handleProps } = useMovablePanel('town-editor');
  if (!s.active) return null;
  const ed = activeTownEditor();
  return (
    <section ref={panelRef} className="panel town-editor" aria-label="Town editor">
      <header {...handleProps}>
        <h2>Town editor</h2>
        {s.dirty && <span className="unsaved">unsaved</span>}
      </header>
      <div className="tool-row">
        {TOOLS.map((t) => (
          <button key={t.id} type="button" className={s.tool === t.id ? 'on' : ''} onClick={() => ed?.setTool(t.id)} {...tip(`Key ${t.key}`)}>
            <kbd>{t.key}</kbd> {t.label}
          </button>
        ))}
      </div>
      {(s.tool === 'place' || s.tool === 'select') && (
        <>
          <h3>Props</h3>
          <div className="palette-grid">
            {TOWN_PROP_KINDS.map((k) => (
              <button key={k} type="button" className={s.tool === 'place' && s.placeKind === k ? 'on' : ''} onClick={() => ed?.setPlaceKind(k)}>
                {PROP_DEFS[k].label}
              </button>
            ))}
          </div>
        </>
      )}
      {s.tool === 'path' && (
        <label className="brush">
          Path width {s.brushWidth}
          <input
            type="range"
            min={30}
            max={300}
            step={10}
            value={s.brushWidth}
            onChange={(e) => useTownEditor.setState({ brushWidth: Number(e.target.value) })}
          />
        </label>
      )}
      <p className="selection-line">{s.selection ?? 'Nothing selected'}</p>
      <label className="snap">
        <input type="checkbox" checked={s.snap} onChange={(e) => useTownEditor.setState({ snap: e.target.checked })} /> Snap to grid <kbd>G</kbd>
      </label>
      <div className="editor-actions">
        <button type="button" onClick={() => ed?.saveLayout()} disabled={!s.dirty}>
          Save town
        </button>
        <button type="button" onClick={() => ed?.undoLast()} disabled={!s.canUndo}>
          Undo
        </button>
        <button type="button" onClick={() => ed?.revert()}>
          Revert
        </button>
        <button type="button" className="danger" onClick={() => ed?.deleteSelected()} disabled={s.selection === null}>
          Delete
        </button>
      </div>
      <p className="muted small">
        WASD pan, wheel zoom, drag to move, <kbd>Q</kbd>/<kbd>E</kbd> rotate, <kbd>[</kbd>/<kbd>]</kbd> scale or length, <kbd>Del</kbd> delete, <kbd>Ctrl Z</kbd>{' '}
        undo, <kbd>F2</kbd> exit. Paths make walking 10% faster.
      </p>
    </section>
  );
}
