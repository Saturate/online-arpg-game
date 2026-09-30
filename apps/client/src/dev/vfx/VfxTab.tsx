import { validateLayout, type TownLayout } from '@rune/shared';
import { useEffect, useRef, useState } from 'react';
import { readLink, writeLink } from '../deepLink.js';
import { isVfxQuality, QUALITY_LABELS, VFX_QUALITIES, type VfxQuality } from '../../render/vfx/quality.js';
import { BENCH_SCENES, VfxBench, type VfxBenchResult } from './vfxBench.js';

declare global {
  interface Window {
    /** Set while the VFX bench runs, so a browser script can measure and seek. */
    vfxBench?: VfxBench | undefined;
  }
}

/** `#vfx/<scene>/<quality>`. `?time=0.75` in the URL shows the scene at night. */
export function VfxTab() {
  const [, first, second] = readLink();
  const [scene, setScene] = useState(() => BENCH_SCENES.find((s) => s.id === first)?.id ?? 'crowd');
  // The bench's own quality, so measuring Low never changes the player's saved setting.
  const [quality, setQuality] = useState<VfxQuality>(isVfxQuality(second) ? second : 'high');
  const host = useRef<HTMLDivElement>(null);
  const fxLayer = useRef<HTMLDivElement>(null);
  const bench = useRef<VfxBench | null>(null);
  const [result, setResult] = useState<VfxBenchResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Scripts taking screenshots switch scenes by editing the hash.
    const onHash = () => {
      const [, id, q] = readLink();
      if (id && BENCH_SCENES.some((s) => s.id === id)) setScene(id);
      if (isVfxQuality(q)) setQuality(q);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    bench.current?.setQuality(quality);
    writeLink(['vfx', scene, quality]);
  }, [quality, scene]);

  useEffect(() => {
    const hostEl = host.current;
    const layerEl = fxLayer.current;
    if (!hostEl || !layerEl) return;
    let b: VfxBench | null = null;
    let cancelled = false;
    const start = (town: TownLayout | undefined): void => {
      if (cancelled) return;
      b = new VfxBench(hostEl, layerEl, scene, town);
      b.setQuality(quality);
      bench.current = b;
      window.vfxBench = b;
    };
    // The town scene shows the live town, as the server has it, rather than the shipped default.
    if (BENCH_SCENES.find((s) => s.id === scene)?.map === 'town') {
      fetch('/api/town')
        .then((r) => r.json())
        .then((j: unknown) => start(validateLayout(j) ?? undefined), () => start(undefined));
    } else start(undefined);
    return () => {
      cancelled = true;
      b?.dispose();
      if (b && window.vfxBench === b) window.vfxBench = undefined;
    };
    // Quality changes go to the running bench above; only a new scene rebuilds it.
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
        <div className="chip-row">
          {VFX_QUALITIES.map((q) => (
            <button key={q} type="button" className={q === quality ? 'on' : ''} onClick={() => setQuality(q)}>
              {QUALITY_LABELS[q]}
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
              <tr><td>particles</td><td>{result.particles}</td></tr>
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
