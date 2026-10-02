import { AFFIXES, affixText, CLASS_IDS, CLASSES, DEFAULT_DROP_TUNING, DROP_TIER_WEIGHTS, BOSS_DROPS, FORGE, ITEM_TIERS, LOOT, type ClassId, type Item } from '@rune/shared';
import { useEffect, useRef, useState } from 'react';
import { cssColor, TIER_COLORS } from '../render/config.js';
import { ItemDetails } from '../ui/parts.js';
import { LootAccumulator, type LootReport, type LootSetup } from './loot/lootStats.js';

const DEFAULT_ROLLED = DEFAULT_DROP_TUNING.rolledRuneShare ?? FORGE.rolledRuneShare;
const KILL_PRESETS = [1_000, 10_000, 100_000] as const;
/** Kills per chunk: small enough that a boss run (4 items per kill) still yields to the browser every frame or two. */
const CHUNK = 2_000;

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';
}

function fmt(n: number, decimals = 0): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function Bars({ rows, total }: { rows: { label: string; count: number; color?: string }[]; total: number }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="loot-bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="loot-bar-label" style={r.color ? { color: r.color } : undefined}>
            {r.label}
          </span>
          <span className="loot-bar">
            <span style={{ width: `${(r.count / max) * 100}%`, background: r.color ?? 'var(--gold)' }} />
          </span>
          <span className="loot-bar-num">
            {fmt(r.count)} <small>{pct(r.count, total)}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

function NumberField({ label, value, onChange, min, max, step = 1 }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return (
    <label>
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
      />
    </label>
  );
}

export function LootTab() {
  const [seed, setSeed] = useState(1337);
  const [level, setLevel] = useState(5);
  const [rare, setRare] = useState(false);
  const [boss, setBoss] = useState(false);
  const [kills, setKills] = useState<number>(10_000);
  const [classId, setClassId] = useState<ClassId | null>(null);
  const [dropChance, setDropChance] = useState(DEFAULT_DROP_TUNING.normalDropChance);
  const [gearShare, setGearShare] = useState(DEFAULT_DROP_TUNING.gearShare);
  const [vesselShare, setVesselShare] = useState(DEFAULT_DROP_TUNING.vesselShare);
  const [rolledShare, setRolledShare] = useState(DEFAULT_ROLLED);
  const [report, setReport] = useState<LootReport | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [ms, setMs] = useState(0);
  const [sample, setSample] = useState<Item | null>(null);
  const runId = useRef(0);

  const run = () => {
    const id = ++runId.current;
    const setup: LootSetup = {
      seed,
      source: { level, rare: rare || boss, boss },
      kills,
      tuning: { normalDropChance: dropChance, gearShare, vesselShare: Math.min(vesselShare, 1 - gearShare), runeShare: DEFAULT_DROP_TUNING.runeShare, rolledRuneShare: rolledShare },
      classId,
    };
    const acc = new LootAccumulator(setup);
    const started = performance.now();
    setProgress(0);
    const chunk = () => {
      // A newer run supersedes this one; stop quietly.
      if (id !== runId.current) return;
      acc.step(CHUNK);
      setProgress(acc.progress);
      if (!acc.done) {
        setTimeout(chunk, 0);
        return;
      }
      const r = acc.report();
      setReport(r);
      setSample(r.samples[0] ?? null);
      setMs(performance.now() - started);
      setProgress(null);
    };
    chunk();
  };

  // Run once on open so the tab never starts empty.
  useEffect(() => {
    run();
    return () => {
      runId.current++;
    };
  }, []);

  const resetTuning = () => {
    setDropChance(DEFAULT_DROP_TUNING.normalDropChance);
    setGearShare(DEFAULT_DROP_TUNING.gearShare);
    setVesselShare(DEFAULT_DROP_TUNING.vesselShare);
    setRolledShare(DEFAULT_ROLLED);
  };
  const tuned =
    dropChance !== DEFAULT_DROP_TUNING.normalDropChance ||
    gearShare !== DEFAULT_DROP_TUNING.gearShare ||
    vesselShare !== DEFAULT_DROP_TUNING.vesselShare ||
    rolledShare !== DEFAULT_ROLLED;
  const weights = boss ? DROP_TIER_WEIGHTS.boss : rare ? DROP_TIER_WEIGHTS.rare : DROP_TIER_WEIGHTS.normal;
  const maxAffixTier = report ? Math.max(0, ...report.affixes.map((a) => a.tiers.length)) : 0;

  return (
    <div className="studio loot">
      <aside className="dev-side">
        <h3>Source</h3>
        <div className="studio-fields">
          <NumberField label="Seed" value={seed} onChange={setSeed} min={0} max={2 ** 31} />
          <NumberField label="Monster level" value={level} onChange={setLevel} min={1} max={30} />
          <label className="check">
            <input type="checkbox" checked={rare || boss} disabled={boss} onChange={(e) => setRare(e.target.checked)} /> Rare
          </label>
          <label className="check">
            <input type="checkbox" checked={boss} onChange={(e) => setBoss(e.target.checked)} /> Boss
          </label>
        </div>
        <h3>Kills</h3>
        <div className="chip-row">
          {KILL_PRESETS.map((k) => (
            <button key={k} type="button" className={kills === k ? 'on' : ''} onClick={() => setKills(k)}>
              {fmt(k)}
            </button>
          ))}
        </div>
        <h3>Weapon class filter</h3>
        <div className="chip-row">
          <button type="button" className={classId === null ? 'on' : ''} onClick={() => setClassId(null)}>
            None
          </button>
          {CLASS_IDS.map((c) => (
            <button key={c} type="button" className={classId === c ? 'on' : ''} onClick={() => setClassId(c)}>
              {CLASSES[c].name}
            </button>
          ))}
        </div>
        <h3>Tuning {tuned && <span className="loot-tuned">overridden</span>}</h3>
        <div className="studio-fields">
          <NumberField label="Normal drop chance" value={dropChance} onChange={setDropChance} min={0} max={1} step={0.01} />
          <NumberField label="Gear share" value={gearShare} onChange={setGearShare} min={0} max={1} step={0.05} />
          <NumberField label="Vessel share" value={vesselShare} onChange={setVesselShare} min={0} max={1} step={0.05} />
          <label>
            Sigil share
            <input type="number" value={Math.max(0, 1 - gearShare - vesselShare).toFixed(2)} readOnly />
          </label>
          <NumberField label="Rolled share of runes" value={rolledShare} onChange={setRolledShare} min={0} max={1} step={0.05} />
        </div>
        {tuned && (
          <button type="button" className="wide" onClick={resetTuning}>
            Reset to live config
          </button>
        )}
        <p className="muted small">
          Live config: drop chance {LOOT.normalDropChance}, runes {LOOT.runeShareOfDrops} of drops ({FORGE.rolledRuneShare} of them rolled), rare drops {LOOT.rareDropCount.min} to {LOOT.rareDropCount.max}, boss {BOSS_DROPS}, corrupt {LOOT.corruptChance}.
          Tier weights here: {ITEM_TIERS.map((t) => `${t} ${weights[t]}`).join(', ')}.
        </p>
        <button type="button" className="wide on" onClick={run}>
          {progress === null ? 'Run simulation' : `Running ${Math.round(progress * 100)}%`}
        </button>
        <p className="muted small">Uses the game's own drop roll (rollDrops, verified against the simulation by a test). The same seed always gives the same results.</p>
      </aside>

      <section className="loot-results">
        {progress !== null && (
          <div className="loot-progress">
            <div style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        {report && (
          <>
            <dl className="studio-metrics loot-summary">
              <dt>Kills</dt>
              <dd>{fmt(report.kills)}</dd>
              <dt>Items dropped</dt>
              <dd>{fmt(report.drops)}</dd>
              <dt>Items per kill</dt>
              <dd>{fmt(report.drops / Math.max(1, report.kills), 3)}</dd>
              <dt>Corrupted sigils</dt>
              <dd>{fmt(report.corrupted)}</dd>
              {report.classWeapons && (
                <>
                  <dt>Weapons usable by {classId ? CLASSES[classId].name : ''}</dt>
                  <dd>
                    {fmt(report.classWeapons.usable)} of {fmt(report.classWeapons.total)} ({pct(report.classWeapons.usable, report.classWeapons.total)})
                  </dd>
                </>
              )}
              <dt>Run time</dt>
              <dd>{fmt(ms)} ms</dd>
            </dl>

            <div className="loot-grid">
              <div>
                <h3>Tier</h3>
                <Bars rows={ITEM_TIERS.map((t) => ({ label: t, count: report.tiers[t], color: cssColor(TIER_COLORS[t]) }))} total={report.drops} />
                <h3>Kind</h3>
                <Bars rows={(['gear', 'sigil', 'vessel', 'rune'] as const).map((k) => ({ label: k, count: report.kinds[k] }))} total={report.drops} />
                <h3>Affixes per item</h3>
                <Bars rows={report.affixCounts.map((c, i) => ({ label: `${i} affix${i === 1 ? '' : 'es'}`, count: c }))} total={report.drops} />
              </div>
              <div>
                <h3>Gear slot</h3>
                <Bars rows={Object.entries(report.slots).map(([slot, count]) => ({ label: slot, count: count ?? 0 }))} total={report.kinds.gear} />
                <h3>Base type</h3>
                <Bars rows={report.bases.map((b) => ({ label: b.name, count: b.count }))} total={report.kinds.gear} />
              </div>
            </div>

            <h3>Time to first</h3>
            <table className="loot-table">
              <thead>
                <tr>
                  <th>Milestone</th>
                  <th>First at kill</th>
                  <th>Seen</th>
                  <th>Kills per drop</th>
                </tr>
              </thead>
              <tbody>
                {report.firsts.map((f) => (
                  <tr key={f.label}>
                    <td>{f.label}</td>
                    <td>{f.firstKill === null ? 'never' : fmt(f.firstKill)}</td>
                    <td>{fmt(f.count)}</td>
                    <td>{f.killsPerDrop === null ? 'n/a' : fmt(f.killsPerDrop, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Affixes</h3>
            <table className="loot-table">
              <thead>
                <tr>
                  <th>Affix</th>
                  <th>Rolls</th>
                  {/* Columns run from the weakest tier to T1, the best, so affixes with fewer tiers line up at T1. */}
                  {Array.from({ length: maxAffixTier }, (_, i) => (
                    <th key={i}>T{maxAffixTier - i}</th>
                  ))}
                  <th>Min</th>
                  <th>Avg</th>
                  <th>Max</th>
                </tr>
              </thead>
              <tbody>
                {report.affixes.map((a) => (
                  <tr key={a.id}>
                    <td title={a.id}>{affixText(AFFIXES[a.id], '#', '#')}</td>
                    <td>{fmt(a.count)}</td>
                    {Array.from({ length: maxAffixTier }, (_, i) => {
                      const index = AFFIXES[a.id].tiers.length - (maxAffixTier - i);
                      return <td key={i}>{index >= 0 ? fmt(a.tiers[index] ?? 0) : ''}</td>;
                    })}
                    <td>{fmt(a.min, 2)}</td>
                    <td>{fmt(a.avg, 2)}</td>
                    <td>{fmt(a.max, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <aside className="dev-side studio-right">
        <h3>First {report?.samples.length ?? 0} drops</h3>
        <ul className="dev-list">
          {report?.samples.map((item) => (
            <li key={item.uid}>
              <button type="button" className={sample?.uid === item.uid ? 'on' : ''} style={{ color: cssColor(TIER_COLORS[item.tier]) }} onClick={() => setSample(item)}>
                {item.name} <span className="muted">{item.kind}</span>
              </button>
            </li>
          ))}
        </ul>
        {sample && (
          <div className="tooltip loot-sample">
            <ItemDetails item={sample} classId={classId ?? 'mage'} />
          </div>
        )}
      </aside>
    </div>
  );
}
