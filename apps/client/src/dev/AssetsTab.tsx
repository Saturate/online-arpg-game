import { useEffect, useRef, useState } from 'react';
import { ASSETS, type AssetCategory } from '../render/assets.js';
import { AssetViewer } from './assetViewer.js';
import { BUILTIN_MODELS, bakeClips, buildBuiltin, exportBuiltin } from './builtinModels.js';

/** `built-in` is the monsters models.ts builds in code; the rest are model files in the registry. */
type Category = AssetCategory | 'built-in';
const CATEGORIES: Category[] = ['hero', 'monster', 'built-in', 'building', 'nature', 'prop', 'dungeon', 'graveyard'];

export function AssetsTab() {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<AssetViewer | null>(null);
  const [category, setCategory] = useState<Category>('hero');
  const [selected, setSelected] = useState<string | null>(null);
  const [clips, setClips] = useState<string[]>([]);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!host.current) return;
    viewer.current = new AssetViewer(host.current);
    return () => viewer.current?.dispose();
  }, []);

  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    if (category === 'built-in') {
      const m = BUILTIN_MODELS.find((b) => b.id === selected) ?? BUILTIN_MODELS[0];
      if (!m) return;
      const rig = buildBuiltin(m);
      const baked = bakeClips(rig, m);
      v.showObject(rig.root, baked);
      setClips(baked.map((c) => c.name));
      setStatus('');
      return;
    }
    setStatus('Loading...');
    const def = selected ? ASSETS.find((a) => a.id === selected) : undefined;
    const job = def ? v.showSingle(def).then(setClips) : v.showGallery(ASSETS.filter((a) => a.category === category)).then(() => setClips([]));
    job.then(() => setStatus('')).catch((e: unknown) => setStatus(e instanceof Error ? e.message : 'Failed to load'));
  }, [category, selected]);

  const builtin = category === 'built-in';
  const list = builtin ? [] : ASSETS.filter((a) => a.category === category);
  const shownBuiltin = builtin ? (BUILTIN_MODELS.find((b) => b.id === selected) ?? BUILTIN_MODELS[0]) : undefined;
  return (
    <div className="dev-split">
      <aside className="dev-side">
        <div className="chip-row">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={c === category ? 'on' : ''}
              onClick={() => {
                setCategory(c);
                setSelected(null);
              }}
            >
              {c}
            </button>
          ))}
        </div>
        {builtin ? (
          <>
            <p className="muted small">Built in code (models.ts), not from a file. Export saves a .glb in metres for Blender, with Idle, Walk and Attack baked from the game's code.</p>
            {shownBuiltin && (
              <button
                type="button"
                className="wide"
                onClick={() => exportBuiltin(shownBuiltin).catch((e: unknown) => setStatus(e instanceof Error ? e.message : 'Export failed'))}
              >
                Export {shownBuiltin.label} as .glb
              </button>
            )}
            <ul className="dev-list">
              {BUILTIN_MODELS.map((m) => (
                <li key={m.id}>
                  <button type="button" className={m.id === shownBuiltin?.id ? 'on' : ''} onClick={() => setSelected(m.id)}>
                    {m.label} <span className="muted">r {m.radius}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <button type="button" className={selected === null ? 'on wide' : 'wide'} onClick={() => setSelected(null)}>
            Gallery: all {list.length}
          </button>
        )}
        <ul className="dev-list">
          {list.map((a) => (
            <li key={a.id}>
              <button type="button" className={a.id === selected ? 'on' : ''} onClick={() => setSelected(a.id)}>
                {a.label} <span className="muted">h {a.height}</span>
              </button>
            </li>
          ))}
        </ul>
        {clips.length > 0 && (
          <>
            <h3>Animations</h3>
            <div className="chip-row">
              {clips.map((c) => (
                <button key={c} type="button" onClick={() => viewer.current?.play(c, c.startsWith('Death') || c.includes('Attack') || c.includes('Shoot'))}>
                  {c}
                </button>
              ))}
            </div>
          </>
        )}
        <p className="muted small">Drag to orbit, wheel to zoom. The gold capsule is player height (54).</p>
      </aside>
      <div className="dev-canvas">
        {/* The three.js canvas lives in its own element: React must never own its siblings, or a text update wipes it. */}
        <div className="dev-canvas-host" ref={host} />
        {status !== '' ? <span className="dev-status">{status}</span> : null}
      </div>
    </div>
  );
}
