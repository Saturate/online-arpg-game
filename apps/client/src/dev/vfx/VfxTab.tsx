import { useEffect, useRef, useState } from 'react';
import { readLink, writeLink } from '../deepLink.js';
import { BENCH_SCENES, VfxBench, type VfxBenchResult } from './vfxBench.js';

declare global {
  interface Window {
    /** Set while the VFX bench runs, so a browser script can measure and seek. */
    vfxBench?: VfxBench | undefined;
  }
}

/** `#vfx/<scene>`. `?time=0.75` in the URL shows the scene at night. */
export function VfxTab() {
  const [, first] = readLink();
  const [scene, setScene] = useState(() => BENCH_SCENES.find((s) => s.id === first)?.id ?? 'crowd');
  const host = useRef<HTMLDivElement>(null);
  const fxLayer = useRef<HTMLDivElement>(null);
  const bench = useRef<VfxBench | null>(null);
  const [result, setResult] = useState<VfxBenchResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    writeLink(['vfx', scene]);
    if (!host.current || !fxLayer.current) return;
    const b = new VfxBench(host.current, fxLayer.current, scene);
    bench.current = b;
    window.vfxBench = b;
    return () => {
      b.dispose();
      if (window.vfxBench === b) window.vfxBench = undefined;
    };
  }, [scene]);

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
        <h3>VFX bench</h3>
        <p className="muted small">A recorded fight of god-mode casters holding their skills into pinned monsters, looped through the game's renderer. Add ?time=0.75 to the URL for night.</p>
        <div className="chip-row">
          {BENCH_SCENES.map((s) => (
            <button key={s.id} type="button" className={s.id === scene ? 'on' : ''} onClick={() => setScene(s.id)} title={s.label}>
              {s.id}
            </button>
          ))}
        </div>
        <button type="button" className="wide" disabled={busy} onClick={run}>
          {busy ? 'Measuring...' : 'Measure 300 frames'}
        </button>
        {result && (
          <table className="rigs-stats small">
            <tbody>
              <tr><td>spells</td><td>{result.spells}</td></tr>
              <tr><td>draw calls</td><td>{result.drawCalls}</td></tr>
              <tr><td>triangles</td><td>{result.triangles}</td></tr>
              <tr><td>entities ms</td><td>{result.entitiesMs.toFixed(2)}</td></tr>
              <tr><td>effects ms</td><td>{result.fxMs.toFixed(2)}</td></tr>
              <tr><td>render ms</td><td>{result.renderMs.toFixed(2)}</td></tr>
              <tr><td>frame ms</td><td>{result.frameMs.toFixed(2)}</td></tr>
              <tr><td>heap per frame</td><td>{result.heapPerFrame === null ? 'n/a' : `${result.heapPerFrame} B`}</td></tr>
            </tbody>
          </table>
        )}
      </aside>
      <div className="dev-canvas">
        <div className="dev-canvas-host" ref={host} />
        <div className="fx-layer" ref={fxLayer} aria-hidden="true" />
      </div>
    </div>
  );
}
