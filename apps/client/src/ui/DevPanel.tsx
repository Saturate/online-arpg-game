import { ENEMY_TYPE_IDS, ITEM_TIERS, type DevCommand, type EnemyTypeId, type GearCategory, type ItemTier } from '@rune/shared';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { sendCommand, useUi } from './store.js';

/** Last ground point under the mouse while it was over the game canvas, kept by the game loop. */
export const useDevCursor = create<{ x: number; y: number }>(() => ({ x: 0, y: 0 }));

const GEAR_CATEGORIES: GearCategory[] = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'belt', 'amulet', 'ring'];
const TIME_SCALES = [0.25, 0.5, 1, 2, 4];

function dev(cmd: DevCommand): void {
  sendCommand({ t: 'dev', cmd });
}

/** Encounter sandbox (F3). Spawning uses the last spot the mouse hovered on the ground. */
export function DevPanel() {
  const open = useUi((s) => s.devOpen);
  const portals = useUi((s) => s.roomPortals);
  const allowed = useUi((s) => s.devTools);
  const [enemy, setEnemy] = useState<EnemyTypeId>('chaser');
  const [count, setCount] = useState(5);
  const [level, setLevel] = useState(1);
  const [rare, setRare] = useState(false);
  const [god, setGod] = useState(false);
  const [scale, setScale] = useState(1);
  const [tier, setTier] = useState<ItemTier>('rare');
  const [category, setCategory] = useState<GearCategory | 'any'>('any');
  const spawnNow = () => {
    const c = useDevCursor.getState();
    dev({ c: 'spawn', enemy, count, rare, level, x: c.x, y: c.y });
  };
  const spawnRef = useRef(spawnNow);
  spawnRef.current = spawnNow;
  useEffect(() => {
    if (!open || !allowed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyN' || e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      spawnRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, allowed]);
  if (!open) return null;
  if (!allowed) {
    return (
      <section className="panel dev-panel">
        <header>
          <h2>Encounter sandbox</h2>
        </header>
        <p className="muted">Dev tools are for admins. Add your username to ADMIN_USERS on the server.</p>
      </section>
    );
  }
  return (
    <section className="panel dev-panel" aria-label="Encounter sandbox">
      <header>
        <h2>Encounter sandbox</h2>
        <button type="button" className="close" onClick={() => useUi.setState({ devOpen: false })} aria-label="Close sandbox">
          x
        </button>
      </header>
      <h3>Spawn</h3>
      <div className="dev-grid">
        <label>
          Monster
          <select value={enemy} onChange={(e) => setEnemy(ENEMY_TYPE_IDS.find((t) => t === e.target.value) ?? 'chaser')}>
            {ENEMY_TYPE_IDS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Count
          <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
        </label>
        <label>
          Level
          <input type="number" min={1} max={30} value={level} onChange={(e) => setLevel(Number(e.target.value) || 1)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={rare} onChange={(e) => setRare(e.target.checked)} /> Rare
        </label>
      </div>
      <div className="actions">
        <button type="button" onClick={spawnNow}>
          Spawn at cursor <kbd>N</kbd>
        </button>
        <button type="button" onClick={() => dev({ c: 'killAll' })}>
          Kill all
        </button>
        <button type="button" onClick={() => dev({ c: 'clearLoot' })}>
          Clear loot
        </button>
      </div>
      <h3>Player</h3>
      <div className="actions">
        <button
          type="button"
          className={god ? 'on' : ''}
          onClick={() => {
            dev({ c: 'god', on: !god });
            setGod(!god);
          }}
        >
          God mode {god ? 'on' : 'off'}
        </button>
        <button type="button" onClick={() => dev({ c: 'heal' })}>
          Heal and cool
        </button>
        <button
          type="button"
          onClick={() => {
            const c = useDevCursor.getState();
            dev({ c: 'teleport', x: c.x, y: c.y });
          }}
        >
          Teleport to cursor
        </button>
      </div>
      {portals.length > 0 && (
        <>
          <h3>Portals</h3>
          <div className="actions">
            {portals.map((p) => (
              <button key={`${p.x}:${p.y}`} type="button" onClick={() => dev({ c: 'teleport', x: p.x, y: p.y })}>
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}
      <h3>Time</h3>
      <div className="actions">
        {TIME_SCALES.map((t) => (
          <button
            key={t}
            type="button"
            className={scale === t ? 'on' : ''}
            onClick={() => {
              dev({ c: 'timeScale', scale: t });
              setScale(t);
            }}
          >
            x{t}
          </button>
        ))}
      </div>
      <h3>Give item</h3>
      <div className="dev-grid">
        <label>
          Tier
          <select value={tier} onChange={(e) => setTier(ITEM_TIERS.find((t) => t === e.target.value) ?? 'rare')}>
            {ITEM_TIERS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Gear slot
          <select value={category} onChange={(e) => setCategory(GEAR_CATEGORIES.find((c) => c === e.target.value) ?? 'any')}>
            <option value="any">any</option>
            {GEAR_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="actions">
        {(['gear', 'sigil', 'vessel'] as const).map((item) => (
          <button key={item} type="button" onClick={() => dev({ c: 'give', item, tier, level, category: category === 'any' ? null : category })}>
            {item}
          </button>
        ))}
      </div>
    </section>
  );
}
