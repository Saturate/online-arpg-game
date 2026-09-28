import { CLASSES } from '@rune/shared';
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Game } from '../game/game.js';
import { decodeReplay, type ReplayFile } from '../game/replay.js';
import { Banner, Hud, Notices, Party, TargetFrame } from '../ui/Hud.js';
import { StagingPanel } from '../ui/StagingPanel.js';
import { useUi } from '../ui/store.js';
import { ReplayPlayer } from './replay/player.js';
import '../styles.css';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Plays a recorded session back through the real client: same renderer, HUD and effects, no server. */
export function ReplayTab() {
  const [file, setFile] = useState<ReplayFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true);
  const hostRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const session = useRef<{ game: Game; player: ReplayPlayer } | null>(null);
  const roomName = useUi((s) => s.roomName);

  const mount = (f: ReplayFile, at: number, sp: number, play: boolean) => {
    session.current?.game.destroy();
    const host = hostRef.current;
    const fx = fxRef.current;
    if (!host || !fx) return;
    const player = new ReplayPlayer(f, at, sp, play);
    const game = new Game({ host, fxLayer: fx, minimap: minimapRef.current }, { kind: 'replay', source: player, classId: f.classId, name: f.name });
    session.current = { game, player };
    // The HUD matches the recorder's own character by name.
    useUi.setState({ classId: f.classId, name: f.name });
    void game.start();
  };

  useEffect(() => {
    if (!file) return;
    mount(file, 0, 1, true);
    setTime(0);
    setSpeed(1);
    setPlaying(true);
    const timer = setInterval(() => {
      const p = session.current?.player;
      if (!p) return;
      setTime(p.now());
      if (!p.isPlaying) setPlaying(false);
    }, 200);
    return () => {
      clearInterval(timer);
      session.current?.game.destroy();
      session.current = null;
    };
  }, [file]);

  const load = async (blob: Blob) => {
    const res = await decodeReplay(blob);
    if (typeof res === 'string') {
      setError(res);
      return;
    }
    setError(null);
    setFile(res);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void load(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) void load(f);
  };

  const seek = (t: number) => {
    if (!file) return;
    setTime(t);
    mount(file, t, speed, playing);
  };

  return (
    <div className="replay-tab" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="replay-bar">
        <label className="replay-file">
          Open replay
          <input type="file" accept=".gz,.json,application/json,application/gzip" onChange={onPick} />
        </label>
        {file && (
          <>
            <span className="muted">
              {file.name} ({CLASSES[file.classId].name}), {new Date(file.recordedAt).toLocaleString()}
            </span>
            <button
              type="button"
              onClick={() => {
                const p = session.current?.player;
                if (!p) return;
                if (p.ended) {
                  seek(0);
                  setPlaying(true);
                  return;
                }
                p.setPlaying(!playing);
                setPlaying(!playing);
              }}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={s === speed ? 'on' : ''}
                onClick={() => {
                  session.current?.player.setSpeed(s);
                  setSpeed(s);
                }}
              >
                x{s}
              </button>
            ))}
            <input
              className="replay-seek"
              type="range"
              min={0}
              max={Math.round(file.durationMs)}
              step={100}
              value={Math.round(time)}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="Seek"
            />
            <span className="replay-time">
              {clock(time)} / {clock(file.durationMs)}
            </span>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {!file && <p className="replay-empty muted">Record in game with F8 (or the Esc menu), then open or drop the .json.gz file here.</p>}
      <div className="game replay-game" hidden={!file}>
        <div className="canvas-host" ref={hostRef} />
        <div className="fx-layer" ref={fxRef} aria-hidden="true" />
        <div className="minimap">
          <canvas ref={minimapRef} aria-label="Minimap" />
          <span>{roomName}</span>
        </div>
        <Party />
        <Notices />
        <Hud />
        <StagingPanel />
        <Banner />
        <TargetFrame />
      </div>
    </div>
  );
}
