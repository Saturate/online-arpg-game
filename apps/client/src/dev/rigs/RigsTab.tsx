import { useEffect, useRef, useState } from 'react';
import type { AnimRole } from '../../render/assets.js';
import { readLink, writeLink } from '../deepLink.js';
import { RigBench, type BenchResult } from './rigBench.js';
import { GALLERY_ENTRIES, GALLERY_ROLES, RigGallery } from './rigGallery.js';

type Mode = 'gallery' | 'bench';

declare global {
  interface Window {
    /** Set while the bench runs, so a browser script can take measurements. */
    rigBench?: RigBench | undefined;
    /** Set while the gallery shows, so a browser script can set roles for screenshots. */
    rigGallery?: RigGallery | undefined;
  }
}

function isRole(v: string | undefined): v is AnimRole {
  return GALLERY_ROLES.some((r) => r === v);
}

/** `#monsters/gallery/<role>/<day|night>[/<type,type>]` or `#monsters/bench`. */
export function RigsTab() {
  const [, first, second, third, fourth] = readLink();
  const [only] = useState(() => (fourth ? fourth.split(',') : null));
  const [mode, setMode] = useState<Mode>(first === 'bench' ? 'bench' : 'gallery');
  const [role, setRole] = useState<AnimRole>(isRole(second) ? second : 'idle');
  const [night, setNight] = useState(third === 'night');
  useEffect(() => {
    writeLink(mode === 'bench' ? ['monsters', 'bench'] : ['monsters', 'gallery', role, night ? 'night' : 'day', ...(only ? [only.join(',')] : [])]);
  }, [mode, role, night, only]);
  return (
    <div className="rigs">
      <div className="studio-toolbar">
        <button type="button" className={mode === 'gallery' ? 'on' : ''} onClick={() => setMode('gallery')}>
          Gallery
        </button>
        <button type="button" className={mode === 'bench' ? 'on' : ''} onClick={() => setMode('bench')}>
          Bench
        </button>
        {mode === 'gallery' && (
          <>
            <span className="sep" />
            <span className="muted">All:</span>
            {GALLERY_ROLES.map((r) => (
              <button key={r} type="button" className={r === role ? 'on' : ''} onClick={() => setRole(r)}>
                {r}
              </button>
            ))}
            <span className="sep" />
            <button type="button" className={night ? '' : 'on'} onClick={() => setNight(false)}>
              Day
            </button>
            <button type="button" className={night ? 'on' : ''} onClick={() => setNight(true)}>
              Night
            </button>
          </>
        )}
      </div>
      {mode === 'gallery' ? <GalleryPanel role={role} night={night} only={only} /> : <BenchPanel />}
    </div>
  );
}

function GalleryPanel({ role, night, only }: { role: AnimRole; night: boolean; only: readonly string[] | null }) {
  const [entries] = useState(() => (only ? GALLERY_ENTRIES.filter((e) => only.includes(e.key)) : GALLERY_ENTRIES));
  const scroller = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const cells = useRef<(HTMLDivElement | null)[]>([]);
  const labels = useRef<(HTMLSpanElement | null)[]>([]);
  const gallery = useRef<RigGallery | null>(null);
  const [roles, setRoles] = useState<AnimRole[]>(() => entries.map(() => role));

  useEffect(() => {
    if (!scroller.current || !canvasHost.current) return;
    const g = new RigGallery(canvasHost.current, scroller.current);
    entries.forEach((e, i) => {
      const el = cells.current[i];
      // `?raw` shows the uncompiled models, to compare against the compiled ones.
      if (el) g.add(e, el, labels.current[i] ?? null, role, new URLSearchParams(location.search).has('raw'));
    });
    gallery.current = g;
    window.rigGallery = g;
    return () => {
      g.dispose();
      if (window.rigGallery === g) window.rigGallery = undefined;
    };
    // The gallery is built once; role and night changes go through the effects below.
  }, []);

  useEffect(() => {
    gallery.current?.setAll(role);
    setRoles(entries.map(() => role));
  }, [role]);

  useEffect(() => {
    gallery.current?.setNight(night);
  }, [night]);

  return (
    <div className="rigs-scroll" ref={scroller}>
      <div className="rigs-content">
        <div className="rigs-canvas-host" ref={canvasHost} />
        <div className={entries.length <= 6 ? 'rigs-grid big' : 'rigs-grid'}>
          {entries.map((e, i) => (
            <div
              key={e.key}
              className="rigs-cell"
              ref={(el) => {
                cells.current[i] = el;
              }}
            >
              <div className="rigs-cell-head">
                <span className="rigs-name">{e.label}</span>
                <select
                  value={roles[i] ?? 'idle'}
                  onChange={(ev) => {
                    const next = ev.target.value;
                    if (!isRole(next)) return;
                    gallery.current?.setRole(i, next);
                    setRoles((prev) => prev.map((r, k) => (k === i ? next : r)));
                  }}
                >
                  {GALLERY_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <span
                className="rigs-live muted small"
                ref={(el) => {
                  labels.current[i] = el;
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BenchPanel() {
  const host = useRef<HTMLDivElement>(null);
  const bench = useRef<RigBench | null>(null);
  const [count, setCount] = useState(120);
  const [spread, setSpread] = useState(false);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const b = new RigBench(host.current, count, spread);
    bench.current = b;
    window.rigBench = b;
    return () => {
      b.dispose();
      if (window.rigBench === b) window.rigBench = undefined;
    };
  }, [count, spread]);

  const run = () => {
    const b = bench.current;
    if (!b) return;
    setBusy(true);
    b.measure(300)
      .then(setResult)
      .finally(() => setBusy(false));
  };

  return (
    <div className="dev-split rigs-bench">
      <aside className="dev-side">
        <h3>Bench</h3>
        <p className="muted small">The game's own renderer on a wilds map, with procedural monsters of every type walking, attacking and taking hits.</p>
        <div className="chip-row">
          {[0, 30, 120, 240].map((n) => (
            <button key={n} type="button" className={n === count ? 'on' : ''} onClick={() => setCount(n)}>
              {n}
            </button>
          ))}
        </div>
        <label className="small">
          <input type="checkbox" checked={spread} onChange={(e) => setSpread(e.target.checked)} /> half of them off screen
        </label>
        <button type="button" className="wide" disabled={busy} onClick={run}>
          {busy ? 'Measuring...' : 'Measure 300 frames'}
        </button>
        {result && (
          <table className="rigs-stats small">
            <tbody>
              <tr><td>monsters</td><td>{result.monsters}</td></tr>
              <tr><td>draw calls</td><td>{result.drawCalls}</td></tr>
              <tr><td>triangles</td><td>{result.triangles}</td></tr>
              <tr><td>entities ms</td><td>{result.entitiesMs.toFixed(2)}</td></tr>
              <tr><td>render ms</td><td>{result.renderMs.toFixed(2)}</td></tr>
              <tr><td>frame ms</td><td>{result.frameMs.toFixed(2)}</td></tr>
              <tr><td>heap per frame</td><td>{result.heapPerFrame === null ? 'n/a' : `${result.heapPerFrame} B`}</td></tr>
            </tbody>
          </table>
        )}
      </aside>
      <div className="dev-canvas">
        <div className="dev-canvas-host" ref={host} />
      </div>
    </div>
  );
}
