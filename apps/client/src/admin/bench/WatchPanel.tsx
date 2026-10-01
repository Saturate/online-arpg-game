import { benchCast, HARNESS_DEFAULTS, type BenchCast, type TunableValues } from '@rune/shared';
import { useEffect, useRef, useState } from 'react';
import { StudioSim } from '../../dev/studio/studioSim.js';
import { StudioView } from '../../dev/studio/studioView.js';
import type { BenchRow } from './benchRows.js';
import { endWatch, watchWith } from './watchTuning.js';

interface Reading {
  seconds: number;
  dps: number;
  forcePerSecond: number;
  perForce: number;
}

const NO_READING: Reading = { seconds: 0, dps: 0, forcePerSecond: 0, perForce: 0 };

/**
 * One Spell Studio stage: the row's sigil cast at the bench's cadence, under the Force bar like the
 * harness, at `dummies` pinned dummies. The numbers below it are the studio's own running counts.
 */
function Stage({ cast, dummies, label, name }: { cast: BenchCast; dummies: number; label: string; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const fx = useRef<HTMLDivElement>(null);
  const [reading, setReading] = useState<Reading>(NO_READING);

  useEffect(() => {
    if (!host.current || !fx.current) return;
    const studio = new StudioSim(
      { seed: HARNESS_DEFAULTS.seed, classId: cast.classId, dummies, dummyType: 'chaser', layout: 'pack', distance: cast.distance ?? HARNESS_DEFAULTS.distance },
      { id: 'bench', name, description: '', classId: cast.classId, text: 'bolt' },
    );
    studio.sim.setRates({ ...studio.sim.rates, castCooldown: HARNESS_DEFAULTS.castCooldown });
    studio.setCompiled(cast.sigil.compiled, cast.sigil.castDelayShare);
    studio.cast = { mode: 'bar', intervalSeconds: 1, infiniteForce: false };
    const view = new StudioView(studio, host.current, fx.current);
    // Polling keeps React out of the 20 Hz tick loop.
    const timer = window.setInterval(() => {
      const s = studio.metrics.summary();
      const spent = s.heatPerSecond * s.seconds;
      setReading({ seconds: s.seconds, dps: s.dpsRun, forcePerSecond: s.heatPerSecond, perForce: spent > 0 ? s.damage / spent : 0 });
    }, 250);
    return () => {
      window.clearInterval(timer);
      view.dispose();
    };
  }, [cast, dummies, name]);

  return (
    <figure className="bn-stage">
      <figcaption>{label}</figcaption>
      <div className="bn-canvas">
        <div className="canvas-host" ref={host} />
        <div className="fx-layer" ref={fx} aria-hidden="true" />
      </div>
      <dl className="bn-reading">
        <div>
          <dt>Time</dt>
          <dd>{reading.seconds.toFixed(1)} s</dd>
        </div>
        <div>
          <dt>Damage a second</dt>
          <dd>{Math.round(reading.dps)}</dd>
        </div>
        <div>
          <dt>Force a second</dt>
          <dd>{reading.forcePerSecond.toFixed(1)}</dd>
        </div>
        <div>
          <dt>Per Force</dt>
          <dd>{reading.perForce.toFixed(2)}</dd>
        </div>
      </dl>
    </figure>
  );
}

/**
 * The bench's "watch one": the sigil cast at one dummy and at a pack, under the proposed numbers
 * or the saved ones. The studio runs on the page's own copy of the config, so the chosen set is
 * applied here while the panel is open and the code defaults put back when it closes; nothing on
 * the admin page reads those numbers otherwise, and nothing is sent to the server.
 */
export default function WatchPanel({ row, live, proposed, previewing, onClose }: { row: BenchRow; live: TunableValues; proposed: TunableValues; previewing: boolean; onClose: () => void }) {
  const [which, setWhich] = useState<'proposed' | 'live'>('proposed');
  const [cast, setCast] = useState<BenchCast | string | null>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    watchWith(which === 'proposed' ? proposed : live);
    setCast(benchCast(row.spec));
  }, [which, row, live, proposed]);
  useEffect(() => endWatch, []);

  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="bn-watch-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="bn-watch" role="dialog" aria-modal="true" aria-labelledby="bn-watch-title">
        <header>
          <h2 id="bn-watch-title">{row.name}</h2>
          <span className="mono bn-text">{row.text}</span>
          {previewing && (
            <div className="bn-toggle" role="group" aria-label="Numbers">
              <button type="button" className={which === 'proposed' ? 'on' : ''} aria-pressed={which === 'proposed'} onClick={() => setWhich('proposed')}>
                With unsaved edits
              </button>
              <button type="button" className={which === 'live' ? 'on' : ''} aria-pressed={which === 'live'} onClick={() => setWhich('live')}>
                Saved numbers
              </button>
            </div>
          )}
          <button type="button" ref={close} onClick={onClose}>
            Close
          </button>
        </header>
        {cast === null ? (
          <p className="muted">Loading</p>
        ) : typeof cast === 'string' ? (
          <p className="bn-error">Does not cast under these numbers: {cast}</p>
        ) : (
          <div className="bn-stages" key={which}>
            <Stage cast={cast} dummies={1} label="One dummy" name={row.name} />
            <Stage cast={cast} dummies={HARNESS_DEFAULTS.packSize} label={`Pack of ${HARNESS_DEFAULTS.packSize}`} name={row.name} />
          </div>
        )}
        <p className="muted small">Cast every {HARNESS_DEFAULTS.castCooldown} s while Force is under the bar, as the bench measures. The bench's figure is over the first 10 s; the stage keeps counting.</p>
      </section>
    </div>
  );
}
