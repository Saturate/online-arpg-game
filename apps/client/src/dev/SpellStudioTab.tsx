import {
  CASTABLE_RUNES,
  CLASS_IDS,
  CLASSES,
  classStarterSigils,
  describeTree,
  ENEMY_TYPE_IDS,
  runeColor,
  runeKind,
  runeName,
  type ClassId,
  type EnemyTypeId,
  type RuneKind,
  type SigilCompile,
} from '@rune/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cssColor } from '../render/config.js';
import { formatSkill, skillIdFromName } from './studio/exportSkill.js';
import type { MetricsSummary, TickSample } from './studio/metrics.js';
import { TIMELINE_TICKS } from './studio/metrics.js';
import { compileSkill, StudioSim, studioSkillOf, type CastMode, type DummyLayout, type StudioSetup, type StudioSkill } from './studio/studioSim.js';
import { StudioView } from './studio/studioView.js';

const KIND_ORDER: readonly RuneKind[] = ['shape', 'infusion', 'effect', 'modifier', 'trigger', 'shaper'];
const TIME_SCALES = [0.1, 0.25, 0.5, 1, 2, 4];
const LAYOUTS: readonly DummyLayout[] = ['pack', 'line', 'ring'];
const CAST_MODES: readonly { id: CastMode; label: string }[] = [
  { id: 'hold', label: 'Hold' },
  { id: 'bar', label: 'Under bar' },
  { id: 'interval', label: 'Interval' },
  { id: 'manual', label: 'Click' },
];
const EMPTY_SUMMARY: MetricsSummary = { seconds: 0, damage: 0, hits: 0, casts: 0, fizzles: 0, dpsWindow: 0, dpsRun: 0, hitsPerCast: 0, heatPerSecond: 0, peakLive: 0 };

function blankSkill(classId: ClassId): StudioSkill {
  return { id: 'custom_skill', name: 'Custom Skill', description: '', classId, text: 'bolt' };
}

function firstSkill(classId: ClassId): StudioSkill {
  const def = classStarterSigils(classId)[0];
  return def ? studioSkillOf(def) : blankSkill(classId);
}

function CompileBox({ result }: { result: SigilCompile }) {
  if (!result.ok) {
    return (
      <div className="studio-compile bad">
        {result.errors.map((e, i) => (
          <strong key={i}>
            {e.rule}: {e.message}
          </strong>
        ))}
        <span>A cast fizzles for {Math.round(result.force)} Force</span>
      </div>
    );
  }
  return (
    <div className="studio-compile">
      <strong>{result.persistent ? `Persistent, ${result.spirit} spirit` : `${Math.round(result.force)} Force per cast`}</strong>
      <span>Peak {result.peakEntities} entities</span>
      <span className="muted">{describeTree(result.tree)}</span>
      {result.notes.map((n) => (
        <span key={n} className="muted">
          {n}
        </span>
      ))}
    </div>
  );
}

/** Stacked tick columns: hits in red, casts in gold, explosions in orange, live spell entities as a line. */
function Timeline({ samples }: { samples: readonly TickSample[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0907';
    ctx.fillRect(0, 0, w, h);
    const col = w / TIMELINE_TICKS;
    const maxHits = Math.max(4, ...samples.map((s) => s.hits));
    const maxLive = Math.max(4, ...samples.map((s) => s.live));
    const offset = TIMELINE_TICKS - samples.length;
    samples.forEach((s, i) => {
      const x = (offset + i) * col;
      if (s.hits > 0) {
        const bar = (s.hits / maxHits) * (h - 14);
        ctx.fillStyle = '#b8403a';
        ctx.fillRect(x, h - bar, Math.max(1, col), bar);
      }
      if (s.casts > 0) {
        ctx.fillStyle = '#e8c070';
        ctx.fillRect(x, 0, Math.max(2, col), 6);
      }
      if (s.explodes > 0) {
        ctx.fillStyle = '#ff8a3a';
        ctx.fillRect(x, 7, Math.max(2, col), 4);
      }
      if (s.fizzles > 0) {
        ctx.fillStyle = '#888';
        ctx.fillRect(x, 12, Math.max(2, col), 3);
      }
    });
    ctx.strokeStyle = '#7fb6ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = (offset + i + 0.5) * col;
      const y = h - (s.live / maxLive) * (h - 14);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [samples]);
  return <canvas ref={ref} className="studio-timeline" width={560} height={120} aria-label="Trigger timeline for the last 15 seconds" />;
}

/** A spell handed over from the Spell Lab, cast instead of the draft skill until cleared. */
export interface InjectedSpell {
  label: string;
  compiled: SigilCompile;
  notes: string[];
}

export function SpellStudioTab({ injected = null, onClearInjected }: { injected?: InjectedSpell | null; onClearInjected?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const fxLayer = useRef<HTMLDivElement>(null);
  const view = useRef<StudioView | null>(null);
  const studio = useRef<StudioSim | null>(null);

  const [setup, setSetup] = useState<StudioSetup>({ seed: 1337, classId: 'mage', dummies: 6, dummyType: 'chaser', layout: 'pack', distance: 260 });
  const [draft, setDraft] = useState<StudioSkill>(() => firstSkill('mage'));
  const [castMode, setCastMode] = useState<CastMode>('hold');
  const [interval, setIntervalSeconds] = useState(1);
  const [infiniteForce, setInfiniteForce] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [timeScale, setTimeScale] = useState(1);
  const [summary, setSummary] = useState<MetricsSummary>(EMPTY_SUMMARY);
  const [samples, setSamples] = useState<readonly TickSample[]>([]);
  const [force, setForce] = useState({ now: 0, max: 0 });
  const [exported, setExported] = useState('');

  const compiled = useMemo(() => injected?.compiled ?? compileSkill(draft), [draft, injected]);
  // The view reads the latest draft on reset without re-running the setup effect.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (!host.current || !fxLayer.current) return;
    const s = new StudioSim(setup, draftRef.current);
    studio.current = s;
    if (view.current) view.current.swap(s);
    else view.current = new StudioView(s, host.current, fxLayer.current);
  }, [setup]);

  useEffect(
    () => () => {
      view.current?.dispose();
      view.current = null;
    },
    [],
  );

  useEffect(() => {
    if (injected) studio.current?.setCompiled(injected.compiled);
    else studio.current?.setSkill(draft);
  }, [draft, injected, setup]);

  useEffect(() => {
    const s = studio.current;
    if (s) s.cast = { mode: castMode, intervalSeconds: interval, infiniteForce };
  }, [castMode, interval, infiniteForce, setup]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.playing = playing;
    v.timeScale = timeScale;
  }, [playing, timeScale, setup]);

  // Polling at 5 Hz keeps React out of the 20 Hz tick loop.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const s = studio.current;
      if (!s) return;
      setSummary(s.metrics.summary());
      setSamples([...s.metrics.timeline]);
      setForce({ now: s.heat, max: s.heatMax });
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  const edit = (patch: Partial<StudioSkill>) => setDraft((d) => ({ ...d, ...patch }));
  const classList = classStarterSigils(setup.classId);

  const exportSkill = () => {
    const def: StudioSkill = { ...draft, id: draft.id || skillIdFromName(draft.name), classId: setup.classId };
    const text = formatSkill(def);
    setExported(text);
    navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  return (
    <div className="studio">
      <aside className="dev-side studio-left">
        <h3>Class</h3>
        <div className="chip-row">
          {CLASS_IDS.map((c) => (
            <button
              key={c}
              type="button"
              className={c === setup.classId ? 'on' : ''}
              onClick={() => {
                setDraft(firstSkill(c));
                setSetup((s) => ({ ...s, classId: c }));
              }}
            >
              {CLASSES[c].name}
            </button>
          ))}
        </div>
        <h3>Start from</h3>
        <div className="chip-row">
          {classList.map((sk) => (
            <button key={sk.id} type="button" className={sk.id === draft.id ? 'on' : ''} onClick={() => setDraft(studioSkillOf(sk))}>
              {sk.name}
            </button>
          ))}
          <button type="button" onClick={() => setDraft(blankSkill(setup.classId))}>
            Blank
          </button>
        </div>

        <h3>Identity</h3>
        <div className="studio-fields">
          <label>
            Name
            <input value={draft.name} onChange={(e) => edit({ name: e.target.value })} />
          </label>
          <label>
            Id
            <input value={draft.id} onChange={(e) => edit({ id: e.target.value })} />
          </label>
          <label className="span">
            Description
            <input value={draft.description} onChange={(e) => edit({ description: e.target.value })} />
          </label>
        </div>

        <h3>Runes</h3>
        <textarea className="studio-export" rows={3} spellCheck={false} value={draft.text} onChange={(e) => edit({ text: e.target.value })} aria-label="Runes, in the Spell Lab's text form" />
        {KIND_ORDER.map((kind) => {
          const runes = CASTABLE_RUNES.filter((r) => runeKind(r) === kind);
          if (runes.length === 0) return null;
          return (
            <div key={kind} className="studio-palette">
              <small>{kind}</small>
              <div className="chip-row">
                {runes.map((r) => (
                  <button key={r} type="button" style={{ borderColor: cssColor(runeColor(r)) }} onClick={() => edit({ text: `${draft.text.trim()} ${r}`.trim() })}>
                    {runeName(r)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <p className="muted small">Affixes go in brackets, as in the Spell Lab: orb[onhit, -15% speed] fire split(3) bolt.</p>
        {injected && (
          <div className="studio-injected">
            <p>
              Casting the Spell Lab spell <code>{injected.label}</code> instead of the draft above.
            </p>
            {injected.notes.map((n) => (
              <p key={n} className="muted small">
                {n}
              </p>
            ))}
            <button type="button" onClick={onClearInjected}>
              Back to the draft skill
            </button>
          </div>
        )}
        <CompileBox result={compiled} />
      </aside>

      <section className="studio-stage">
        <div className="studio-toolbar">
          <button type="button" className={playing ? 'on' : ''} onClick={() => setPlaying(!playing)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" disabled={playing} onClick={() => view.current?.stepOnce()}>
            Step tick
          </button>
          <button type="button" onClick={() => setSetup((s) => ({ ...s }))}>
            Reset
          </button>
          <span className="sep" />
          {TIME_SCALES.map((t) => (
            <button key={t} type="button" className={t === timeScale ? 'on' : ''} onClick={() => setTimeScale(t)}>
              x{t}
            </button>
          ))}
          <span className="sep" />
          <label>
            Seed
            <input type="number" value={setup.seed} onChange={(e) => setSetup((s) => ({ ...s, seed: Math.floor(Number(e.target.value) || 0) }))} />
          </label>
        </div>
        <div className="studio-canvas">
          <div
            className="canvas-host"
            ref={host}
            onPointerDown={(e) => {
              const p = view.current?.groundAt(e.clientX, e.clientY);
              if (p) studio.current?.castAt(p.x, p.y);
            }}
          />
          <div className="fx-layer" ref={fxLayer} aria-hidden="true" />
          <div className="studio-force">
            Force {Math.round(force.now)} / {Math.round(force.max)}
            <div>
              <div style={{ width: `${force.max > 0 ? Math.min(100, (force.now / force.max) * 100) : 0}%` }} />
            </div>
          </div>
        </div>
      </section>

      <aside className="dev-side studio-right">
        <h3>Dummies</h3>
        <div className="studio-fields">
          <label>
            Count
            <input type="number" min={1} max={40} value={setup.dummies} onChange={(e) => setSetup((s) => ({ ...s, dummies: Math.max(1, Math.min(40, Math.floor(Number(e.target.value) || 1))) }))} />
          </label>
          <label>
            Distance
            <input type="number" min={60} max={900} step={20} value={setup.distance} onChange={(e) => setSetup((s) => ({ ...s, distance: Math.max(60, Math.min(900, Number(e.target.value) || 60)) }))} />
          </label>
          <label>
            Type
            <select value={setup.dummyType} onChange={(e) => setSetup((s) => ({ ...s, dummyType: ENEMY_TYPE_IDS.find((t) => t === e.target.value) ?? s.dummyType }))}>
              {ENEMY_TYPE_IDS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="chip-row">
          {LAYOUTS.map((l) => (
            <button key={l} type="button" className={l === setup.layout ? 'on' : ''} onClick={() => setSetup((s) => ({ ...s, layout: l }))}>
              {l}
            </button>
          ))}
        </div>

        <h3>Casting</h3>
        <div className="chip-row">
          {CAST_MODES.map((m) => (
            <button key={m.id} type="button" className={m.id === castMode ? 'on' : ''} onClick={() => setCastMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="studio-fields">
          {castMode === 'interval' && (
            <label>
              Every (s)
              <input type="number" min={0.05} step={0.05} value={interval} onChange={(e) => setIntervalSeconds(Math.max(0.05, Number(e.target.value) || 1))} />
            </label>
          )}
          <label className="check span">
            <input type="checkbox" checked={infiniteForce} onChange={(e) => setInfiniteForce(e.target.checked)} /> Infinite Force (ignore the heat budget)
          </label>
        </div>
        {castMode === 'manual' && <p className="muted">Click the ground to cast at that spot.</p>}

        <h3>Metrics</h3>
        <dl className="studio-metrics">
          <dt>DPS (5 s)</dt>
          <dd>{summary.dpsWindow.toFixed(1)}</dd>
          <dt>DPS (run)</dt>
          <dd>{summary.dpsRun.toFixed(1)}</dd>
          <dt>Total damage</dt>
          <dd>{Math.round(summary.damage)}</dd>
          <dt>Casts</dt>
          <dd>
            {summary.casts}
            {summary.fizzles > 0 ? ` (${summary.fizzles} fizzled)` : ''}
          </dd>
          <dt>Hits per cast</dt>
          <dd>{summary.hitsPerCast.toFixed(2)}</dd>
          <dt>Force per second</dt>
          <dd>{summary.heatPerSecond.toFixed(1)}</dd>
          <dt>Peak live entities</dt>
          <dd>{summary.peakLive}</dd>
          <dt>Run time</dt>
          <dd>{summary.seconds.toFixed(1)} s</dd>
        </dl>
        <h3>Timeline</h3>
        <Timeline samples={samples} />
        <p className="studio-legend">
          <span className="c-cast">cast</span> <span className="c-hit">hits</span> <span className="c-explode">explode</span> <span className="c-fizzle">fizzle</span> <span className="c-live">live entities</span>
        </p>

        <h3>Export</h3>
        <button type="button" className="wide" onClick={exportSkill}>
          Copy as starterSigils.ts entry
        </button>
        {exported && <textarea className="studio-export" readOnly value={exported} rows={exported.split('\n').length} onFocus={(e) => e.target.select()} />}
      </aside>
    </div>
  );
}
