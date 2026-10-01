import { create } from 'zustand';
import { isVfxQuality, type VfxQuality } from '../render/vfx/quality.js';
import { ZOOM_SCALE_RANGE } from '../game/zoom.js';

/**
 * Player preferences: key bindings and display options. Stored per browser in localStorage, since
 * they belong to the machine and keyboard rather than the account.
 */

export const ACTIONS = [
  'moveUp',
  'moveDown',
  'moveLeft',
  'moveRight',
  'skill1',
  'skill2',
  'skill3',
  'skill4',
  'inventory',
  'character',
  'stance',
  'ready',
  'minimap',
  'showLoot',
  'sigilEditor',
  'record',
] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  moveUp: 'Move up',
  moveDown: 'Move down',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  skill1: 'Skill 1',
  skill2: 'Skill 2',
  skill3: 'Skill 3',
  skill4: 'Skill 4',
  inventory: 'Inventory',
  character: 'Character sheet',
  stance: 'Minion stance',
  ready: 'Ready check',
  minimap: 'Minimap',
  showLoot: 'Show all loot (hold)',
  sigilEditor: 'Sigil editor (forge)',
  record: 'Record replay',
};

export type Bindings = Record<Action, string>;

export const DEFAULT_BINDINGS: Bindings = {
  moveUp: 'KeyW',
  moveDown: 'KeyS',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  skill1: 'Digit1',
  skill2: 'Digit2',
  skill3: 'Digit3',
  skill4: 'Digit4',
  inventory: 'KeyI',
  character: 'KeyC',
  stance: 'KeyT',
  ready: 'KeyR',
  minimap: 'Tab',
  showLoot: 'AltLeft',
  sigilEditor: 'KeyK',
  record: 'F8',
};

/** Escape and the dev keys are fixed, so a bad binding can never lock you out of the menu. */
export const RESERVED_KEYS = new Set(['Escape', 'F1', 'F2', 'F3']);

/** Keyboard: WASD moves, the mouse aims. Click: D2 style, click the ground to walk and a monster to attack. */
export type ControlScheme = 'keyboard' | 'click';

export interface Options {
  controls: ControlScheme;
  damageNumbers: boolean;
  screenShake: boolean;
  /** Labels on every drop without holding the show-loot key. */
  alwaysShowLoot: boolean;
  uiScale: number;
  /** The scroll wheel cycles the right mouse skill (Shift+wheel the left). */
  wheelCyclesSkill: boolean;
  /** Interface click and hover sounds, 0 (off) to 1. */
  uiVolume: number;
  /** Spell effects: Low keeps plain shapes and few particles for slow machines. */
  vfxQuality: VfxQuality;
  /** Rare and relic drops, and relic sales, wait for a yes. Off by default, so selling and clearing the bag stay one click; on is the safety net. */
  confirmValuable: boolean;
  /** The player's camera zoom as a factor on the admin's default for the area; 1 is the default. */
  zoomScale: number;
}

export const DEFAULT_OPTIONS: Options = { controls: 'keyboard', damageNumbers: true, screenShake: true, alwaysShowLoot: false, uiScale: 1, wheelCyclesSkill: true, uiVolume: 0.5, vfxQuality: 'high', confirmValuable: false, zoomScale: 1 };
export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.4] as const;

interface SettingsState {
  bindings: Bindings;
  options: Options;
  bind: (action: Action, code: string) => void;
  setOption: <K extends keyof Options>(key: K, value: Options[K]) => void;
  reset: () => void;
}

const STORAGE_KEY = 'rune.settings';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Stored settings may be from an older build; anything unknown or malformed falls back to the default. */
export function parseSettings(raw: string | null): { bindings: Bindings; options: Options } {
  const bindings = { ...DEFAULT_BINDINGS };
  const options = { ...DEFAULT_OPTIONS };
  if (!raw) return { bindings, options };
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v)) return { bindings, options };
    if (isRecord(v.bindings)) {
      for (const a of ACTIONS) {
        const code = v.bindings[a];
        if (typeof code === 'string' && code.length > 0 && code.length < 32 && !RESERVED_KEYS.has(code)) bindings[a] = code;
      }
    }
    if (isRecord(v.options)) {
      const o = v.options;
      if (o.controls === 'keyboard' || o.controls === 'click') options.controls = o.controls;
      if (typeof o.damageNumbers === 'boolean') options.damageNumbers = o.damageNumbers;
      if (typeof o.screenShake === 'boolean') options.screenShake = o.screenShake;
      if (typeof o.alwaysShowLoot === 'boolean') options.alwaysShowLoot = o.alwaysShowLoot;
      const scale = UI_SCALES.find((s) => s === o.uiScale);
      if (scale !== undefined) options.uiScale = scale;
      if (typeof o.wheelCyclesSkill === 'boolean') options.wheelCyclesSkill = o.wheelCyclesSkill;
      if (typeof o.uiVolume === 'number' && o.uiVolume >= 0 && o.uiVolume <= 1) options.uiVolume = o.uiVolume;
      if (isVfxQuality(o.vfxQuality)) options.vfxQuality = o.vfxQuality;
      if (typeof o.confirmValuable === 'boolean') options.confirmValuable = o.confirmValuable;
      // The admin's limits clamp it at use; this only keeps junk out of storage.
      if (typeof o.zoomScale === 'number' && Number.isFinite(o.zoomScale) && o.zoomScale >= ZOOM_SCALE_RANGE.min && o.zoomScale <= ZOOM_SCALE_RANGE.max) options.zoomScale = o.zoomScale;
    }
  } catch {
    // Corrupt storage: defaults.
  }
  return { bindings, options };
}

function load(): { bindings: Bindings; options: Options } {
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseSettings(null);
  }
}

function save(s: { bindings: Bindings; options: Options }): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ bindings: s.bindings, options: s.options }));
  } catch {
    // Blocked storage: settings last for this session only.
  }
}

/** Binding a key already in use swaps the two actions, so every action always keeps a key. */
export function rebind(bindings: Bindings, action: Action, code: string): Bindings {
  const next = { ...bindings };
  const clash = ACTIONS.find((a) => a !== action && next[a] === code);
  if (clash) next[clash] = next[action];
  next[action] = code;
  return next;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  bind: (action, code) => {
    if (RESERVED_KEYS.has(code)) return;
    set({ bindings: rebind(get().bindings, action, code) });
    save(get());
  },
  setOption: (key, value) => {
    set({ options: { ...get().options, [key]: value } });
    save(get());
  },
  reset: () => {
    set({ bindings: { ...DEFAULT_BINDINGS }, options: { ...DEFAULT_OPTIONS } });
    save(get());
  },
}));

/** Which action a key code triggers, if any. */
export function actionFor(code: string): Action | null {
  const b = useSettings.getState().bindings;
  // Either Alt shows loot, so a left-handed binding of AltRight is not needed.
  if (b.showLoot === 'AltLeft' && code === 'AltRight') return 'showLoot';
  return ACTIONS.find((a) => b[a] === code) ?? null;
}

/** "KeyW" to "W", "Digit1" to "1", for display. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
  if (code === 'Space') return 'Space';
  return code;
}

// Game state lives in module scope. A hot update would split it between an old and a new copy
// (the symptom: panels that stop opening), so edits to this module reload the page instead.
import.meta.hot?.accept(() => location.reload());
