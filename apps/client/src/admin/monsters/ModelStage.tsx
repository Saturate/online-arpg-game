import { useEffect, useRef, useState } from 'react';
import type { AnimRole } from '../../render/assets.js';
import { MonsterViewer, type StageModel } from './monsterViewer.js';

export const ROLES: readonly AnimRole[] = ['idle', 'walk', 'run', 'attack', 'windup', 'cast', 'shoot', 'hit', 'death', 'dormant', 'awaken', 'spawn'];
const LOOPING: ReadonlySet<AnimRole> = new Set(['idle', 'walk', 'run', 'dormant']);

export interface StageTarget {
  /** Changes whenever the model must be rebuilt (type, model, height or radius). */
  key: string;
  load: () => Promise<StageModel>;
  roles: Partial<Record<AnimRole, string>>;
}

/**
 * The 3D view with its controls: a role picker that plays each role's clip the way the game would
 * (loops for locomotion, once for the rest), day or night, and a scrubber for the playing clip.
 */
export function ModelStage({ target, arrow = false, allClips = false, note }: { target: StageTarget | null; arrow?: boolean; allClips?: boolean; note?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<MonsterViewer | null>(null);
  const [night, setNight] = useState(false);
  const [clips, setClips] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [loop, setLoop] = useState(true);
  const [clip, setClip] = useState<{ name: string; time: number; duration: number; paused: boolean } | null>(null);
  const roles = target?.roles;

  useEffect(() => {
    if (!host.current) return;
    viewer.current = new MonsterViewer(host.current);
    return () => viewer.current?.dispose();
  }, []);

  useEffect(() => {
    viewer.current?.setNight(night);
  }, [night]);

  const key = target?.key;
  useEffect(() => {
    const v = viewer.current;
    if (!v || !target) return;
    setStatus('Loading...');
    let live = true;
    v.showModel(target.load, { arrow })
      .then((names) => {
        if (!live) return;
        setClips(names);
        setStatus('');
        const idle = target.roles.idle;
        if (idle) v.playClip(idle, true);
      })
      .catch((e: unknown) => live && setStatus(e instanceof Error ? e.message : 'Could not load the model'));
    return () => {
      live = false;
    };
    // The key stands for everything in the target that needs a rebuild; a new load function alone does not.
  }, [key, arrow]);

  useEffect(() => {
    const t = setInterval(() => setClip(viewer.current?.clipState() ?? null), 100);
    return () => clearInterval(t);
  }, []);

  const playRole = (role: AnimRole) => {
    const name = roles?.[role];
    if (name) viewer.current?.playClip(name, LOOPING.has(role));
  };

  return (
    <div className="mon-stage">
      <div className="mon-canvas">
        {/* React must not own the canvas host's children, or a re-render wipes the three.js canvas. */}
        <div className="mon-canvas-host" ref={host} />
        {status !== '' && <span className="mon-status">{status}</span>}
        {note && <span className="mon-note">{note}</span>}
      </div>
      <div className="mon-controls">
        <div className="chip-row" role="group" aria-label="Animation role">
          {ROLES.map((r) => (
            <button key={r} type="button" disabled={!roles?.[r]} title={roles?.[r] ?? 'No clip for this role'} className={clip && roles?.[r] === clip.name ? 'on' : ''} onClick={() => playRole(r)}>
              {r}
            </button>
          ))}
          <span className="mon-spacer" />
          <button type="button" className={night ? 'on' : ''} onClick={() => setNight(!night)} title="The game's night at the default night brightness">
            {night ? 'Night' : 'Day'}
          </button>
        </div>
        {allClips && clips.length > 0 && (
          <div className="chip-row" role="group" aria-label="Clips in the file">
            {clips.map((c) => (
              <button key={c} type="button" className={clip?.name === c ? 'on' : ''} onClick={() => viewer.current?.playClip(c, loop)}>
                {c}
              </button>
            ))}
            <label className="mon-inline">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
            </label>
          </div>
        )}
        {clip && (
          <div className="mon-scrub">
            <button type="button" onClick={() => viewer.current?.pause(!clip.paused)}>
              {clip.paused ? 'Play' : 'Pause'}
            </button>
            <input type="range" min={0} max={clip.duration} step={0.01} value={Math.min(clip.time, clip.duration)} onChange={(e) => viewer.current?.scrub(Number(e.target.value))} aria-label="Scrub the clip" />
            <span className="muted small">
              {clip.name} {clip.time.toFixed(2)} / {clip.duration.toFixed(2)} s
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
