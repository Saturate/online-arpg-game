import { validateLayout, type TownLayout } from '@rune/shared';
import { useEffect, useRef, useState } from 'react';
import { readLink, writeLink } from '../deepLink.js';
import { WORLD_BENCH_SCENES, WorldBench, type WorldBenchResult } from './worldBench.js';

declare global {
  interface Window {
    /** Set while the world bench runs, so a browser script can measure and seek. */
    worldBench?: WorldBench | undefined;
  }
}

/** `#world/<scene>`. `?time=0.75` in the URL shows the walk at night. */
export function WorldTab() {
  const [, first] = readLink();
  const [scene, setScene] = useState(() => WORLD_BENCH_SCENES.find((s) => s.id === first)?.id ?? 'town');
  const host = useRef<HTMLDivElement>(null);
  const fxLayer = useRef<HTMLDivElement>(null);
  const minimap = useRef<HTMLCanvasElement>(null);
  const bench = useRef<WorldBench | null>(null);
  const [result, setResult] = useState<WorldBenchResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onHash = () => {
      const [, id] = readLink();
      if (id && WORLD_BENCH_SCENES.some((s) => s.id === id)) setScene(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    writeLink(['world', scene]);
    const hostEl = host.current;
    const layerEl = fxLayer.current;
    if (!hostEl || !layerEl) return;
    let b: WorldBench | null = null;
    let cancelled = false;
    const start = (town: TownLayout | undefined): void => {
      if (cancelled) return;
      b = new WorldBench(hostEl, layerEl, scene, town, minimap.current ?? undefined);
      bench.current = b;
      window.worldBench = b;
    };
    // The home zone shows the live town, as the server has it, rather than the shipped default.
    if (scene === 'town') {
      fetch('/api/town')
        .then((r) => r.json())
        .then((j: unknown) => start(validateLayout(j) ?? undefined), () => start(undefined));
    } else start(undefined);
    return () => {
      cancelled = true;
      b?.dispose();
      if (b && window.worldBench === b) window.worldBench = undefined;
    };
  }, [scene]);

  const run = () => {
    const b = bench.current;
    if (!b) return;
    setBusy(true);
    b.measure()
      .then(setResult)
      .finally(() => setBusy(false));
  };

  const rows: [string, string][] = result
    ? [
        ['map', result.mapSize],
        ['build ms', result.buildMs.toFixed(1)],
        ['ready ms', result.readyMs.toFixed(0)],
        ['frames', String(result.frames)],
        ['draw calls', `${result.drawCalls} (max ${result.maxDrawCalls})`],
        ['triangles', String(result.triangles)],
        ['render ms', `${result.renderMs.toFixed(2)} (p95 ${result.renderP95.toFixed(2)})`],
        ['heap per frame', result.heapPerFrame === null ? 'n/a' : `${result.heapPerFrame} B`],
        ['geometries', `${result.geometries} (max ${result.maxGeometries})`],
        ['textures', String(result.textures)],
        ['buffers', `${(result.bufferBytes / 1e6).toFixed(1)} MB (max ${(result.maxBufferBytes / 1e6).toFixed(1)})`],
        ['meshes', String(result.meshes)],
        ['chunks', result.chunks],
      ]
    : [];

  return (
    <div className="dev-split rigs-bench">
      <aside className="dev-side">
        <h3>World bench</h3>
        <p className="muted small">The static world with no monsters, the camera walked over the map. Add ?time=0.75 to the URL for night.</p>
        <div className="chip-row">
          {WORLD_BENCH_SCENES.map((s) => (
            <button key={s.id} type="button" className={s.id === scene ? 'on' : ''} onClick={() => setScene(s.id)} title={s.label}>
              {s.id}
            </button>
          ))}
        </div>
        <button type="button" className="wide" disabled={busy} onClick={run}>
          {busy ? 'Walking...' : 'Walk and measure'}
        </button>
        {result && (
          <table className="rigs-stats small">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </aside>
      <div className="dev-canvas">
        <div className="dev-canvas-host" ref={host} />
        <div className="fx-layer" ref={fxLayer} aria-hidden="true" />
        <canvas ref={minimap} aria-label="Minimap" style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(10, 9, 8, 0.8)', padding: 6, pointerEvents: 'none', width: 'auto', height: 'auto' }} />
      </div>
    </div>
  );
}
