import { useMemo, useState } from 'react';
import { activeTownEditor, useTownEditor, type EditorTool } from '../game/townEditor.js';
import { filterRows, groupRows, type LayerRow } from '../game/townEditorPick.js';
import { useMovablePanel } from './GamePanel.js';
import { useSettings } from './settings.js';
import { tip } from './Tip.js';
import { TownPalette } from './TownPalette.js';
import './townEditor.css';

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
    <>
      {/* Outside the panel, which may be moved with a transform that would shift fixed children. */}
      <CycleHint />
      <PickMenu />
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
        {(s.tool === 'place' || s.tool === 'select') && <TownPalette />}
        {s.tool === 'path' && (
          <label className="brush">
            Path width {s.brushWidth}
            <input type="range" min={30} max={300} step={10} value={s.brushWidth} onChange={(e) => useTownEditor.setState({ brushWidth: Number(e.target.value) })} />
          </label>
        )}
        <p className="selection-line">
          {s.selection ?? 'Nothing selected'}
          {s.cycle && (
            <span className="muted">
              {' '}
              ({s.cycle.index + 1} of {s.cycle.total} here)
            </span>
          )}
        </p>
        {s.selectionSolid !== null && (
          <label className="snap solid-toggle">
            <input type="checkbox" checked={s.selectionSolid} onChange={() => ed?.toggleSolid()} /> Blocks walking <kbd>B</kbd>
          </label>
        )}
        <LayerList />
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
          WASD pan, wheel zoom, drag to move, <kbd>Q</kbd>/<kbd>E</kbd> rotate, <kbd>[</kbd>/<kbd>]</kbd> scale or length, <kbd>B</kbd> blocks walking, <kbd>Del</kbd> delete, <kbd>Ctrl Z</kbd> undo, <kbd>F2</kbd> exit. Click
          again to pick the next object underneath, <kbd>Alt</kbd>+click to list them. Double click a layer to centre on it. Paths make walking 10% faster.
        </p>
      </section>
    </>
  );
}

/** Client pixels to CSS pixels inside the zoomed UI layer. */
function useUnzoom(): (px: number) => number {
  const scale = useSettings((s) => s.options.uiScale);
  return (px) => px / (scale > 0 ? scale : 1);
}

function CycleHint() {
  const cycle = useTownEditor((s) => s.cycle);
  const unzoom = useUnzoom();
  if (!cycle) return null;
  return (
    <div className="town-cycle-hint" style={{ left: unzoom(cycle.x + 14), top: unzoom(cycle.y + 12) }} aria-live="polite">
      {cycle.index + 1} of {cycle.total}
    </div>
  );
}

function PickMenu() {
  const menu = useTownEditor((s) => s.pickMenu);
  const selectedKey = useTownEditor((s) => s.selectedKey);
  const unzoom = useUnzoom();
  if (!menu) return null;
  const ed = activeTownEditor();
  return (
    <div className="panel town-pick-menu" role="menu" aria-label="Objects under the cursor" style={{ left: unzoom(menu.x + 8), top: unzoom(menu.y + 8) }}>
      {menu.items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={item.key === selectedKey ? 'bare on' : 'bare'}
          onMouseEnter={() => ed?.setHighlight(item.key)}
          onMouseLeave={() => ed?.setHighlight(null)}
          onClick={() => {
            ed?.setHighlight(null);
            ed?.selectKey(item.key);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1 8c2-3.5 4.5-5 7-5s5 1.5 7 5c-2 3.5-4.5 5-7 5S3 11.5 1 8z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" />
      {off && <path d="M2 14L14 2" stroke="currentColor" strokeWidth="1.6" />}
    </svg>
  );
}

function LockIcon({ on }: { on: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" />
      <path d={on ? 'M5 7V5a3 3 0 0 1 6 0v2' : 'M5 7V5a3 3 0 0 1 5.6-1.5'} fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * Every town object, grouped with the stations first. Hover shows it in the world, click selects,
 * double click centres the camera. Hide and lock are editor-only and never saved.
 */
function LayerList() {
  const version = useTownEditor((s) => s.layerVersion);
  const hidden = useTownEditor((s) => s.hidden);
  const locked = useTownEditor((s) => s.locked);
  const selectedKey = useTownEditor((s) => s.selectedKey);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');
  const ed = activeTownEditor();
  // The editor mutates its layout in place, so the version bump is what says the rows changed.
  const rows = useMemo<LayerRow[]>(() => ed?.layers() ?? [], [ed, version]);
  const groups = useMemo(() => groupRows(filterRows(rows, query)), [rows, query]);
  return (
    <div className="town-layers">
      <h3>
        <button type="button" className="bare town-layers-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Layers <span className="muted">({rows.length})</span>
        </button>
      </h3>
      {open && (
        <>
          <input className="town-layers-search" type="search" placeholder="Search objects" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search town objects" />
          <div className="town-layers-list" onMouseLeave={() => ed?.setHighlight(null)}>
            {groups.length === 0 && <p className="muted town-layers-empty">No objects match</p>}
            {groups.map((g) => (
              <div key={g.group} className="town-layers-group">
                <h4>{g.group}</h4>
                {g.rows.map((r) => {
                  const isHidden = hidden.has(r.key);
                  const isLocked = locked.has(r.key);
                  return (
                    <div key={r.key} className={`town-layer${r.key === selectedKey ? ' on' : ''}${isHidden ? ' is-hidden' : ''}`} onMouseEnter={() => ed?.setHighlight(r.key)}>
                      <button type="button" className="bare town-layer-name" onClick={() => ed?.selectKey(r.key)} onDoubleClick={() => ed?.focusKey(r.key)}>
                        {r.label}
                        <span className="muted">{r.detail}</span>
                      </button>
                      <button
                        type="button"
                        className={`bare town-layer-flag${isHidden ? ' set' : ''}`}
                        aria-pressed={isHidden}
                        aria-label={isHidden ? `Show ${r.label}` : `Hide ${r.label}`}
                        onClick={() => ed?.toggleHidden(r.key)}
                        {...tip(isHidden ? 'Show (editor only)' : 'Hide in the editor')}
                      >
                        <EyeIcon off={isHidden} />
                      </button>
                      <button
                        type="button"
                        className={`bare town-layer-flag${isLocked ? ' set' : ''}`}
                        aria-pressed={isLocked}
                        aria-label={isLocked ? `Unlock ${r.label}` : `Lock ${r.label}`}
                        onClick={() => ed?.toggleLocked(r.key)}
                        {...tip(isLocked ? 'Unlock' : 'Lock: clicks in the world pass through')}
                      >
                        <LockIcon on={isLocked} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
