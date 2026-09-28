import { BUTTON, clampDir, SKILL_BUTTONS, type Vec2 } from '@rune/shared';
import type { GroundBasis } from '../render/scene.js';
import { actionFor, useSettings } from '../ui/settings.js';

const MOVES = [
  ['moveUp', 0, -1],
  ['moveDown', 0, 1],
  ['moveLeft', -1, 0],
  ['moveRight', 1, 0],
] as const;

const SKILLS = ['skill1', 'skill2', 'skill3', 'skill4'] as const;

export interface SampledInput {
  moveDir: Vec2;
  aimAngle: number;
  buttons: number;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** Tracks raw key and mouse state; the game loop samples it once per tick. */
export class InputState {
  private keys = new Set<string>();
  /** The show-loot key is held, or the player chose to always show labels. */
  get showLootDown(): boolean {
    if (useSettings.getState().options.alwaysShowLoot) return true;
    const code = useSettings.getState().bindings.showLoot;
    return this.keys.has(code) || (code === 'AltLeft' && this.keys.has('AltRight'));
  }
  private mouseDown = false;
  mouseX = 0;
  mouseY = 0;
  /** The mouse is over the game canvas rather than a UI panel. */
  overCanvas = false;
  private readonly abort = new AbortController();

  constructor(canvas: HTMLCanvasElement, onKey: (code: string) => void) {
    const opts = { signal: this.abort.signal };
    window.addEventListener(
      'keydown',
      (e) => {
        if (isTypingTarget(e.target)) return;
        // Bound keys belong to the game: Tab would move focus, Alt opens browser menus, and so on.
        if (e.code === 'F1' || e.code === 'F3' || actionFor(e.code) !== null) e.preventDefault();
        if (!e.repeat) onKey(e.code);
        this.keys.add(e.code);
      },
      opts,
    );
    window.addEventListener('keyup', (e) => this.keys.delete(e.code), opts);
    window.addEventListener(
      'blur',
      () => {
        this.keys.clear();
        this.mouseDown = false;
      },
      opts,
    );
    // Track the mouse over the whole window so aim keeps working while hovering UI panels.
    window.addEventListener(
      'mousemove',
      (e) => {
        const r = canvas.getBoundingClientRect();
        this.mouseX = e.clientX - r.left;
        this.mouseY = e.clientY - r.top;
      },
      opts,
    );
    canvas.addEventListener(
      'mousedown',
      (e) => {
        if (e.button === 0) this.mouseDown = true;
      },
      opts,
    );
    window.addEventListener(
      'mouseup',
      (e) => {
        if (e.button === 0) this.mouseDown = false;
      },
      opts,
    );
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    canvas.addEventListener('mouseenter', () => (this.overCanvas = true), opts);
    canvas.addEventListener('mouseleave', () => (this.overCanvas = false), opts);
  }

  /**
   * `aimPoint` is the ground point under the cursor and `origin` the own player, both in world
   * coordinates. Movement keys are relative to the screen, so they go through the camera basis.
   */
  sample(basis: GroundBasis, origin: Vec2, aimPoint: Vec2 | null, lastAim: number): SampledInput {
    let sx = 0;
    let sy = 0;
    const bindings = useSettings.getState().bindings;
    for (const [action, dx, dy] of MOVES) {
      if (this.keys.has(bindings[action])) {
        sx += dx;
        sy += dy;
      }
    }
    // Screen y grows downward, so "up" on the keyboard is +forward on the ground.
    const wx = basis.right.x * sx - basis.up.x * sy;
    const wy = basis.right.y * sx - basis.up.y * sy;
    const len = Math.hypot(wx, wy);
    const moveDir = len > 0 ? clampDir(wx / len, wy / len) : { x: 0, y: 0 };

    let buttons = this.mouseDown ? BUTTON.primary : 0;
    SKILLS.forEach((action, i) => {
      const bit = SKILL_BUTTONS[i];
      if (bit !== undefined && this.keys.has(bindings[action])) buttons |= bit;
    });

    const aimAngle = aimPoint ? Math.atan2(aimPoint.y - origin.y, aimPoint.x - origin.x) : lastAim;
    return { moveDir, aimAngle, buttons };
  }

  dispose(): void {
    this.abort.abort();
  }
}
