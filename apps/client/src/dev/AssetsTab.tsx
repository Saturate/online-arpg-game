import { useEffect, useRef, useState } from 'react';
import { ASSETS, type AssetCategory } from '../render/assets.js';
import { AssetViewer } from './assetViewer.js';

const CATEGORIES: AssetCategory[] = ['hero', 'monster', 'building', 'nature', 'prop', 'dungeon', 'graveyard'];

export function AssetsTab() {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<AssetViewer | null>(null);
  const [category, setCategory] = useState<AssetCategory>('hero');
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
    setStatus('Loading...');
    const def = selected ? ASSETS.find((a) => a.id === selected) : undefined;
    const job = def ? v.showSingle(def).then(setClips) : v.showGallery(ASSETS.filter((a) => a.category === category)).then(() => setClips([]));
    job.then(() => setStatus('')).catch((e: unknown) => setStatus(e instanceof Error ? e.message : 'Failed to load'));
  }, [category, selected]);

  const list = ASSETS.filter((a) => a.category === category);
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
        <button type="button" className={selected === null ? 'on wide' : 'wide'} onClick={() => setSelected(null)}>
          Gallery: all {list.length}
        </button>
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
