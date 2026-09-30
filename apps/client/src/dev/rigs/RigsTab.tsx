import { useEffect, useRef, useState } from 'react';
import { RigBench, type BenchResult } from './rigBench.js';

type Mode = 'bench';

declare global {
  interface Window {
    /** Set while the bench runs, so a browser script can take measurements. */
    rigBench?: RigBench | undefined;
  }
}

export function RigsTab() {
  const [mode] = useState<Mode>('bench');
  return <div className="rigs">{mode === 'bench' && <BenchPanel />}</div>;
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
    <div className="dev-split">
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
