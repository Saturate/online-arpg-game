import { useEffect, useState } from 'react';
import { ACTION_LABELS, ACTIONS, keyLabel, RESERVED_KEYS, UI_SCALES, useSettings, type Action, type ControlScheme, type Options } from './settings.js';
import { GamePanel, usePanelLayout } from './GamePanel.js';
import { useUi } from './store.js';
import { QUALITY_LABELS, VFX_QUALITIES } from '../render/vfx/quality.js';

const SCHEMES: readonly { id: ControlScheme; label: string; hint: string }[] = [
  { id: 'keyboard', label: 'WASD + mouse', hint: 'Move with the keys, aim and attack with the mouse.' },
  { id: 'click', label: 'Click to move', hint: 'Diablo style: click the ground to walk, a monster to attack. Shift attacks in place.' },
];

type BoolOption = { [K in keyof Options]: Options[K] extends boolean ? K : never }[keyof Options];

const TOGGLES: readonly { key: BoolOption; label: string }[] = [
  { key: 'wheelCyclesSkill', label: 'Scroll wheel picks the mouse skills (Shift for the left one)' },
  { key: 'damageNumbers', label: 'Damage numbers' },
  { key: 'screenShake', label: 'Screen shake' },
  { key: 'alwaysShowLoot', label: 'Always show loot labels' },
];

/** Key bindings and display options. Click a binding, then press the new key; Escape cancels. */
export function SettingsPanel() {
  const open = useUi((s) => s.settingsOpen);
  const { bindings, options, bind, setOption, reset } = useSettings();
  const [waiting, setWaiting] = useState<Action | null>(null);
  const unlocked = usePanelLayout((s) => s.unlocked);
  const moved = usePanelLayout((s) => Object.keys(s.positions).length > 0);

  useEffect(() => {
    if (!waiting) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      // Capture phase, so the game's own handler never sees the key being bound.
      e.stopImmediatePropagation();
      if (e.code !== 'Escape' && !RESERVED_KEYS.has(e.code)) bind(waiting, e.code);
      setWaiting(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [waiting, bind]);

  if (!open) return null;
  return (
    <div className="menu-backdrop" role="dialog" aria-label="Settings">
      <GamePanel id="settings" className="settings" title="Settings" onClose={() => useUi.setState({ settingsOpen: false })} closeLabel="Close settings">
        <div className="settings-cols">
          <div>
            <h3>Keys</h3>
            <ul className="bindings">
              {ACTIONS.map((a) => (
                <li key={a}>
                  <span>{ACTION_LABELS[a]}</span>
                  <button type="button" className={waiting === a ? 'waiting' : ''} onClick={() => setWaiting(waiting === a ? null : a)}>
                    {waiting === a ? 'Press a key' : keyLabel(bindings[a])}
                  </button>
                </li>
              ))}
            </ul>
            <p className="muted small">Esc, F1 (debug), F2 (town editor) and F3 (sandbox) are fixed. Binding a key in use swaps the two.</p>
          </div>
          <div>
            <h3>Controls</h3>
            <div className="scheme-row" role="radiogroup" aria-label="Control scheme">
              {SCHEMES.map((c) => (
                <button key={c.id} type="button" role="radio" aria-checked={options.controls === c.id} className={options.controls === c.id ? 'on' : ''} onClick={() => setOption('controls', c.id)}>
                  <strong>{c.label}</strong>
                  <span>{c.hint}</span>
                </button>
              ))}
            </div>
            <p className="muted small">A gamepad works with either: left stick moves, right stick aims, RT attacks, A X Y B cast skills 1 to 4, Start opens the menu.</p>
            <h3>Display</h3>
            <ul className="toggles">
              {TOGGLES.map((t) => (
                <li key={t.key}>
                  <label>
                    <input type="checkbox" checked={options[t.key]} onChange={(e) => setOption(t.key, e.target.checked)} /> {t.label}
                  </label>
                </li>
              ))}
            </ul>
            <h3>Items</h3>
            <ul className="toggles">
              <li>
                <label>
                  <input type="checkbox" checked={options.confirmValuable} onChange={(e) => setOption('confirmValuable', e.target.checked)} /> Ask before dropping rares and relics, or selling relics
                </label>
              </li>
            </ul>
            <h3>Spell effects</h3>
            <div className="scale-row" role="radiogroup" aria-label="Spell effect quality">
              {VFX_QUALITIES.map((q) => (
                <button key={q} type="button" role="radio" aria-checked={options.vfxQuality === q} className={options.vfxQuality === q ? 'on' : ''} onClick={() => setOption('vfxQuality', q)}>
                  {QUALITY_LABELS[q]}
                </button>
              ))}
            </div>
            <p className="muted small">Low keeps plain spell shapes and few particles, for slower machines.</p>
            <h3>Interface size</h3>
            <div className="scale-row">
              {UI_SCALES.map((s) => (
                <button key={s} type="button" className={options.uiScale === s ? 'on' : ''} onClick={() => setOption('uiScale', s)}>
                  {Math.round(s * 100)}%
                </button>
              ))}
            </div>
            <h3>Camera zoom</h3>
            <p className="muted small">Ctrl+scroll (or pinch) zooms{options.wheelCyclesSkill ? '' : '; with the wheel not picking skills, plain scroll zooms too'}. The server sets how far.</p>
            <button type="button" onClick={() => setOption('zoomScale', 1)} disabled={options.zoomScale === 1}>
              Reset zoom
            </button>
            <h3>Panels</h3>
            <ul className="toggles">
              <li>
                <label>
                  <input type="checkbox" checked={unlocked} onChange={(e) => usePanelLayout.getState().setUnlocked(e.target.checked)} /> Unlock panels: drag windows by their title bar
                </label>
              </li>
            </ul>
            <button type="button" onClick={() => usePanelLayout.getState().resetPositions()} disabled={!moved}>
              Reset panel positions
            </button>
            <h3>Sound</h3>
            <label className="volume-row">
              <span>Interface sounds</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(options.uiVolume * 100)}
                onChange={(e) => setOption('uiVolume', Number(e.target.value) / 100)}
                aria-label="Interface sound volume"
              />
              <b>{options.uiVolume > 0 ? `${Math.round(options.uiVolume * 100)}%` : 'Off'}</b>
            </label>
            <button type="button" className="reset" onClick={reset}>
              Reset to defaults
            </button>
          </div>
        </div>
      </GamePanel>
    </div>
  );
}
