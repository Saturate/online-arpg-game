import { SIM, type ClassId, type SigilCompile } from '@rune/shared';
import { useEffect, useRef, useState } from 'react';
import { useCastTiming } from '../../game/castTiming.js';
import { useUi } from '../store.js';
import { CAST_EVERY, ForgePreview } from './preview.js';

const WIDTH = 360;
const HEIGHT = 170;
/** A stalled frame (tab in the background) never tries to catch up more than this many ticks. */
const MAX_STEPS = 8;

/**
 * The forge's training dummy. `spellKey` names the draft, so the spell is swapped only when the
 * runes change, not on every render.
 */
export function ForgePreviewCanvas({ classId, spellKey, compiled, castDelayShare }: { classId: ClassId; spellKey: string; compiled: SigilCompile | null; castDelayShare: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<ForgePreview | null>(null);
  const [dps, setDps] = useState(0);
  const globalSeconds = useCastTiming((s) => s.globalSeconds);
  const castSpeed = useUi((s) => s.stats?.castSpeedMult ?? 1);
  const latest = useRef({ compiled, castDelayShare, globalSeconds, castSpeed });
  latest.current = { compiled, castDelayShare, globalSeconds, castSpeed };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const preview = new ForgePreview(classId);
    preview.setTiming(latest.current.globalSeconds, latest.current.castSpeed);
    preview.setSpell(latest.current.compiled, latest.current.castDelayShare);
    previewRef.current = preview;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let last = performance.now();
    let acc = 0;
    let frame = 0;
    let shown = -1;
    const loop = (now: number) => {
      acc += Math.min(now - last, SIM.dt * 1000 * MAX_STEPS) / 1000;
      last = now;
      while (acc >= SIM.dt) {
        preview.step();
        acc -= SIM.dt;
      }
      preview.draw(ctx, WIDTH, HEIGHT);
      const rounded = Math.round(preview.dps);
      if (rounded !== shown) {
        shown = rounded;
        setDps(rounded);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      previewRef.current = null;
    };
  }, [classId]);

  useEffect(() => {
    previewRef.current?.setTiming(globalSeconds, castSpeed);
  }, [globalSeconds, castSpeed]);

  useEffect(() => {
    previewRef.current?.setSpell(latest.current.compiled, latest.current.castDelayShare);
  }, [spellKey]);

  const idle = !compiled || !compiled.ok;
  return (
    <figure className="forge-preview">
      <canvas ref={canvasRef} style={{ width: WIDTH, height: HEIGHT }} aria-label="Preview on a training dummy" />
      <figcaption>
        <span>Training dummy</span>
        {idle ? <span className="muted">{compiled ? 'Nothing to cast until the spell is fixed' : 'No spell'}</span> : <span>{dps} damage per second, casting every {CAST_EVERY} s</span>}
      </figcaption>
    </figure>
  );
}
