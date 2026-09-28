import { useEffect, useState } from 'react';
import { ACTION_LABELS, ACTIONS, keyLabel, RESERVED_KEYS, UI_SCALES, useSettings, type Action, type Options } from './settings.js';
import { useUi } from './store.js';

const TOGGLES: readonly { key: Exclude<keyof Options, 'uiScale'>; label: string }[] = [
  { key: 'damageNumbers', label: 'Damage numbers' },
  { key: 'screenShake', label: 'Screen shake' },
  { key: 'alwaysShowLoot', label: 'Always show loot labels' },
];

/** Key bindings and display options. Click a binding, then press the new key; Escape cancels. */
export function SettingsPanel() {
  const open = useUi((s) => s.settingsOpen);
  const { bindings, options, bind, setOption, reset } = useSettings();
  const [waiting, setWaiting] = useState<Action | null>(null);

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
      <section className="panel settings">
        <header>
          <h2>Settings</h2>
          <button type="button" className="close" onClick={() => useUi.setState({ settingsOpen: false })} aria-label="Close settings">
            x
          </button>
        </header>
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
            <h3>Interface size</h3>
            <div className="scale-row">
              {UI_SCALES.map((s) => (
                <button key={s} type="button" className={options.uiScale === s ? 'on' : ''} onClick={() => setOption('uiScale', s)}>
                  {Math.round(s * 100)}%
                </button>
              ))}
            </div>
            <button type="button" className="reset" onClick={reset}>
              Reset to defaults
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
