import { BUTTON, clampDir, SKILL_BUTTONS, type Vec2 } from '@rune/shared';
import type { GroundBasis } from '../render/scene.js';

const MOVE_KEYS: Record<string, { x: number; y: number }> = {
  KeyW: { x: 0, y: -1 },
  KeyS: { x: 0, y: 1 },
  KeyA: { x: -1, y: 0 },
  KeyD: { x: 1, y: 0 },
};

const SKILL_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4'] as const;

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
  get altDown(): boolean {
    return this.keys.has('AltLeft') || this.keys.has('AltRight');
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
        if (e.code === 'F1' || e.code === 'Tab' || e.code.startsWith('Alt')) e.preventDefault();
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
    for (const [code, dir] of Object.entries(MOVE_KEYS)) {
      if (this.keys.has(code)) {
        sx += dir.x;
        sy += dir.y;
      }
    }
    // Screen y grows downward, so "up" on the keyboard is +forward on the ground.
    const wx = basis.right.x * sx - basis.up.x * sy;
    const wy = basis.right.y * sx - basis.up.y * sy;
    const len = Math.hypot(wx, wy);
    const moveDir = len > 0 ? clampDir(wx / len, wy / len) : { x: 0, y: 0 };

    let buttons = this.mouseDown ? BUTTON.primary : 0;
    SKILL_KEYS.forEach((code, i) => {
      const bit = SKILL_BUTTONS[i];
      if (bit !== undefined && this.keys.has(code)) buttons |= bit;
    });

    const aimAngle = aimPoint ? Math.atan2(aimPoint.y - origin.y, aimPoint.x - origin.x) : lastAim;
    return { moveDir, aimAngle, buttons };
  }

  dispose(): void {
    this.abort.abort();
  }
}
